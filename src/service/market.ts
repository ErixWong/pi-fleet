import { query, withTransaction } from '../db.js';
import type { AgentIdentity } from '../auth.js';
import { nowString } from '../scheduler.js';
import { llmConfigured } from './llm.js';
import {
  getTaskMessages,
  listDeliverables,
  parseDeliverableSpec,
  validateDeliverableSpec,
  type DeliverableSpecItem,
  type DeliverableView,
  type MessageView,
} from './tasks.js';

/**
 * 开放生态市场语义（§8 / §3.2 / §3.3 / §3.6）：
 * 公共池（visibility=public）、原子认领、验收链路（程序预检 + 发起人判决 + 续做回路）。
 * 与 REST（agent 池扫描/认领）和 MCP（task 工具）共用；平台只做门禁与留痕，内容与质量归玩家。
 */

// ─────────────────────────── 公共池 ───────────────────────────

export interface PoolTaskView {
  task_id: string;
  title: string;
  instruction: string;
  visibility: 'private' | 'public';
  deliverable_spec: DeliverableSpecItem[];
  workdir: string | null;
  creator_agent_id: string | null;
  creator_name: string | null;
  created_at: string;
}

/** 公共池列表（§3.2）：status=active + visibility=public 且未被认领。排除自己发起的（不自认自领）。 */
export async function listPoolTasks(agent: AgentIdentity): Promise<PoolTaskView[]> {
  const rows = await query(
    `SELECT t.task_id, t.title, t.instruction, t.visibility, t.deliverable_spec, t.workdir, t.created_at,
            c.agent_id AS creator_agent_id, c.name AS creator_name
       FROM tasks t
       LEFT JOIN agents c ON c.id = t.creator_id
      WHERE t.kind = 'manual' AND t.status = 'active' AND t.visibility = 'public'
        AND t.assignee_id IS NULL
        AND (t.creator_id IS NULL OR t.creator_id != ?)
      ORDER BY t.created_at ASC LIMIT 50`,
    [agent.id],
  );
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    task_id: String(r.task_id),
    title: String(r.title),
    instruction: String(r.instruction),
    visibility: (r.visibility as 'private' | 'public') ?? 'private',
    deliverable_spec: parseDeliverableSpec((r.deliverable_spec as string | null) ?? null),
    workdir: (r.workdir as string | null) ?? null,
    creator_agent_id: (r.creator_agent_id as string | null) ?? null,
    creator_name: (r.creator_name as string | null) ?? null,
    created_at: String(r.created_at),
  }));
}

// ─────────────────────────── 认领（原子，先到先得） ───────────────────────────

/**
 * 认领任务（§3.2 / §10.2）：不做队列——UPDATE 行锁原子认领，affectedRows=1 得标、=0 即被抢。
 * - 公共池：status='active' AND visibility='public' → claimed（前置：本主机 accept_external=1，
 *   以 EXISTS 子查询并入同一 UPDATE，无开关直接 affectedRows=0，无需回滚——避免占坑/竞态）
 * - 指派：status='open' AND assignee_id=me → claimed（显式领活，不要求接单开关）
 */
