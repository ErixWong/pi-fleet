import { createHash, randomBytes } from 'node:crypto';
import { query, withTransaction } from '../db.js';
import type { AgentIdentity } from '../auth.js';
import { computeNextDue, nowString, toLocalString } from '../scheduler.js';
import { llmConfigured } from './llm.js';

/**
 * 编排体系（orchestration.md）：plan → stage → task 三层。
 * - 顺序闸门：当前 stage = seq 最小未完成；非当前 stage 任务置 blocked（显式状态）
 * - stage 完成 = 全部任务 ∈ {done, cancelled}（cancelled=跳过，回帖列跳过清单）；failed 卡 stage 由发起人处理
 * - 周期性归 plan（recurrence 非空 ⇒ 单 stage）：序列克隆（series_id + content hash 审核继承）
 * - plan 由人创建（Web/REST）；agent 不能创建；MCP 不新增工具
 * - plan 只归档不删除；独立 task（无 stage_id）行为不变
 */

export interface PlanCreateTask {
  title: string;
  instruction: string;
  deliverable_spec?: unknown;
  visibility?: 'private' | 'public';
  assignee?: string; // agent_id
}

export interface PlanCreateStage {
  name: string;
  tasks: PlanCreateTask[];
}

export interface PlanCreateOptions {
  name: string;
  recurrence?: string; // none | daily | weekly:<0-6> | hourly
  window_start?: string;
  window_end?: string;
  stages: PlanCreateStage[];
}

/** 平台生成任务 ID（market.createTask / plan 任务 / 周期克隆共用，格式 T-yymmdd-xxxxxxxx 是跨模块契约） */
export function nextTaskId(): string {
  return `T-${ymd()}-${randomBytes(4).toString('hex')}`;
}

/** plan ID（P-yymmdd-xxxxxxxx） */
function nextPlanId(): string {
  return `P-${ymd()}-${randomBytes(4).toString('hex')}`;
}

