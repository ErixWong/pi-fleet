import { query, withTransaction } from '../db.js';
import type { AgentIdentity } from '../auth.js';
import { computeNextDue, nowString, toLocalString } from '../scheduler.js';

/**
 * 共享业务层：REST（调度脚本）与 MCP（pi）共用同一套任务/会话逻辑。
 *
 * 会话模型：任务 = 双向消息流（协作线程）。
 * - manual 任务：open（进行中）↔ 双方多轮回复 → resolved（关闭）
 * - scheduled 任务：保持单轮（到期执行 → 报告归档）
 * - 回合判定：最后一条消息的 sender ≠ 我 → 轮到我回复
 */

// ─────────────────────────── 消息 ───────────────────────────

export interface MessageView {
  id: number;
  sender_id: number | null;
  sender_role: 'agent' | 'admin' | 'system' | 'platform';
  sender_name: string | null;
  type: 'chat' | 'progress' | 'report' | 'verdict' | 'system';
  content: string;
  created_at: string;
}

/** 任务的完整消息流（时间正序） */
export async function getTaskMessages(taskId: string): Promise<MessageView[]> {
  const rows = await query(
    `SELECT m.id, m.sender_id, m.sender_role, m.type, a.name AS sender_name, m.content, m.created_at
       FROM task_messages m
       LEFT JOIN agents a ON a.id = m.sender_id
      WHERE m.task_id = (SELECT id FROM tasks WHERE task_id = ?)
      ORDER BY m.created_at ASC, m.id ASC`,
    [taskId],
  );
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    sender_id: r.sender_id === null ? null : Number(r.sender_id),
    sender_role: (r.sender_role as MessageView['sender_role']) ?? 'agent',
    sender_name: (r.sender_name as string | null) ?? null,
    type: (r.type as MessageView['type']) ?? 'chat',
    content: String(r.content),
    created_at: String(r.created_at),
  }));
}