export async function claimTask(
  agent: AgentIdentity,
  taskId: string,
): Promise<{ ok: boolean; mode?: 'pool' | 'assigned'; error?: string }> {
  // 公共池原子认领：接单开关并入 WHERE（EXISTS 子查询），未开启则本语句即不命中
  const r1 = await query(
    `UPDATE tasks
        SET status = 'claimed', assignee_id = ?, claimed_at = ?, last_activity_at = ?
      WHERE task_id = ? AND status = 'active' AND visibility = 'public' AND assignee_id IS NULL
        AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND accept_external = 1 AND status = 'active')`,
    [agent.id, nowString(), nowString(), taskId, agent.id],
  );
  if (((r1 as unknown as { affectedRows?: number }).affectedRows ?? 0) === 1) {
    return { ok: true, mode: 'pool' };
  }

  // 指派任务显式领活
  const r2 = await query(
    `UPDATE tasks SET status = 'claimed', claimed_at = ?, last_activity_at = ?
      WHERE task_id = ? AND status = 'open' AND assignee_id = ?`,
    [nowString(), nowString(), taskId, agent.id],
  );
  if (((r2 as unknown as { affectedRows?: number }).affectedRows ?? 0) === 1) {
    return { ok: true, mode: 'assigned' };
  }

  // 区分错误：任务状态 / 已被认领 / 未开接单开关
  const rows = await query(`SELECT status, visibility, assignee_id FROM tasks WHERE task_id = ? LIMIT 1`, [
    taskId,
  ]);
  if (rows.length === 0) return { ok: false, error: `任务 ${taskId} 不存在` };
  const t = rows[0] as Record<string, unknown>;
  if (String(t.status) === 'active' && String(t.visibility) === 'public') {
    const me = (await query(`SELECT accept_external FROM agents WHERE id = ?`, [agent.id]))[0] as
      | { accept_external: number }
      | undefined;
    if (me?.accept_external !== 1) {
      return { ok: false, error: '认领公共池任务需先开启接单开关（accept_external），请主机所有者在注册设置中放开' };
    }
    return { ok: false, error: '任务已被其他主机认领（先到先得）' };
  }
  if (String(t.status) === 'claimed') {
    return {
      ok: false,
      error: Number(t.assignee_id) === agent.id ? '你已认领该任务' : '任务已被其他主机认领，无法重复认领',
    };
  }
  if (String(t.status) === 'open' && Number(t.assignee_id) === agent.id) {
    return { ok: false, error: '任务已处于进行中' };
  }
  return { ok: false, error: `任务状态 ${t.status} 不可认领` };
}

// ─────────────────────────── 发布（agent 侧） ───────────────────────────

export interface CreateTaskOptions {
  title: string;
  instruction: string;
  /** 默认 private（§3.2 已定），手动放开为 public */
  visibility?: 'private' | 'public';
  /** 指派执行方 agent_id（private 必填；public 入池待认领） */
  assignee?: string;
  workdir?: string | null;
  /** 验收方案（§3.3 发布必填、可操作性 schema 校验硬阻断） */
  deliverable_spec?: unknown;
}

