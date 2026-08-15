import { query } from '../db.js';
import { nowString } from '../scheduler.js';

/**
 * 独立对话通道（任务外管理员↔agent 直接对话）：
 * - conversations：对话头（对象 agent / 状态 open|archived）
 * - chat_messages：消息（谁/说了啥/何时；streaming=1 为 pi 流式中间态，0=最终落库）
 * - 与 task_messages（任务内帖子流）完全解耦
 */

export interface ConversationView {
  id: string;
  conversation_id: string;
  agent_id: string;
  agent_name: string;
  task_id: string | null;
  task_title: string | null;
  task_status: string | null;
  workdir: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  last_message: string | null;
  last_sender: string | null;
}

export interface ChatMessageView {
  id: string;
  conversation_id: string;
  sender_role: 'admin' | 'agent';
  content: string;
  streaming: boolean;
  created_at: string;
}

/** 管理端对话列表（含 agent 名与最后消息） */
export async function listConversations(page = 1, pageSize = 10): Promise<{ items: ConversationView[]; total: number }> {
  const pageNum = Math.max(1, Math.floor(page));
  const size = Math.min(100, Math.max(1, Math.floor(pageSize)));
  const totalRows = (await query(`SELECT COUNT(*) AS c FROM conversations`)) as Array<Record<string, unknown>>;
  const total = Number(totalRows[0]?.c ?? 0);
  const rows = (await query(
    `SELECT c.id, c.conversation_id, c.agent_id, a.name AS agent_name, c.task_id, t.title AS task_title, t.status AS task_status,
            c.workdir, c.status, c.created_at, c.updated_at,
            lm.content AS last_message, lm.sender_role AS last_sender
       FROM conversations c
       LEFT JOIN agents a ON a.id = c.agent_id
       LEFT JOIN tasks t ON t.task_id = c.task_id
       LEFT JOIN (
         SELECT conversation_id, content, sender_role FROM chat_messages m1
          WHERE m1.id = (SELECT MAX(m2.id) FROM chat_messages m2 WHERE m2.conversation_id = m1.conversation_id)
       ) lm ON lm.conversation_id = c.conversation_id
      ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`,
    [size, (pageNum - 1) * size],
  )) as Array<Record<string, unknown>>;
  return { items: rows.map(toConv), total };
}

function toConv(r: Record<string, unknown>): ConversationView {
  return {
    id: String(r.id),
    conversation_id: String(r.conversation_id),
    agent_id: String(r.agent_id),
    agent_name: String(r.agent_name ?? ''),
    task_id: r.task_id === null || r.task_id === undefined ? null : String(r.task_id),
    task_title: r.task_title === null || r.task_title === undefined ? null : String(r.task_title),
    task_status: r.task_status === null || r.task_status === undefined ? null : String(r.task_status),
    workdir: r.workdir === null || r.workdir === undefined ? null : String(r.workdir),
    status: String(r.status),
    created_at: String(r.created_at ?? ''),
    updated_at: String(r.updated_at ?? ''),
    last_message: r.last_message === null || r.last_message === undefined ? null : String(r.last_message),
    last_sender: r.last_sender === null || r.last_sender === undefined ? null : String(r.last_sender),
  };
}

/** 获取对话（校验归属 agent 时传 agentId） */
export async function getConversation(convId: string, agentId?: number): Promise<ConversationView | null> {
  const rows = (await query(
    `SELECT c.id, c.conversation_id, c.agent_id, a.name AS agent_name, c.task_id, t.title AS task_title,
            c.workdir, c.status, c.created_at, c.updated_at
       FROM conversations c LEFT JOIN agents a ON a.id = c.agent_id LEFT JOIN tasks t ON t.task_id = c.task_id
      WHERE c.conversation_id = ?${agentId ? ' AND c.agent_id = ?' : ''} LIMIT 1`,
    agentId ? [convId, agentId] : [convId],
  )) as Array<Record<string, unknown>>;
  return rows.length > 0 ? toConv(rows[0]) : null;
}

/** 发起对话：带 task_id → 只复用该任务的 open 对话（没有就新建，任务独立上下文）；不带 → 复用同 agent 的 open 对话 */
/** 发起对话：
 *  带 task_id → 任务对话：复用该任务的 open 对话（没有就新建，任务独立上下文）
 *  不带 task_id → 主机对话：**固定 conversation_id conv-host-{agentId}，永远同一个 session**——
 *  刷新/多网页/归档后重开都是同一个对话（归档自动恢复 open），记忆不断 */
