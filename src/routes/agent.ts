import { Router, type Request, type Response, type NextFunction } from 'express';
import { query } from '../db.js';
import { currentAgent, mcpAuthMiddleware } from '../auth.js';
import { claimDueTasks, renewTaskActivity, submitTaskResult, type SubmitStatus } from '../service/tasks.js';
import { nowString } from '../scheduler.js';

/**
 * Agent 侧 REST API（调度脚本/闹钟使用，Bearer key 认证）。
 * 与 MCP 工具共用同一套业务逻辑（service/tasks.ts）。
 */
export const agentRouter = Router();

// 复用 MCP 的 Bearer key 认证中间件（校验 key → touchAgent → 注入 ALS 身份）
agentRouter.use(mcpAuthMiddleware);

/** 从 ALS 取当前 agent（mcpAuthMiddleware 已保证存在） */
function getAgent() {
  const agent = currentAgent();
  if (!agent) throw new Error('unauthenticated');
  return agent;
}

// ─────────────────────────── 心跳 ───────────────────────────
agentRouter.post('/heartbeat', async (_req, res) => {
  const agent = getAgent();
  res.json({ ok: true, agent_id: agent.agentId, server_time: nowString() });
});

// ─────────────────────────── 身份 ───────────────────────────
agentRouter.post('/info', async (_req, res) => {
  const agent = getAgent();
  res.json({
    agent_id: agent.agentId,
    name: agent.name,
    hostname: agent.hostname,
    tags: agent.tags,
    system_prompt: agent.systemPrompt,
  });
});

// ─────────────────────────── 查到期任务（放行） ───────────────────────────
agentRouter.post('/poll', async (_req, res) => {
  const agent = getAgent();
  const tasks = await claimDueTasks(agent);
  res.json({ tasks });
});

// ─────────────────────────── 回传结果 ───────────────────────────
agentRouter.post('/tasks/result', async (req, res) => {
  const agent = getAgent();
  const body = (req.body ?? {}) as { task_id?: string; status?: string; result?: string };
  if (!body.task_id || (body.status !== 'success' && body.status !== 'failed')) {
    res.status(400).json({ error: '缺少 task_id 或 status(success|failed)' });
    return;
  }
  const r = await submitTaskResult(agent, body.task_id, body.status as SubmitStatus, body.result ?? '');
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json({ ok: true, task_id: body.task_id });
});

// ─────────────────────────── 长任务续期 ───────────────────────────
agentRouter.post('/tasks/renew', async (req, res) => {
  const agent = getAgent();
  const body = (req.body ?? {}) as { task_id?: string };
  if (!body.task_id) {
    res.status(400).json({ error: '缺少 task_id' });
    return;
  }
  const r = await renewTaskActivity(agent, body.task_id);
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json({ ok: true, task_id: body.task_id });
});

// ─────────────────────────── 报告投递（调度脚本也可投报告） ───────────────────────────
agentRouter.post('/reports', async (req, res) => {
  const agent = getAgent();
  const body = (req.body ?? {}) as { topic?: string; content?: string; task_id?: string };
  if (!body.topic || !body.content) {
    res.status(400).json({ error: '缺少 topic 或 content' });
    return;
  }
  // 主题不存在则创建；关联任务（若提供）校验属于当前 agent
  const { withTransaction } = await import('../db.js');
  const data = await withTransaction(async (conn) => {
    const topics = await conn.query(`SELECT id FROM topics WHERE topic = ? LIMIT 1`, [body.topic]);
    let topicId: number;
    if ((topics as unknown[]).length === 0) {
      const ins = await conn.query(`INSERT INTO topics (topic) VALUES (?)`, [body.topic]);
      topicId = Number((ins as unknown as { insertId: unknown }).insertId);
    } else {
      topicId = Number(((topics as unknown[])[0] as { id: unknown }).id);
    }
    let taskId: number | null = null;
    if (body.task_id) {
      const tasks = await conn.query(
        `SELECT id FROM tasks WHERE task_id = ? AND assignee_id = ? LIMIT 1`,
        [body.task_id, agent.id],
      );
      if ((tasks as unknown[]).length > 0) {
        taskId = Number(((tasks as unknown[])[0] as { id: unknown }).id);
      }
    }
    await conn.query(`INSERT INTO reports (topic_id, task_id, agent_id, content) VALUES (?, ?, ?, ?)`, [
      topicId, taskId, agent.id, body.content,
    ]);
    return { ok: true, topic: body.topic };
  });
  res.json(data);
});