function yymmdd(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(now.getFullYear()).slice(2)}${p(now.getMonth() + 1)}${p(now.getDate())}`;
}

import { randomBytes } from 'node:crypto';
function randomHex(): string {
  return randomBytes(4).toString('hex');
}

/**
 * agent 发布任务（§3.6 create）：任务 ID 永远平台生成，不接受外部指定。
 * - private + assignee → 协作会话（open，首条消息=请求）
 * - public → 公共池（active，待认领）
 * - 验收方案做 schema 程序校验（硬阻断，§3.3）
 * - LLM 审核（§3.4）：配置了 LLM → pending_audit 后台异步审核；未配置 → 降级直通并标记"未经 LLM 审核"
 */
export async function createTask(
  agent: AgentIdentity,
  opts: CreateTaskOptions,
): Promise<{ ok: boolean; task_id?: string; status?: string; error?: string }> {
  const title = (opts.title ?? '').trim();
  const instruction = (opts.instruction ?? '').trim();
  if (!title || !instruction) return { ok: false, error: '缺少标题或指令' };
  const specCheck = validateDeliverableSpec(opts.deliverable_spec);
  if (!specCheck.ok) return { ok: false, error: specCheck.error };
  const visibility: 'private' | 'public' = opts.visibility === 'public' ? 'public' : 'private';
  const workdir = (opts.workdir ?? '').trim() || null;
  const specJson =
    opts.deliverable_spec === undefined || opts.deliverable_spec === null
      ? null
      : typeof opts.deliverable_spec === 'string'
        ? (opts.deliverable_spec as string).trim() || null
        : JSON.stringify(opts.deliverable_spec);

  let assigneeId: number | null = null;
  if (opts.assignee) {
    const target = (await query(`SELECT id FROM agents WHERE agent_id = ? AND status='active' LIMIT 1`, [
      opts.assignee,
    ])) as Array<Record<string, unknown>>;
    if (target.length === 0) return { ok: false, error: `目标主机 ${opts.assignee} 不存在或已禁用` };
    assigneeId = Number(target[0].id);
  }
  if (visibility === 'private' && !assigneeId) {
    return { ok: false, error: '私有任务必须指派执行方；如需入公共池请设 visibility=public' };
  }

  const taskId = `T-${yymmdd()}-${randomHex()}`;
  return withTransaction(async (conn) => {
    const llmOn = await llmConfigured();
    // 有指派 → 协作会话；无指派（public）→ 公共池；配置 LLM → 先过 pending_audit 审核
    const status = llmOn ? 'pending_audit' : assigneeId ? 'open' : 'active';
    const ins = await conn.query(
      `INSERT INTO tasks (task_id, title, instruction, kind, visibility, creator_id, assignee_id, status, workdir, deliverable_spec)
       VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?)`,
      [taskId, title, instruction, visibility, agent.id, assigneeId, status, workdir, specJson],
    );
    await conn.query(
      `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, ?, 'agent', 'chat', ?)`,
      [Number((ins as unknown as { insertId: unknown }).insertId), agent.id, instruction],
    );
    if (!llmOn) {
      await conn.query(
        `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'platform', 'verdict', ?)`,
        [Number((ins as unknown as { insertId: unknown }).insertId), '[平台] LLM 审核未配置，降级放行（未经 LLM 审核）；任务已发布'],
      );
    }
    return { ok: true, task_id: taskId, status };
  });
}

// ─────────────────────────── 修订 ───────────────────────────

/** 修订任务（§3.6 revise）：发起人（creator）在未被认领/进行前可改标题/指令/验收方案/可见性。 */
export async function reviseTask(
  agent: AgentIdentity,
  taskId: string,
  fields: {
    title?: string;
    instruction?: string;
    deliverable_spec?: unknown;
    visibility?: 'private' | 'public';
  },
): Promise<{ ok: boolean; error?: string }> {
  const specCheck = validateDeliverableSpec(fields.deliverable_spec);
  if (!specCheck.ok) return { ok: false, error: specCheck.error };
  return withTransaction(async (conn) => {
    const rows = (await conn.query(
      `SELECT id, status, creator_id, assignee_id FROM tasks WHERE task_id = ? LIMIT 1 FOR UPDATE`,
      [taskId],
    )) as Array<Record<string, unknown>>;
    if (rows.length === 0) return { ok: false, error: `任务 ${taskId} 不存在` };
    if (Number(rows[0].creator_id) !== agent.id) return { ok: false, error: '只有发起人可以修订任务' };
    const status = String(rows[0].status);
    if (!['pending', 'pending_audit', 'rejected', 'active', 'open'].includes(status)) {
      return { ok: false, error: `任务已 ${status}，无法修订（认领后只能通过消息沟通）` };
    }
    // 改成 private 但无执行方 → 死任务（无人可见可认领），硬阻断（与 createTask 同规则）
    if (fields.visibility === 'private' && Number(rows[0].assignee_id ?? 0) === 0) {
      return { ok: false, error: '私有任务必须指派执行方；如需留在公共池请保留 visibility=public' };
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.title !== undefined) {
      const title = String(fields.title).trim();
      if (!title) return { ok: false, error: '标题不能为空' };
      sets.push('title = ?');
      params.push(title);
    }
    if (fields.instruction !== undefined) {
      const instruction = String(fields.instruction).trim();
      if (!instruction) return { ok: false, error: '指令不能为空' };
      sets.push('instruction = ?');
      params.push(instruction);
    }
    if (fields.visibility !== undefined) {
      sets.push('visibility = ?');
      params.push(fields.visibility === 'public' ? 'public' : 'private');
    }
    if (fields.deliverable_spec !== undefined && fields.deliverable_spec !== null) {
      sets.push('deliverable_spec = ?');
      params.push(
        typeof fields.deliverable_spec === 'string'
          ? String(fields.deliverable_spec).trim()
          : JSON.stringify(fields.deliverable_spec),
      );
    } else if (fields.deliverable_spec === null) {
      sets.push('deliverable_spec = NULL');
    }
    if (sets.length === 0) return { ok: false, error: '没有要修订的字段' };
    params.push(taskId);
    await conn.query(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`, params);
    // 修订后重新提交审核（rejected → pending_audit 或降级直通）
    if (status === 'rejected') {
      const llmOn = await llmConfigured();
      const nextStatus = llmOn ? 'pending_audit' : rows[0].assignee_id !== null ? 'open' : 'active';
      await conn.query(`UPDATE tasks SET status = ? WHERE id = ?`, [nextStatus, rows[0].id]);
      await conn.query(
        `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, ?, 'agent', 'verdict', ?)`,
        [rows[0].id, agent.id, llmOn ? '[修订提交] 已重新提交 LLM 审核' : '[修订提交] 已重新发布（LLM 审核未配置，降级放行）'],
      );
    }
    return { ok: true };
  });
}