export async function getOrCreateConversation(agentId: number, taskId?: string, workdir?: string): Promise<ConversationView> {
  if (!taskId) {
    const convId = `conv-host-${agentId}`;
    const exist = (await query(
      `SELECT conversation_id, status FROM conversations WHERE conversation_id = ? LIMIT 1`,
      [convId],
    )) as Array<Record<string, unknown>>;
    if (exist.length > 0) {
      // 归档后重开 → 恢复 open（保持同一个 session）
      if (String(exist[0].status) === 'archived') {
        await query(`UPDATE conversations SET status = 'open' WHERE conversation_id = ?`, [convId]);
      }
      if (workdir !== undefined) {
        await query(`UPDATE conversations SET workdir = ? WHERE conversation_id = ?`, [workdir ?? null, convId]);
      }
      const c = await getConversation(convId);
      if (c) return c;
    }
    await query(`INSERT INTO conversations (conversation_id, agent_id, workdir) VALUES (?, ?, ?)`, [convId, agentId, workdir ?? null]);
    const c = await getConversation(convId);
    if (!c) throw new Error('对话创建失败');
    return c;
  }
  // 任务对话：**固定 conversation_id conv-task-{taskId}，永远同一个 session**——刷新/多网页/归档后重开都是同一个对话
  const convId = `conv-task-${taskId}`;
  const exist = (await query(
    `SELECT conversation_id, status FROM conversations WHERE conversation_id = ? LIMIT 1`,
    [convId],
  )) as Array<Record<string, unknown>>;
  if (exist.length > 0) {
    if (String(exist[0].status) === 'archived') {
      await query(`UPDATE conversations SET status = 'open' WHERE conversation_id = ?`, [convId]);
    }
    if (workdir !== undefined) {
      await query(`UPDATE conversations SET workdir = ? WHERE conversation_id = ?`, [workdir ?? null, convId]);
    }
    const c = await getConversation(convId);
    if (c) return c;
  }
  await query(`INSERT INTO conversations (conversation_id, agent_id, task_id, workdir) VALUES (?, ?, ?, ?)`, [convId, agentId, taskId, workdir ?? null]);
  const c = await getConversation(convId);
  if (!c) throw new Error('对话创建失败');
  return c;
}

/** 对话历史（正序，分页） */
export async function listChatMessages(convId: string, page = 1, pageSize = 20): Promise<{ items: ChatMessageView[]; total: number }> {
  const pageNum = Math.max(1, Math.floor(page));
  const size = Math.min(100, Math.max(1, Math.floor(pageSize)));
  const totalRows = (await query(`SELECT COUNT(*) AS c FROM chat_messages WHERE conversation_id = ?`, [convId])) as Array<Record<string, unknown>>;
  const total = Number(totalRows[0]?.c ?? 0);
  const rows = (await query(
    `SELECT id, conversation_id, sender_role, content, streaming, created_at
       FROM chat_messages WHERE conversation_id = ?
      ORDER BY id ASC LIMIT ? OFFSET ?`,
    [convId, size, (pageNum - 1) * size],
  )) as Array<Record<string, unknown>>;
  return { items: rows.map(toMsg), total };
}

function toMsg(r: Record<string, unknown>): ChatMessageView {
  return {
    id: String(r.id),
    conversation_id: String(r.conversation_id),
    sender_role: (r.sender_role as 'admin' | 'agent') ?? 'agent',
    content: String(r.content ?? ''),
    streaming: Number(r.streaming) === 1,
    created_at: String(r.created_at ?? ''),
  };
}

/** 发消息（管理员或 agent），返回消息；写入后刷新 conversation.updated_at */
export async function addChatMessage(convId: string, sender: 'admin' | 'agent', content: string): Promise<ChatMessageView> {
  const ins = (await query(
    `INSERT INTO chat_messages (conversation_id, sender_role, content, streaming) VALUES (?, ?, ?, 0)`,
    [convId, sender, content],
  )) as unknown as { insertId: unknown };
  await query(`UPDATE conversations SET updated_at = NOW() WHERE conversation_id = ?`, [convId]);
  const rows = (await query(
    `SELECT id, conversation_id, sender_role, content, streaming, created_at FROM chat_messages WHERE id = ?`,
    [Number(ins.insertId)],
  )) as Array<Record<string, unknown>>;
  return toMsg(rows[0]);
}

/** 流式写入：不存在活动流 → 先 INSERT streaming=1；否则 UPDATE 累积内容 */
export async function appendStreaming(convId: string, delta: string): Promise<ChatMessageView> {
  const active = (await query(
    `SELECT id, content FROM chat_messages WHERE conversation_id = ? AND streaming = 1 ORDER BY id DESC LIMIT 1`,
    [convId],
  )) as Array<Record<string, unknown>>;
  if (active.length > 0) {
    await query(`UPDATE chat_messages SET content = CONCAT(content, ?) WHERE id = ?`, [delta, Number(active[0].id)]);
  } else {
    await query(`INSERT INTO chat_messages (conversation_id, sender_role, content, streaming) VALUES (?, 'agent', ?, 1)`, [convId, delta]);
  }
  await query(`UPDATE conversations SET updated_at = NOW() WHERE conversation_id = ?`, [convId]);
  const rows = (await query(
    `SELECT id, conversation_id, sender_role, content, streaming, created_at FROM chat_messages WHERE conversation_id = ? AND streaming = 1 ORDER BY id DESC LIMIT 1`,
    [convId],
  )) as Array<Record<string, unknown>>;
  return toMsg(rows[0]);
}