function ymd(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(now.getFullYear()).slice(2)}${p(now.getMonth() + 1)}${p(now.getDate())}`;
}

/** 发布门禁落点（§编排四）：LLM 配置 → pending_audit；否则 private+assignee → open，public → active */
export function resolvePublishStatus(llmOn: boolean, hasAssignee: boolean): 'pending_audit' | 'open' | 'active' {
  return llmOn ? 'pending_audit' : hasAssignee ? 'open' : 'active';
}

/** 任务定义字段 content hash（周期审核继承：title+instruction+deliverable_spec+visibility） */
export function taskContentHash(t: {
  title: string; instruction: string; deliverable_spec?: unknown; visibility?: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      title: t.title, instruction: t.instruction,
      deliverable_spec: t.deliverable_spec ?? null, visibility: t.visibility ?? 'private',
    }))
    .digest('hex');
}

// ─────────────────────────── 创建（人建） ───────────────────────────

/**
 * 创建 plan（Web/REST；agent 不能创建）。
 * - stages + tasks 一次性定义；任务落点：当前 stage（seq 最小）→ 过发布门禁；未来 stage → blocked
 * - recurrence 非空 ⇒ 恰好一个 stage（创建校验）
 * @param creatorAgentId 创建者 agent id（管理员创建传 null）
 */
export async function createPlan(
  creatorAgentId: number | null,
  opts: PlanCreateOptions,
): Promise<{ ok: boolean; plan_id?: string; error?: string }> {
  const name = (opts.name ?? '').trim();
  const recurrence = (opts.recurrence ?? 'none').trim() || 'none';
  const stages = opts.stages ?? [];
  if (!name) return { ok: false, error: '缺少计划名称' };
  if (stages.length === 0) return { ok: false, error: '至少需要一个 stage' };
  if (stages.some((s) => !s.name?.trim())) return { ok: false, error: 'stage 缺少名称' };
  if (recurrence !== 'none' && stages.length !== 1) {
    return { ok: false, error: '周期 plan 必须恰好一个 stage（§编排三）' };
  }
  if (recurrence !== 'none' && !['daily', 'hourly'].includes(recurrence) && !/^weekly:[0-6]$/.test(recurrence)) {
    return { ok: false, error: 'recurrence 须为 none / daily / weekly:<0-6> / hourly' };
  }

  const planId = nextPlanId();
  return withTransaction(async (conn) => {
    const llmOn = await llmConfigured();
    // 周期 plan：首实例 next_due_at = 窗口内随机时刻；窗口缺省 03:00-06:00 且落库
    // （克隆轮重算直接读库，缺省不落库会导致首实例与后续克隆窗口不一致）
    let nextDue: string | null = null;
    let windowStart: string | null = null;
    let windowEnd: string | null = null;
    if (recurrence !== 'none') {
      windowStart = (opts.window_start ?? '').trim() || '03:00';
      windowEnd = (opts.window_end ?? '').trim() || '06:00';
      nextDue = toLocalString(computeNextDue(recurrence, windowStart, windowEnd, new Date()));
    }
    const ins = await conn.query(
      `INSERT INTO plans (plan_id, name, recurrence, window_start, window_end, next_due_at, status, creator_agent_id)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      [planId, name, recurrence, windowStart, windowEnd, nextDue, creatorAgentId],
    );
    const planIdNum = Number((ins as unknown as { insertId: unknown }).insertId);

    for (let i = 0; i < stages.length; i++) {
      const stageName = stages[i].name.trim();
      const st = await conn.query(
        `INSERT INTO plan_stages (plan_id, seq, name) VALUES (?, ?, ?)`,
        [planIdNum, i + 1, stageName],
      );
      const stageId = Number((st as unknown as { insertId: unknown }).insertId);
      const isCurrent = i === 0; // 首 stage 为当前
      for (const t of stages[i].tasks) {
        if (!t.title?.trim() || !t.instruction?.trim()) {
          throw new Error(`stage「${stageName}」存在缺标题或指令的任务`);
        }
        let assigneeId: number | null = null;
        if (t.assignee) {
          const target = (await conn.query(
            `SELECT id FROM agents WHERE agent_id = ? AND status='active' LIMIT 1`,
            [t.assignee],
          )) as Array<Record<string, unknown>>;
          if (target.length === 0) throw new Error(`目标主机 ${t.assignee} 不存在或已禁用`);
          assigneeId = Number(target[0].id);
        }
        const visibility: 'private' | 'public' = t.visibility === 'public' ? 'public' : 'private';
        if (visibility === 'private' && !assigneeId) {
          throw new Error(`任务「${t.title}」私有必须指派执行方`);
        }
        const specJson = t.deliverable_spec == null ? null : JSON.stringify(t.deliverable_spec);
        const hash = taskContentHash({ title: t.title, instruction: t.instruction, deliverable_spec: specJson, visibility });
        // 落点：当前 stage → 过发布门禁；未来 stage → blocked
        // 周期首实例（§编排四矩阵）：private 跳过 LLM 门禁（自己给自己）；public 首实例过审核
        const isPeriodic = recurrence !== 'none';
        let status: string;
        if (!isCurrent) {
          status = 'blocked';
        } else if (isPeriodic && visibility === 'private') {
          status = assigneeId ? 'open' : 'active';
        } else {
          status = resolvePublishStatus(llmOn, assigneeId !== null);
        }
        const taskId = nextTaskId();
        const tins = await conn.query(
          `INSERT INTO tasks (task_id, title, instruction, kind, origin, visibility, stage_id, status, assignee_id, creator_id, workdir, deliverable_spec, content_hash, deliverable_visibility)
           VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'participants')`,
          [taskId, t.title.trim(), t.instruction.trim(), isPeriodic ? 'periodic' : 'manual', visibility, stageId, status, assigneeId, creatorAgentId, specJson, hash],
        );
        const taskDbId = Number((tins as unknown as { insertId: unknown }).insertId);
        // 周期首实例：series_id = 自身 id（§编排三：WHERE series_id=? 串起整条序列，首实例自身不遗漏）
        if (isPeriodic) {
          await conn.query(`UPDATE tasks SET series_id = ? WHERE id = ?`, [taskDbId, taskDbId]);
        }
        // 首条消息 = 请求（creator 视角；管理员创建 role=admin）
        await conn.query(
          `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, ?, ?, 'chat', ?)`,
          [taskDbId, creatorAgentId, creatorAgentId === null ? 'admin' : 'agent', t.instruction.trim()],
        );
        // 降级标记：非周期或周期 public 首实例（private 周期跳过门禁，无标记）
        if (!llmOn && status !== 'blocked' && (recurrence === 'none' || visibility === 'public')) {
          await conn.query(
            `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'platform', 'verdict', ?)`,
            [taskDbId, '[平台] LLM 审核未配置，降级放行（未经 LLM 审核）；任务已发布'],
          );
        }
      }
    }
    return { ok: true, plan_id: planId };
  });
}

// ─────────────────────────── 树视图 / 闸门 ───────────────────────────