// ─────────────────────────── 详情 ───────────────────────────

export interface TaskDetailView {
  ok: boolean;
  error?: string;
  task?: Record<string, unknown>;
  messages?: MessageView[];
  deliverables?: { spec: DeliverableSpecItem[]; versions: DeliverableView[] };
  reports?: Array<Record<string, unknown>>;
}

/** 任务完整详情（§3.6 detail：吸收 fetch_task/get_messages/list_deliverables，放开发布者视角与公共池浏览） */
export async function taskDetail(agent: AgentIdentity, taskId: string): Promise<TaskDetailView> {
  const rows = await query(
    `SELECT t.*, a.agent_id AS assignee, a.name AS assignee_name,
            c.agent_id AS creator_agent_id, c.name AS creator_name
       FROM tasks t
       LEFT JOIN agents a ON a.id = t.assignee_id
       LEFT JOIN agents c ON c.id = t.creator_id
      WHERE t.task_id = ? LIMIT 1`,
    [taskId],
  );
  if (rows.length === 0) return { ok: false, error: `任务 ${taskId} 不存在` };
  const task = rows[0] as Record<string, unknown>;
  const participant =
    (task.assignee_id !== null && Number(task.assignee_id) === agent.id) ||
    (task.creator_id !== null && Number(task.creator_id) === agent.id);
  const inPool = String(task.status) === 'active' && String(task.visibility) === 'public';
  if (!participant && !inPool) return { ok: false, error: `任务 ${taskId} 不存在或你未参与` };
  const [messages, dl] = await Promise.all([getTaskMessages(taskId), listDeliverables(taskId)]);
  const reports = await query(
    `SELECT r.content, r.created_at, a.agent_id FROM reports r
      LEFT JOIN agents a ON a.id = r.agent_id
     WHERE r.task_id = ? ORDER BY r.created_at ASC LIMIT 20`,
    [task.id],
  );
  return { ok: true, task, messages, deliverables: dl, reports };
}

// ─────────────────────────── 提交验收（预检 + 续做回路） ───────────────────────────

/** 程序预检（§3.3 平台门禁：存在性/非空/数量/类型/扫描；附件系统升级版 §3.7）
 * - 约定项 name 有 current 版本且附件非空（attachment 存在、未感染）
 * - 类型匹配：spec.type='.ext' → 附件扩展名；'mime/prefix' → 附件 mime 前缀
 * - 扫描：scan_status='infected' 拒绝引用与下载 */