/** 流式结束：置 streaming=0 最终落库 */
export async function finalizeStreaming(convId: string): Promise<ChatMessageView | null> {
  await query(`UPDATE chat_messages SET streaming = 0 WHERE conversation_id = ? AND streaming = 1`, [convId]);
  const rows = (await query(
    `SELECT id, conversation_id, sender_role, content, streaming, created_at FROM chat_messages WHERE conversation_id = ? AND streaming = 1 ORDER BY id DESC LIMIT 1`,
    [convId],
  )) as Array<Record<string, unknown>>;
  // 上面 UPDATE 后 streaming 已为 0，取最近一条 agent 消息
  const last = (await query(
    `SELECT id, conversation_id, sender_role, content, streaming, created_at FROM chat_messages WHERE conversation_id = ? AND sender_role='agent' ORDER BY id DESC LIMIT 1`,
    [convId],
  )) as Array<Record<string, unknown>>;
  return last.length > 0 ? toMsg(last[0]) : null;
}

/** agent 端回合检测（零副作用）：我参与的 open 对话里，最后一条是 admin 发的 → 轮到我回复 */
export async function chatCheck(agentId: number): Promise<Array<{ conversation_id: string; last_message: string | null }>> {
  const rows = (await query(
    `SELECT c.conversation_id, lm.content AS last_message
       FROM conversations c
       LEFT JOIN (
         SELECT conversation_id, content, sender_role FROM chat_messages m1
          WHERE m1.id = (SELECT MAX(m2.id) FROM chat_messages m2 WHERE m2.conversation_id = m1.conversation_id)
       ) lm ON lm.conversation_id = c.conversation_id
      WHERE c.agent_id = ? AND c.status = 'open' AND lm.sender_role = 'admin'
      ORDER BY c.updated_at DESC LIMIT 5`,
    [agentId],
  )) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ conversation_id: String(r.conversation_id), last_message: r.last_message === null ? null : String(r.last_message) }));
}

/** 归档对话 */
export async function archiveConversation(convId: string): Promise<boolean> {
  const r = (await query(`UPDATE conversations SET status = 'archived' WHERE conversation_id = ?`, [convId])) as unknown as { affectedRows?: number };
  return Number(r.affectedRows ?? 0) > 0;
}

/** 最近消息（打字机轮询：sinceId 及之后；用 >= 让 streaming 行内容更新可重复拉到，前端按 id 合并） */
export async function chatMessagesSince(convId: string, sinceId: number): Promise<ChatMessageView[]> {
  const rows = (await query(
    `SELECT id, conversation_id, sender_role, content, streaming, created_at
       FROM chat_messages WHERE conversation_id = ? AND id >= ? ORDER BY id ASC LIMIT 50`,
    [convId, sinceId],
  )) as Array<Record<string, unknown>>;
  return rows.map(toMsg);
}

export { nowString };

/** 更新对话工作目录（远程 pi 下次回复在该路径下运行） */
export async function setConversationWorkdir(convId: string, workdir: string | null): Promise<boolean> {
  const r = (await query(`UPDATE conversations SET workdir = ? WHERE conversation_id = ?`, [workdir, convId])) as unknown as { affectedRows?: number };
  return Number(r.affectedRows ?? 0) > 0;
}

/** 任务上下文（对话绑定任务时，供 agent/桥接器注入 prompt：明确讨论的是哪个任务） */
export async function getTaskContext(taskId: string): Promise<{
  task_id: string;
  title: string;
  status: string;
  instruction_short: string;
  assignee_name: string | null;
} | null> {
  const rows = (await query(
    `SELECT t.task_id, t.title, t.status, LEFT(t.instruction, 300) AS instruction_short, a.name AS assignee_name
       FROM tasks t LEFT JOIN agents a ON a.id = t.assignee_id
      WHERE t.task_id = ? LIMIT 1`,
    [taskId],
  )) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    task_id: String(r.task_id),
    title: String(r.title ?? ''),
    status: String(r.status ?? ''),
    instruction_short: String(r.instruction_short ?? ''),
    assignee_name: r.assignee_name === null ? null : String(r.assignee_name),
  };
}