/** 最后一条消息 */
export async function getLastMessage(taskId: string): Promise<MessageView | null> {
  const rows = await query(
    `SELECT m.id, m.sender_id, m.sender_role, m.type, a.name AS sender_name, m.content, m.created_at
       FROM task_messages m
       LEFT JOIN agents a ON a.id = m.sender_id
      WHERE m.task_id = (SELECT id FROM tasks WHERE task_id = ?)
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
    [taskId],
  );
  if (rows.length === 0) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    id: Number(r.id),
    sender_id: r.sender_id === null ? null : Number(r.sender_id),
    sender_role: (r.sender_role as MessageView['sender_role']) ?? 'agent',
    sender_name: (r.sender_name as string | null) ?? null,
    type: (r.type as MessageView['type']) ?? 'chat',
    content: String(r.content),
    created_at: String(r.created_at),
  };
}

/** 校验 agent 是否参与该任务（assignee 或 creator） */
export async function isParticipant(agentId: number, taskId: string): Promise<boolean> {
  const rows = await query(
    `SELECT id FROM tasks WHERE task_id = ? AND (assignee_id = ? OR creator_id = ?) LIMIT 1`,
    [taskId, agentId, agentId],
  );
  return rows.length > 0;
}

// ─────────────────────────── 回合领取（poll / check_due_tasks） ───────────────────────────

export interface DueTask {
  task_id: string;
  title: string;
  instruction: string;
  workdir: string | null;
  /** manual 会话任务附带完整消息流（供调度脚本组装简报，上下文重建） */
  messages?: MessageView[];
}

/**
 * 返回"等待该 agent 动作"的任务：
 * - 协作会话/认领：status IN (open,claimed) 且最后消息发送者 ≠ 该 agent（无消息时 assignee 先处理）；
 *   认领后待验收（submitted/pending_confirm）时发起人（creator）被返回
 * 不改变状态（会话中）；同 agent 同 workdir 已有占用时不并发放行（防项目互踩）。
 */
export async function claimDueTasks(agent: AgentIdentity): Promise<DueTask[]> {
  const me = agent.id;
  return withTransaction(async (conn) => {
    const rows = (await conn.query(
      `SELECT t.id, t.task_id, t.title, t.instruction, t.workdir, lm.sender_id AS lm_sender
         FROM tasks t
         LEFT JOIN (
           SELECT task_id, sender_id FROM task_messages m1
            WHERE m1.id = (SELECT MAX(m2.id) FROM task_messages m2 WHERE m2.task_id = m1.task_id)
         ) lm ON lm.task_id = t.id
        WHERE (
               (t.status IN ('open','claimed')
                 AND (t.assignee_id = ? AND (lm.sender_id IS NULL OR lm.sender_id != ?)))
               OR (t.status IN ('open','claimed','submitted','pending_confirm')
                 AND (t.creator_id = ? AND (lm.sender_id IS NULL OR lm.sender_id != ?)))
              )
          AND (
                t.workdir IS NULL
                OR t.workdir NOT IN (
                  SELECT workdir FROM tasks
                   WHERE assignee_id = ? AND status IN ('running','open','claimed','active') AND workdir IS NOT NULL
                     AND id != t.id
                )
              )
        ORDER BY t.created_at ASC
        LIMIT 20
        FOR UPDATE`,
      [me, me, me, me, me],
    )) as Array<Record<string, unknown>>;

    const due: DueTask[] = [];
    for (const r of rows) {
      await conn.query(`UPDATE tasks SET last_activity_at = ? WHERE id = ?`, [nowString(), r.id]);
      due.push({
        task_id: String(r.task_id),
        title: String(r.title),
        instruction: String(r.instruction),
        workdir: (r.workdir as string | null) ?? null,
      });
    }
    // 附带完整消息流（上下文重建）
    await Promise.all(
      due.map(async (d) => {
        d.messages = await getTaskMessages(d.task_id);
      }),
    );
    return due;
  });
}

// ─────────────────────────── 我参与的任务（线程列表） ───────────────────────────

export interface ThreadView {
  task_id: string;
  title: string;
  status: string;
  workdir: string | null;
  awaiting_me: boolean;
  last_message: MessageView | null;
  created_at: string;
}

export async function listMyThreads(agent: AgentIdentity): Promise<ThreadView[]> {
  const me = agent.id;
  const rows = await query(
    `SELECT t.task_id, t.title, t.status, t.workdir, t.created_at,
            lm.id AS lm_id, lm.sender_id AS lm_sender, lm.sender_role AS lm_role, lm.type AS lm_type,
            a.name AS lm_sender_name, lm.content AS lm_content, lm.created_at AS lm_created
       FROM tasks t
       LEFT JOIN (
         SELECT task_id, id, sender_id, sender_role, type, content, created_at
           FROM task_messages m1
          WHERE m1.id = (SELECT MAX(m2.id) FROM task_messages m2 WHERE m2.task_id = m1.task_id)
       ) lm ON lm.task_id = t.id
       LEFT JOIN agents a ON a.id = lm.sender_id
      WHERE t.assignee_id = ? OR t.creator_id = ?
      ORDER BY t.created_at DESC LIMIT 100`,
    [me, me],
  );
  return (rows as Array<Record<string, unknown>>).map((r) => {
    const last: MessageView | null = r.lm_id === null ? null : {
      id: Number(r.lm_id),
      sender_id: r.lm_sender === null ? null : Number(r.lm_sender),
      sender_role: (r.lm_role as MessageView['sender_role']) ?? 'agent',
      sender_name: (r.lm_sender_name as string | null) ?? null,
      type: (r.lm_type as MessageView['type']) ?? 'chat',
      content: String(r.lm_content),
      created_at: String(r.lm_created),
    };
    // 待我回复：最后消息 sender 不是我（或无消息且我是 assignee）
    const awaitingMe =
      ['open', 'claimed', 'submitted', 'pending_confirm'].includes(String(r.status)) &&
      (last === null ? Number(r.assignee_id) === me : last.sender_id !== me);
    return {
      task_id: String(r.task_id),
      title: String(r.title),
      status: String(r.status),
      workdir: (r.workdir as string | null) ?? null,
      awaiting_me: awaitingMe,
      last_message: last,
      created_at: String(r.created_at),
    };
  });
}

// ─────────────────────────── 会话操作 ───────────────────────────

/** 回复任务（§3.6 reply 吸收 post_message/publish_report/report_progress）：
 * - manual：参与且状态 open/claimed（会话进行中）
 * - scheduled：执行方任意状态可回帖（type=report 作归档，吸收 publish_report）
 * 回复即续期（副作用：刷新 last_activity_at） */
export async function postMessageToTask(
  agent: AgentIdentity,
  taskId: string,
  content: string,
  type: 'chat' | 'progress' | 'report' = 'chat',
): Promise<{ ok: boolean; error?: string }> {
  return withTransaction(async (conn) => {
    const tasks = (await conn.query(
      `SELECT id, status FROM tasks WHERE task_id = ? AND (assignee_id = ? OR creator_id = ?) LIMIT 1
        FOR UPDATE`,
      [taskId, agent.id, agent.id],
    )) as Array<Record<string, unknown>>;
    if (tasks.length === 0) return { ok: false, error: `任务 ${taskId} 不存在或你未参与` };
    const status = String(tasks[0].status);
    if (status !== 'open' && status !== 'claimed') {
      return { ok: false, error: `任务已 ${status}，无法回复` };
    }
    await conn.query(
      `INSERT INTO task_messages (task_id, sender_id, sender_role, type, content) VALUES (?, ?, 'agent', ?, ?)`,
      [tasks[0].id, agent.id, type, content],
    );
    await conn.query(`UPDATE tasks SET last_activity_at = ? WHERE id = ?`, [nowString(), tasks[0].id]);
    return { ok: true };
  });
}

/** 关闭任务（校验参与 + open → resolved；记录关闭者与时间） */
export async function resolveTask(
  agent: AgentIdentity,
  taskId: string,
  finalResult?: string,
): Promise<{ ok: boolean; error?: string }> {
  return withTransaction(async (conn) => {
    const tasks = (await conn.query(
      `SELECT id, status FROM tasks WHERE task_id = ? AND (assignee_id = ? OR creator_id = ?) LIMIT 1
        FOR UPDATE`,
      [taskId, agent.id, agent.id],
    )) as Array<Record<string, unknown>>;
    if (tasks.length === 0) return { ok: false, error: `任务 ${taskId} 不存在或你未参与` };
    const status = String(tasks[0].status);
    if (status !== 'open') return { ok: false, error: `任务已 ${status}，无需关闭` };
    if (finalResult) {
      await conn.query(
        `INSERT INTO task_messages (task_id, sender_id, sender_role, content) VALUES (?, ?, 'system', ?)`,
        [tasks[0].id, agent.id, `[任务已关闭 by ${agent.name}] ${finalResult}`],
      );
    }
    await conn.query(
      `UPDATE tasks SET status='resolved', result=?, result_status='success', result_at=?, last_activity_at=?, resolved_by_id=? WHERE id=?`,
      [finalResult ?? null, nowString(), nowString(), agent.id, tasks[0].id],
    );
    return { ok: true };
  });
}

/** agent 发起任务（MCP create / agent requestTask）：强制从属 plan 的 stage（任务原子化，2026-08-15 编排重构） */
export async function requestTask(
  agent: AgentIdentity,
  assigneeAgentId: string,
  title: string,
  instruction: string,
  workdir?: string | null,
  stageId?: number | null,
): Promise<{ ok: boolean; task_id?: string; error?: string }> {
  return withTransaction(async (conn) => {
    const target = (await conn.query(
      `SELECT id FROM agents WHERE agent_id = ? AND status='active' LIMIT 1`,
      [assigneeAgentId],
    )) as Array<Record<string, unknown>>;
    if (target.length === 0) return { ok: false, error: `目标主机 ${assigneeAgentId} 不存在或已禁用` };
    if (!stageId) return { ok: false, error: '任务必须从属 plan 的 stage（缺少 stage_id）' };
    const stage = (await conn.query(
      `SELECT s.plan_id, s.recurrence FROM plan_stages s WHERE s.id = ? LIMIT 1`,
      [stageId],
    )) as Array<Record<string, unknown>>;
    if (stage.length === 0) return { ok: false, error: 'stage 不存在' };
    if (String(stage[0].recurrence ?? 'none') !== 'none') {
      return { ok: false, error: '定时 stage 不接受手动追加任务（任务由周期自动生成）' };
    }
    const taskId = `T-${yymmdd()}-${randomHex()}`;
    const ins = await conn.query(
      `INSERT INTO tasks (task_id, title, instruction, origin, plan_id, stage_id, creator_id, assignee_id, status, workdir)
       VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, 'open', ?)`,
      [taskId, title, instruction, stage[0].plan_id, stageId, agent.id, target[0].id, workdir?.trim() || null],
    );
    // 首条消息 = 请求内容（task_id 用数字主键）
    await conn.query(
      `INSERT INTO task_messages (task_id, sender_id, sender_role, content) VALUES (?, ?, 'agent', ?)`,
      [Number((ins as unknown as { insertId: unknown }).insertId), agent.id, instruction],
    );
    return { ok: true, task_id: taskId };
  });
}

/** 调度脚本写回实际工作目录（沙箱任务第一回合生成后） */
export async function updateTaskWorkdir(
  agent: AgentIdentity,
  taskId: string,
  workdir: string,
): Promise<{ ok: boolean; error?: string }> {
  const updated = await query(
    `UPDATE tasks SET workdir = ? WHERE task_id = ? AND assignee_id = ? AND workdir IS NULL`,
    [workdir, taskId, agent.id],
  );
  const affected = (updated as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (affected === 0) return { ok: false, error: '任务不存在、你不是执行方，或已设置工作目录' };
  return { ok: true };
}

/** 投递报告到任务（定时任务产出归档）：校验任务属于该 agent，报告直接挂任务下 */
export async function publishReportToTask(
  agent: AgentIdentity,
  taskId: string,
  content: string,
): Promise<{ ok: boolean; task_id?: string; error?: string }> {
  return withTransaction(async (conn) => {
    const tasks = (await conn.query(
      `SELECT id FROM tasks WHERE task_id = ? AND assignee_id = ? LIMIT 1`,
      [taskId, agent.id],
    )) as Array<Record<string, unknown>>;
    if (tasks.length === 0) {
      return { ok: false, error: `任务 ${taskId} 不存在或未指派给当前 agent` };
    }
    await conn.query(
      `INSERT INTO reports (task_id, agent_id, content) VALUES (?, ?, ?)`,
      [tasks[0].id, agent.id, content],
    );
    return { ok: true, task_id: taskId };
  });
}

// ─────────────────────────── 兼容：scheduled 单轮结果 ───────────────────────────

export type SubmitStatus = 'success' | 'failed';

export async function submitTaskResult(
  agent: AgentIdentity,
  taskId: string,
  status: SubmitStatus,
  result: string,
): Promise<{ ok: boolean; error?: string }> {
  const updated = await query(
    `UPDATE tasks
        SET status = ?, result = ?, result_status = ?, result_at = ?, last_activity_at = ?
      WHERE task_id = ? AND assignee_id = ?
        AND status IN ('pending','assigned','running','open','claimed')`,
    [status === 'success' ? 'done' : 'failed', result, status, nowString(), nowString(), taskId, agent.id],
  );
  const affected = (updated as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (affected === 0) {
    return { ok: false, error: `任务 ${taskId} 不存在、未指派给当前 agent，或状态不允许提交（可能已完成）` };
  }
  return { ok: true };
}

/** 长任务续期：刷新最后活跃时间（防超时回收误杀） */
export async function renewTaskActivity(
  agent: AgentIdentity,
  taskId: string,
): Promise<{ ok: boolean; error?: string }> {
  const updated = await query(
    `UPDATE tasks SET last_activity_at = ?
      WHERE task_id = ? AND assignee_id = ? AND status = 'running'`,
    [nowString(), taskId, agent.id],
  );
  const affected = (updated as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (affected === 0) return { ok: false, error: `任务 ${taskId} 不存在、未指派给当前 agent，或不在运行中` };
  return { ok: true };
}

// ─────────────────────────── 交付物（约定 + 版本） ───────────────────────────

export interface DeliverableSpecItem {
  name: string;
  /** 遗留字段：建议路径（§3.7 废止，仅展示） */
  path?: string;
  /** 遗留字段：验收标准（§3.7 后由 LLM 语义校验承担，仅展示） */
  criteria?: string;
  /** §3.7：最少数量（默认 1） */
  min_count?: number;
  /** §3.7：类型约束，如 '.md'（扩展名）或 'text/'（mime 前缀） */
  type?: string;
}

export interface DeliverableView {
  id: number;
  name: string;
  path: string;
  version: string;
  message: string | null;
  current: boolean;
  agent_id: number;
  /** 附件（§3.7）：引用的附件元数据，供展示/下载 */
  attachment: {
    attachment_id: string;
    filename: string;
    mime: string;
    size_bytes: number;
    scan_status: string;
  } | null;
  created_at: string;
}

/** 解析任务的交付物约定（JSON 数组） */
export function parseDeliverableSpec(spec: string | null): DeliverableSpecItem[] {
  if (!spec) return [];
  try {
    const parsed = JSON.parse(spec);
    return Array.isArray(parsed) ? (parsed as DeliverableSpecItem[]) : [];
  } catch {
    return [];
  }
}

/**
 * 验收方案可操作性校验（§3.3 发布硬阻断）：
 * - 数组；每项须有非空 name
 * - min_count 为 >=1 整数（缺省 1）
 * - type 为字符串（'.ext' 或 'mime/prefix'，仅约束不做合法性枚举）
 */
export function validateDeliverableSpec(spec: unknown): { ok: boolean; error?: string } {
  if (spec === undefined || spec === null) return { ok: true };
  let arr: unknown[];
  if (typeof spec === 'string') {
    try {
      arr = JSON.parse(spec);
    } catch {
      return { ok: false, error: '交付物约定必须是 JSON 数组' };
    }
  } else {
    arr = spec as unknown[];
  }
  if (!Array.isArray(arr)) return { ok: false, error: '交付物约定必须是数组' };
  for (const [i, item] of arr.entries()) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, error: `交付物约定第 ${i + 1} 项不是对象` };
    }
    const it = item as Record<string, unknown>;
    if (typeof it.name !== 'string' || !it.name.trim()) {
      return { ok: false, error: `交付物约定第 ${i + 1} 项缺少 name` };
    }
    if (it.min_count !== undefined) {
      const mc = Number(it.min_count);
      if (!Number.isInteger(mc) || mc < 1) {
        return { ok: false, error: `交付物「${it.name}」的 min_count 必须是 >=1 的整数` };
      }
    }
    if (it.type !== undefined && typeof it.type !== 'string') {
      return { ok: false, error: `交付物「${it.name}」的 type 必须是字符串` };
    }
  }
  return { ok: true };
}

/** 任务的交付物约定 + 全部版本记录 */
export async function listDeliverables(taskId: string): Promise<{
  spec: DeliverableSpecItem[];
  versions: DeliverableView[];
}> {
  const tasks = await query(`SELECT deliverable_spec FROM tasks WHERE task_id = ? LIMIT 1`, [taskId]);
  if (tasks.length === 0) return { spec: [], versions: [] };
  const spec = parseDeliverableSpec((tasks[0] as Record<string, unknown>).deliverable_spec as string | null);
  const rows = await query(
    `SELECT d.id, d.name, d.path, d.version, d.message, d.current, d.agent_id, d.created_at,
            a.attachment_id AS att_id, a.filename AS att_filename, a.mime AS att_mime,
            a.size_bytes AS att_size, a.scan_status AS att_scan
       FROM deliverables d
       LEFT JOIN attachments a ON a.id = d.attachment_id
      WHERE d.task_id = (SELECT id FROM tasks WHERE task_id = ?)
      ORDER BY d.name ASC, d.version ASC`,
    [taskId],
  );
  const versions = (rows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    path: String(r.path ?? ''),
    version: String(r.version),
    message: (r.message as string | null) ?? null,
    current: Boolean(r.current),
    agent_id: Number(r.agent_id),
    attachment: r.att_id === null ? null : {
      attachment_id: String(r.att_id),
      filename: String(r.att_filename ?? ''),
      mime: String(r.att_mime ?? ''),
      size_bytes: Number(r.att_size ?? 0),
      scan_status: String(r.att_scan ?? 'skipped'),
    },
    created_at: String(r.created_at),
  }));
  return { spec, versions };
}

/**
 * 提交交付物版本：校验参与任务 + 名称在约定中（若有约定），版本自增（v1→v2…）
 * 旧版本 current=false，新版本 current=true，并刷新任务当前交付版本。
 */
export async function submitDeliverable(
  agent: AgentIdentity,
  taskId: string,
  name: string,
  path: string,
  message?: string,
): Promise<{ ok: boolean; version?: string; error?: string }> {
  return withTransaction(async (conn) => {
    const tasks = (await conn.query(
      `SELECT id, status, deliverable_spec FROM tasks
        WHERE task_id = ? AND (assignee_id = ? OR creator_id = ?) LIMIT 1 FOR UPDATE`,
      [taskId, agent.id, agent.id],
    )) as Array<Record<string, unknown>>;
    if (tasks.length === 0) return { ok: false, error: `任务 ${taskId} 不存在或你未参与` };
    const status = String(tasks[0].status);
    if (status !== 'open' && status !== 'claimed' && status !== 'running' && status !== 'pending' && status !== 'active') {
      return { ok: false, error: `任务已 ${status}，无法提交交付物` };
    }
    // 约定校验：任务有约定时，名称必须对齐
    const spec = parseDeliverableSpec((tasks[0].deliverable_spec as string | null) ?? null);
    if (spec.length > 0 && !spec.some((s) => s.name === name)) {
      return {
        ok: false,
        error: `交付物「${name}」不在任务约定中（约定：${spec.map((s) => s.name).join('、')}）`,
      };
    }
    // 版本自增：取该任务+名称的当前最大版本号
    const maxRow = (await conn.query(
      `SELECT MAX(CAST(REPLACE(version, 'v', '') AS UNSIGNED)) AS max_v
         FROM deliverables WHERE task_id = ? AND name = ?`,
      [tasks[0].id, name],
    )) as Array<Record<string, unknown>>;
    const nextVersion = `v${(Number(maxRow[0].max_v) || 0) + 1}`;
    // 旧版本失效
    await conn.query(`UPDATE deliverables SET current = FALSE WHERE task_id = ? AND name = ?`, [
      tasks[0].id,
      name,
    ]);
    await conn.query(
      `INSERT INTO deliverables (task_id, name, path, version, message, current, agent_id)
       VALUES (?, ?, ?, ?, ?, TRUE, ?)`,
      [tasks[0].id, name, path, nextVersion, message ?? null, agent.id],
    );
    await conn.query(`UPDATE tasks SET deliverable_version = ? WHERE id = ?`, [nextVersion, tasks[0].id]);
    return { ok: true, version: nextVersion };
  });
}

// ─────────────────────────── 工具 ───────────────────────────

function yymmdd(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(now.getFullYear()).slice(2)}${p(now.getMonth() + 1)}${p(now.getDate())}`;
}

function randomHex(): string {
  return randomBytesHex(4);
}

import { randomBytes } from 'node:crypto';
function randomBytesHex(n: number): string {
  return randomBytes(n).toString('hex');
}