async function precheckDeliverables(
  conn: { query: (sql: string, p?: unknown[]) => Promise<unknown[]> },
  taskId: number,
  spec: DeliverableSpecItem[],
): Promise<{ ok: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  for (const item of spec) {
    const need = item.min_count && item.min_count > 1 ? item.min_count : 1;
    const rows = (await conn.query(
      `SELECT d.id, d.attachment_id, a.filename, a.mime, a.scan_status
         FROM deliverables d
         LEFT JOIN attachments a ON a.id = d.attachment_id
        WHERE d.task_id = ? AND d.name = ? AND d.current = TRUE`,
      [taskId, item.name],
    )) as Array<Record<string, unknown>>;
    // 有效 = 引用了存在且未感染的附件
    const valid = rows.filter(
      (r) => r.attachment_id !== null && r.scan_status !== 'infected' && String(r.scan_status ?? '') !== '',
    );
    if (valid.length < need) {
      reasons.push(
        `交付物「${item.name}」需 ${need} 份带附件的版本（当前 ${valid.length} 份；缺失附件/未过扫描均不计）`,
      );
      continue;
    }
    // 类型约束：'.ext' 扩展名 / 'mime/' 前缀
    if (item.type && item.type.startsWith('.')) {
      const bad = valid.filter(
        (r) => !String(r.filename ?? '').toLowerCase().endsWith(item.type!.toLowerCase()),
      );
      if (bad.length > 0) {
        reasons.push(
          `交付物「${item.name}」类型应为 ${item.type}，但 ${bad.map((r) => r.filename).join('、')} 不符合`,
        );
      }
    } else if (item.type && item.type.includes('/')) {
      const bad = valid.filter((r) => !String(r.mime ?? '').toLowerCase().startsWith(item.type!.toLowerCase()));
      if (bad.length > 0) {
        reasons.push(
          `交付物「${item.name}」mime 应为 ${item.type} 前缀，但 ${bad.map((r) => r.mime).join('、')} 不符合`,
        );
      }
    }
    const infected = rows.filter((r) => r.scan_status === 'infected');
    if (infected.length > 0) {
      reasons.push(`交付物「${item.name}」存在被判定感染的附件，已拒绝`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** 交付物提交项：附件引用（新，推荐）或纯路径（旧，无 spec 任务兼容） */
export interface SubmitDeliverable {
  name: string;
  path?: string;
  attachment_id?: string;
  message?: string;
}

/** 事务内提交一个交付物版本（submit 携带 deliverables 时用；版本自增 v1→v2…；附件引用即授权） */
async function insertDeliverableVersion(
  conn: { query: (sql: string, p?: unknown[]) => Promise<unknown> },
  taskId: number,
  agentId: number,
  d: SubmitDeliverable,
): Promise<{ ok: boolean; error?: string }> {
  const name = (d.name ?? '').trim();
  if (!name) return { ok: false, error: 'deliverables 每项须有 name' };
  let attId: number | null = null;
  const path = (d.path ?? '').trim();
  if (d.attachment_id) {
    const att = (await conn.query(
      `SELECT id, scan_status FROM attachments WHERE attachment_id = ? LIMIT 1`,
      [d.attachment_id],
    )) as Array<Record<string, unknown>>;
    if (att.length === 0) return { ok: false, error: `附件 ${d.attachment_id} 不存在` };
    if (String(att[0].scan_status) === 'infected') {
      return { ok: false, error: `附件 ${d.attachment_id} 被判定为感染，拒绝引用` };
    }
    attId = Number(att[0].id);
  }
  if (!attId && !path) return { ok: false, error: `交付物「${name}」须有附件引用（attachment_id）或路径（path）` };
  const maxRow = (await conn.query(
    `SELECT MAX(CAST(REPLACE(version, 'v', '') AS UNSIGNED)) AS max_v
       FROM deliverables WHERE task_id = ? AND name = ?`,
    [taskId, name],
  )) as Array<Record<string, unknown>>;
  const nextVersion = `v${(Number(maxRow[0].max_v) || 0) + 1}`;
  await conn.query(`UPDATE deliverables SET current = FALSE WHERE task_id = ? AND name = ?`, [
    taskId,
    name,
  ]);
  await conn.query(
    `INSERT INTO deliverables (task_id, name, path, version, message, current, agent_id, attachment_id)
     VALUES (?, ?, ?, ?, ?, TRUE, ?, ?)`,
    [taskId, name, path, nextVersion, d.message ?? null, agentId, attId],
  );
  await conn.query(`UPDATE tasks SET deliverable_version = ? WHERE id = ?`, [nextVersion, taskId]);
  return { ok: true };
}

/**
 * 提交验收（§3.6 submit）：scheduled 直接记录（§3.4 不经门禁）；manual/pool 进验收链路——
 * ① 程序预检（存在性/非空/数量/类型）→ 通过 → pending_confirm 待发起人判决
 * （LLM 验收未接入，降级标记"未经 LLM 验收"，§3.4 故障降级哲学）；
 * 预检不合格 → claimed 续做回路，deliver_attempts+1，超上限 → failed（§3.3）。
 * 验收结果（预检/打回/通过）均以消息落库并标记来源（platform/发起人）——agent 续做读完整验收历史，不靠猜。
 */
export async function submitForReview(
  agent: AgentIdentity,
  taskId: string,
  result: string,
  deliverables?: SubmitDeliverable[],
): Promise<{ ok: boolean; status?: string; reason?: string; error?: string }> {
  return withTransaction(async (conn) => {
    const rows = (await conn.query(
      `SELECT t.id, t.kind, t.status, t.creator_id, t.assignee_id, t.deliverable_spec,
              t.deliver_attempts, t.max_attempts
         FROM tasks t WHERE t.task_id = ? LIMIT 1 FOR UPDATE`,
      [taskId],
    )) as Array<Record<string, unknown>>;
    if (rows.length === 0) return { ok: false, error: `任务 ${taskId} 不存在` };
    const t = rows[0];
    if (Number(t.assignee_id) !== agent.id) {
      return { ok: false, error: `只有执行方可以提交，你不是任务 ${taskId} 的认领人` };
    }
    const kind = String(t.kind);
    const status = String(t.status);

    // 1. scheduled：不经门禁直接记录
    if (kind === 'scheduled') {
      if (!['pending', 'running'].includes(status)) {
        return { ok: false, error: `任务已 ${status}，无法提交` };
      }
      await conn.query(
        `UPDATE tasks SET status='done', result=?, result_status='success', result_at=?, last_activity_at=?
          WHERE id = ?`,
        [result, nowString(), nowString(), t.id],
      );
      return { ok: true, status: 'done' };
    }

    // 2. manual/pool：只接受认领/进行中提交
    if (!['claimed', 'open', 'running'].includes(status)) {
      return { ok: false, error: `任务已 ${status}，无法提交验收` };
    }

    // 3. 携带的交付物先落版本（版本自增；
    //    有验收方案时 name 必须对齐方案——约定是"什么算完成"的清单，不接收清单外交付物）
    const spec = parseDeliverableSpec((t.deliverable_spec as string | null) ?? null);
    for (const d of deliverables ?? []) {
      const name = (d.name ?? '').trim();
      if (!name) return { ok: false, error: 'deliverables 每项须有 name' };
      if (spec.length > 0 && !spec.some((s) => s.name === name)) {
        return {
          ok: false,
          error: `交付物「${name}」不在任务约定中（约定：${spec.map((s) => s.name).join('、')}）`,
        };
      }
      const ins = await insertDeliverableVersion(conn, Number(t.id), agent.id, d);
      if (!ins.ok) return { ok: false, error: ins.error };
    }

    // 4. 程序预检（平台门禁）
    const pre = await precheckDeliverables(conn, Number(t.id), spec);
    const attempts = Number(t.deliver_attempts) + 1;
    const maxAttempts = Number(t.max_attempts) || 3;

    if (!pre.ok) {
      const reason = `[平台预检未通过] ${pre.reasons.join('；')}`;
      if (attempts >= maxAttempts) {
        await conn.query(
          `UPDATE tasks SET status='failed', deliver_attempts=?, last_activity_at=? WHERE id = ?`,
          [attempts, nowString(), t.id],
        );
        await conn.query(
          `INSERT INTO messages (task_id, sender_id, sender_role, type, content)
           VALUES (?, NULL, 'platform', 'verdict', ?)`,
          [t.id, `${reason}（第 ${attempts}/${maxAttempts} 次，已达上限，任务失败）`],
        );
        return { ok: true, status: 'failed', reason: `${reason}（已达上限）` };
      }
      await conn.query(
        `UPDATE tasks SET status='claimed', deliver_attempts=?, last_activity_at=? WHERE id = ?`,
        [attempts, nowString(), t.id],
      );
      await conn.query(
        `INSERT INTO messages (task_id, sender_id, sender_role, type, content)
         VALUES (?, NULL, 'platform', 'verdict', ?)`,
        [t.id, `${reason}（第 ${attempts}/${maxAttempts} 次，请按原因续做；任务目录保留=工作现场保留）`],
      );
      return { ok: true, status: 'claimed', reason };
    }

    // 5. 预检通过：配置 LLM → submitted 等异步验收（§10.2）；未配置 → 降级放行标记"未经 LLM 验收"
    if (await llmConfigured()) {
      await conn.query(
        `UPDATE tasks SET status='submitted', deliver_attempts=?, last_activity_at=? WHERE id = ?`,
        [attempts, nowString(), t.id],
      );
      await conn.query(
        `INSERT INTO messages (task_id, sender_id, sender_role, type, content)
         VALUES (?, NULL, 'platform', 'verdict', ?)`,
        [
          t.id,
          `[平台预检] 交付物齐全，通过；已进入 LLM 验收（提交说明：${result.slice(0, 2000)}）`,
        ],
      );
      return { ok: true, status: 'submitted' };
    }
    await conn.query(
      `UPDATE tasks SET status='pending_confirm', deliver_attempts=?, last_activity_at=? WHERE id = ?`,
      [attempts, nowString(), t.id],
    );
    await conn.query(
      `INSERT INTO messages (task_id, sender_id, sender_role, type, content)
       VALUES (?, NULL, 'platform', 'verdict', ?)`,
      [
        t.id,
        `[平台预检] 交付物齐全，通过（未配置 LLM 验收，降级放行并标记"未经 LLM 验收"）；已进入待发起人确认。提交说明：${result.slice(0, 2000)}`,
      ],
    );
    return { ok: true, status: 'pending_confirm' };
  });
}

// ─────────────────────────── 发起人判决（approve / reject / cancel） ───────────────────────────

/**
 * 验收通过（§3.6 approve）：发起人（creator）判决，意见回帖（type=verdict）进消息流。
 * submitted/pending_confirm → done；遗留 open/claimed 会话同样适用（done 终态）。
 */
export async function approveTask(
  agent: AgentIdentity,
  taskId: string,
  opinion?: string,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  return withTransaction(async (conn) => {
    const rows = (await conn.query(
      `SELECT id, status, creator_id, assignee_id FROM tasks WHERE task_id = ? LIMIT 1 FOR UPDATE`,
      [taskId],
    )) as Array<Record<string, unknown>>;
    if (rows.length === 0) return { ok: false, error: `任务 ${taskId} 不存在` };
    const t = rows[0];
    if (Number(t.creator_id) !== agent.id) {
      return { ok: false, error: '只有发起人可以验收判决（验收权跟随发起权）' };
    }
    const status = String(t.status);
    if (!['submitted', 'pending_confirm', 'claimed', 'open'].includes(status)) {
      return { ok: false, error: `任务已 ${status}，无法验收` };
    }
    const note = opinion?.trim() ? `：${opinion.trim()}` : '';
    await conn.query(
      `UPDATE tasks SET status='done', result=?, result_status='success', result_at=?, last_activity_at=?, resolved_by_id=? WHERE id = ?`,
      [opinion?.trim() ?? null, nowString(), nowString(), agent.id, t.id],
    );
    await conn.query(
      `INSERT INTO messages (task_id, sender_id, sender_role, type, content)
       VALUES (?, ?, 'agent', 'verdict', ?)`,
      [t.id, agent.id, `[验收通过 by ${agent.name}]${note}`],
    );
    return { ok: true, status: 'done' };
  });
}

/**
 * 验收打回（§3.6 reject）：发起人（creator）打回 → claimed 续做回路，deliver_attempts+1；
 * 超上限（任务级 max_attempts，默认 3）→ failed 终态。打回原因回帖，agent 下轮闹钟带原因续做。
 */
export async function rejectTask(
  agent: AgentIdentity,
  taskId: string,
  opinion: string,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  return withTransaction(async (conn) => {
    const rows = (await conn.query(
      `SELECT id, status, creator_id, assignee_id, deliver_attempts, max_attempts
         FROM tasks WHERE task_id = ? LIMIT 1 FOR UPDATE`,
      [taskId],
    )) as Array<Record<string, unknown>>;
    if (rows.length === 0) return { ok: false, error: `任务 ${taskId} 不存在` };
    const t = rows[0];
    if (Number(t.creator_id) !== agent.id) {
      return { ok: false, error: '只有发起人可以验收判决（验收权跟随发起权）' };
    }
    const status = String(t.status);
    if (!['submitted', 'pending_confirm', 'claimed', 'open'].includes(status)) {
      return { ok: false, error: `任务已 ${status}，无法打回` };
    }
    const attempts = Number(t.deliver_attempts) + 1;
    const maxAttempts = Number(t.max_attempts) || 3;
    const reason = opinion?.trim() || '发起人打回';
    if (attempts >= maxAttempts) {
      await conn.query(
        `UPDATE tasks SET status='failed', deliver_attempts=?, last_activity_at=? WHERE id = ?`,
        [attempts, nowString(), t.id],
      );
      await conn.query(
        `INSERT INTO messages (task_id, sender_id, sender_role, type, content)
         VALUES (?, ?, 'agent', 'verdict', ?)`,
        [t.id, agent.id, `[验收打回 by ${agent.name}] ${reason}（第 ${attempts}/${maxAttempts} 次，已达上限，任务失败）`],
      );
      return { ok: true, status: 'failed' };
    }
    await conn.query(
      `UPDATE tasks SET status='claimed', deliver_attempts=?, last_activity_at=? WHERE id = ?`,
      [attempts, nowString(), t.id],
    );
    await conn.query(
      `INSERT INTO messages (task_id, sender_id, sender_role, type, content)
       VALUES (?, ?, 'agent', 'verdict', ?)`,
      [t.id, agent.id, `[验收打回 by ${agent.name}] ${reason}（第 ${attempts}/${maxAttempts} 次，请按原因续做；任务目录保留=工作现场保留）`],
    );
    return { ok: true, status: 'claimed' };
  });
}

/**
 * 取消任务（§3.6 cancel）：发起人放弃（取消即判决的一种）。public 池任务取消后移出池。
 */
export async function cancelTask(
  agent: AgentIdentity,
  taskId: string,
  reason?: string,
): Promise<{ ok: boolean; error?: string }> {
  return withTransaction(async (conn) => {
    const rows = (await conn.query(
      `SELECT id, status, creator_id FROM tasks WHERE task_id = ? LIMIT 1 FOR UPDATE`,
      [taskId],
    )) as Array<Record<string, unknown>>;
    if (rows.length === 0) return { ok: false, error: `任务 ${taskId} 不存在` };
    if (Number(rows[0].creator_id) !== agent.id) return { ok: false, error: '只有发起人可以取消任务' };
    const status = String(rows[0].status);
    if (!['pending', 'active', 'claimed', 'open', 'submitted', 'pending_confirm', 'running'].includes(status)) {
      return { ok: false, error: `任务已 ${status}，无法取消` };
    }
    await conn.query(
      `UPDATE tasks SET status='cancelled', last_activity_at=? WHERE id = ?`,
      [nowString(), rows[0].id],
    );
    if (reason?.trim()) {
      await conn.query(
        `INSERT INTO messages (task_id, sender_id, sender_role, type, content)
         VALUES (?, ?, 'agent', 'verdict', ?)`,
        [rows[0].id, agent.id, `[任务取消 by ${agent.name}] ${reason.trim()}`],
      );
    }
    return { ok: true };
  });
}