/** stage 完成判定（全平台唯一实现）：全部任务 ∈ {done, cancelled}；空 stage 视为完成（跳过，不卡闸门） */
export async function isStageComplete(stageId: number): Promise<boolean> {
  const rows = (await query(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('done','cancelled') THEN 1 ELSE 0 END) AS done_n
       FROM tasks WHERE stage_id = ?`,
    [stageId],
  )) as Array<Record<string, unknown>>;
  const n = Number(rows[0].n);
  return n === 0 || Number(rows[0].done_n) === n;
}

/** stage 落点（§编排二）：返回 stage 所属 plan、seq、是否当前 stage、是否已完成 stage */
export async function stagePlacement(stageId: number): Promise<{
  ok: boolean; error?: string;
  planId?: number; seq?: number; current?: boolean; stageDone?: boolean;
}> {
  const rows = (await query(
    `SELECT s.id AS stage_id, s.plan_id, s.seq, p.status AS plan_status, p.recurrence
       FROM plan_stages s JOIN plans p ON p.id = s.plan_id
      WHERE s.id = ? LIMIT 1`,
    [stageId],
  )) as Array<Record<string, unknown>>;
  if (rows.length === 0) return { ok: false, error: `stage ${stageId} 不存在` };
  const r = rows[0];
  const planId = Number(r.plan_id);
  const seq = Number(r.seq);
  const recurrence = String(r.recurrence ?? 'none');
  const planStatus = String(r.plan_status);
  if (planStatus === 'archived') return { ok: false, error: 'plan 已归档，不可追加任务' };
  // 周期 plan 禁止追加任务（P1-2）：克隆源 = stage 内最新任务，追加会劫持序列
  if (recurrence !== 'none') return { ok: false, error: '周期 plan 禁止追加任务（克隆源为 stage 内最新任务，追加会污染克隆序列）' };
  // 当前 stage = seq 最小且未完成的 stage（空 stage 视为完成，与闸门同口径）
  const stages = (await query(
    `SELECT s.id, s.seq, (SELECT COUNT(*) FROM tasks t WHERE t.stage_id = s.id
        AND t.status NOT IN ('done','cancelled')) AS pending_n
       FROM plan_stages s WHERE s.plan_id = ? ORDER BY s.seq`,
    [planId],
  )) as Array<Record<string, unknown>>;
  const currentSeq = stages.find((s) => Number(s.pending_n) > 0)?.seq ?? stages.length;
  const stageDoneFlag = await isStageComplete(stageId);
  return { ok: true, planId, seq, current: seq === Number(currentSeq), stageDone: stageDoneFlag };
}

export interface PlanView {
  plan_id: string;
  name: string;
  recurrence: string;
  status: string;
  next_due_at: string | null;
  stages: {
    id: number;
    seq: number;
    name: string;
    current: boolean;
    tasks: Array<Record<string, unknown>>;
    skipped: string[]; // cancelled 任务标题
  }[];
}

/** plan 树视图（管理端全量；含 stalled 可见性） */
export async function planTree(planId: string): Promise<{ ok: boolean; plan?: PlanView; error?: string }> {
  const rows = (await query(`SELECT * FROM plans WHERE plan_id = ? LIMIT 1`, [planId])) as Array<Record<string, unknown>>;
  if (rows.length === 0) return { ok: false, error: `plan ${planId} 不存在` };
  const p = rows[0] as Record<string, unknown>;
  const stages = (await query(
    `SELECT * FROM plan_stages WHERE plan_id = ? ORDER BY seq`,
    [p.id],
  )) as Array<Record<string, unknown>>;
  const view: PlanView = {
    plan_id: String(p.plan_id),
    name: String(p.name),
    recurrence: String(p.recurrence ?? 'none'),
    status: String(p.status),
    next_due_at: (p.next_due_at as string | null) ?? null,
    stages: [],
  };
  const stageViews: { id: number; seq: number; name: string; tasks: Array<Record<string, unknown>>; skipped: string[] }[] = [];
  for (const st of stages) {
    const tasks = (await query(
      `SELECT t.task_id, t.title, t.status, t.visibility, t.origin, t.deliver_attempts, t.max_attempts,
              t.deliverable_visibility, t.created_at,
              a.agent_id AS assignee, c.agent_id AS creator_agent_id
         FROM tasks t
         LEFT JOIN agents a ON a.id = t.assignee_id
         LEFT JOIN agents c ON c.id = t.creator_id
        WHERE t.stage_id = ? ORDER BY t.id`,
      [st.id],
    )) as Array<Record<string, unknown>>;
    const skipped = tasks
      .filter((t) => String(t.status) === 'cancelled')
      .map((t) => String(t.title));
    stageViews.push({
      id: Number(st.id),
      seq: Number(st.seq),
      name: String(st.name),
      tasks,
      skipped,
    });
  }
  // current = 第一个存在非终态任务的 stage（全完成 → 无 current）
  const hasOpen = (t: Record<string, unknown>) => !['done', 'cancelled'].includes(String(t.status));
  const currentSeq = stageViews.find((s) => s.tasks.some(hasOpen))?.seq ?? null;
  view.stages = stageViews.map((s) => ({ ...s, current: s.seq === currentSeq }));
  return { ok: true, plan: view };
}

/** 全部 plan 列表（管理端） */
export async function listPlans(): Promise<Array<Record<string, unknown>>> {
  return query(
    `SELECT p.plan_id, p.name, p.recurrence, p.status, p.next_due_at, p.created_at,
            (SELECT COUNT(*) FROM plan_stages s WHERE s.plan_id = p.id) AS stage_count,
            (SELECT COUNT(*) FROM plan_stages s JOIN tasks t ON t.stage_id = s.id WHERE s.plan_id = p.id) AS task_count
       FROM plans p ORDER BY p.id DESC LIMIT 100`,
  );
}

/**
 * 闸门扫描（clock 驱动，幂等）：对每个一次性 plan，逐 stage 检查——
 * 当前 stage 全部 done/cancelled → 放行下一 stage 的 blocked 任务（回帖：放行清单 + 前序跳过清单）；
 * 最后 stage 完成 → plan.status='done'。覆盖所有完成任务通道（MCP/管理端/超时回收）。
 */
export async function runStageGates(): Promise<number> {
  const plans = (await query(
    `SELECT * FROM plans WHERE recurrence = 'none' AND status = 'active'`,
  )) as Array<Record<string, unknown>>;
  let released = 0;
  for (const p of plans) {
    const planId = Number(p.id);
    const stages = (await query(
      `SELECT * FROM plan_stages WHERE plan_id = ? ORDER BY seq`,
      [planId],
    )) as Array<Record<string, unknown>>;
    for (let i = 0; i < stages.length; i++) {
      const cur = stages[i] as Record<string, unknown>;
      if (!(await isStageComplete(Number(cur.id)))) break; // 当前未完成，后续不推进
      const next = stages[i + 1] as Record<string, unknown> | undefined;
      if (!next) {
        // 最后 stage 完成 → plan done
        await query(`UPDATE plans SET status = 'done' WHERE id = ? AND status = 'active'`, [planId]);
        continue;
      }
      const blocked = (await query(
        `SELECT * FROM tasks WHERE stage_id = ? AND status = 'blocked'`,
        [next.id],
      )) as Array<Record<string, unknown>>;
      if (blocked.length === 0) continue;
      const skipped = (await query(
        `SELECT title FROM tasks WHERE stage_id = ? AND status = 'cancelled'`,
        [cur.id],
      )) as Array<Record<string, unknown>>;
      const skipNote = skipped.length > 0
        ? `；前序跳过：${skipped.map((r) => String(r.title)).join('、')}`
        : '';
      const llmOn = await llmConfigured();
      for (const bt of blocked) {
        const target = resolvePublishStatus(llmOn, bt.assignee_id !== null);
        await query(`UPDATE tasks SET status = ? WHERE id = ? AND status = 'blocked'`, [target, bt.id]);
        await query(
          `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'platform', 'system', ?)`,
          [bt.id, `[闸门放行] 前序 stage 完成，本任务放行${skipNote}`],
        );
        released++;
      }
      // 放行后可能连锁推进下一 stage（循环继续检查）
    }
  }
  return released;
}

// ─────────────────────────── 周期序列克隆（clock） ───────────────────────────

/**
 * 周期 plan 克隆（§编排三）：next_due_at 到点 → 从上一实例克隆定义字段生成新实例行。
 * - 上一实例未终结（非 done/cancelled/failed）→ 跳过本轮 + 回帖，next_due_at 照常推进（防堆积）
 * - 审核继承：content hash 未变 → 继承（标记）；变更 → 重新审核；visibility 变更强制重审
 * - 私有周期不经门禁；public 周期首实例审核
 */
export async function runPeriodicClones(): Promise<number> {
  const due = (await query(
    `SELECT * FROM plans WHERE recurrence != 'none' AND status = 'active'
       AND next_due_at IS NOT NULL AND next_due_at <= ? LIMIT 20`,
    [nowString()],
  )) as Array<Record<string, unknown>>;
  let cloned = 0;
  for (const p of due) {
    const planId = Number(p.id);
    // 推进 next_due_at（无论本轮是否克隆，防重复扫）；
    // 乐观锁：旧值守卫防并发双跑（60s interval 与管理端「立即扫描」并存）——别人已推进则本轮放弃
    const nextDue = computeNextDue(
      String(p.recurrence),
      (p.window_start as string | null) ?? null,
      (p.window_end as string | null) ?? null,
      new Date(),
    );
    const adv = await query(
      `UPDATE plans SET next_due_at = ? WHERE id = ? AND next_due_at = ?`,
      [toLocalString(nextDue), planId, String(p.next_due_at)],
    );
    if (Number((adv as unknown as { affectedRows?: number }).affectedRows ?? 0) === 0) continue;

    // 单 stage（创建校验保证）：取上一实例（该 stage 下最新任务）
    const stage = (await query(
      `SELECT * FROM plan_stages WHERE plan_id = ? ORDER BY seq LIMIT 1`,
      [planId],
    )) as Array<Record<string, unknown>>;
    if (stage.length === 0) continue;
    const stageId = Number(stage[0].id);
    const last = (await query(
      `SELECT * FROM tasks WHERE stage_id = ? ORDER BY id DESC LIMIT 1`,
      [stageId],
    )) as Array<Record<string, unknown>>;
    if (last.length === 0) continue;
    const src = last[0] as Record<string, unknown>;

    // 重叠策略：上一实例未终结 → 跳过本轮 + 回帖
    const srcStatus = String(src.status);
    if (!['done', 'cancelled', 'failed'].includes(srcStatus)) {
      await query(
        `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'platform', 'system', ?)`,
        [src.id, `[周期] 本轮 ${String(p.name)} 到点但上一实例未终结（${srcStatus}），跳过本轮（防堆积）`],
      );
      continue;
    }

    // 克隆定义字段
    const hash = taskContentHash({
      title: String(src.title), instruction: String(src.instruction),
      deliverable_spec: src.deliverable_spec as string | null, visibility: String(src.visibility),
    });
    // 审核继承：仅按内容 hash 判定；visibility 变更强制重审待「序列编辑」落地后实现（当前克隆始终沿用上一实例 visibility）
    const needReaudit = hash !== String(src.content_hash ?? '');

    const llmOn = await llmConfigured();
    const isPublic = String(src.visibility) === 'public';
    // 发布门禁矩阵（§编排四）：private+periodic 跳过；public+periodic 首实例/变更审核
    const status = isPublic && (needReaudit || !src.content_hash)
      ? resolvePublishStatus(llmOn, false)
      : src.assignee_id !== null ? 'open' : 'active';

    const taskId = nextTaskId();
    const ins = await query(
      `INSERT INTO tasks (task_id, title, instruction, kind, origin, visibility, stage_id, status,
                          assignee_id, creator_id, workdir, deliverable_spec, content_hash, series_id, deliverable_visibility)
       VALUES (?, ?, ?, 'manual', 'periodic', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      [
        taskId, src.title, src.instruction, src.visibility, stageId, status,
        src.assignee_id, src.creator_id, src.deliverable_spec, hash, src.series_id ?? src.id,
        src.deliverable_visibility ?? 'participants',
      ],
    );
    const newTaskId = Number((ins as unknown as { insertId: unknown }).insertId);
    // 首条消息 = 请求（对齐 createTask 形态，P0-1：manual 拾取分支依赖首条消息 sender ≠ 执行方）
    const creatorId = src.creator_id === null ? null : Number(src.creator_id);
    await query(
      `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, ?, ?, 'chat', ?)`,
      [newTaskId, creatorId, creatorId === null ? 'admin' : 'agent', String(src.instruction)],
    );
    // 继承标记回帖
    if (isPublic && !needReaudit && src.content_hash) {
      await query(
        `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'platform', 'verdict', ?)`,
        [newTaskId, '[周期] 定义字段未变更，继承前序实例审核结论（继承审核）'],
      );
    } else if (isPublic && status === 'active' && !llmOn) {
      await query(
        `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'platform', 'verdict', ?)`,
        [newTaskId, '[平台] LLM 审核未配置，降级放行（未经 LLM 审核）'],
      );
    }
    cloned++;
  }
  return cloned;
}
