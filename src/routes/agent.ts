import { Router } from 'express';
import { currentAgent, mcpAuthMiddleware } from '../auth.js';
import {
  claimDueTasks,
  postMessageToTask,
  resolveTask,
  updateTaskWorkdir,
  type SubmitStatus,
} from '../service/tasks.js';
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

// ─────────────────────────── 心跳 / 身份 ───────────────────────────
agentRouter.post('/heartbeat', async (_req, res) => {
  const agent = getAgent();
  res.json({ ok: true, agent_id: agent.agentId, server_time: nowString() });
});

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

// ─────────────────────────── 领取回合（poll） ───────────────────────────
agentRouter.post('/poll', async (_req, res) => {
  const agent = getAgent();
  const tasks = await claimDueTasks(agent);
  res.json({ tasks });
});

// ─────────────────────────── 会话操作（REST 版，调度脚本兜底用） ───────────────────────────
agentRouter.post('/tasks/reply', async (req, res) => {
  const agent = getAgent();
  const body = (req.body ?? {}) as { task_id?: string; content?: string };
  if (!body.task_id || !body.content) {
    res.status(400).json({ error: '缺少 task_id 或 content' });
    return;
  }
  const r = await postMessageToTask(agent, body.task_id, body.content);
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json({ ok: true, task_id: body.task_id });
});

agentRouter.post('/tasks/resolve', async (req, res) => {
  const agent = getAgent();
  const body = (req.body ?? {}) as { task_id?: string; final_result?: string };
  if (!body.task_id) {
    res.status(400).json({ error: '缺少 task_id' });
    return;
  }
  const r = await resolveTask(agent, body.task_id, body.final_result);
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json({ ok: true, task_id: body.task_id, status: 'resolved' });
});

/** 调度脚本写回实际工作目录（沙箱任务第一回合创建目录后调用） */
agentRouter.post('/tasks/workdir', async (req, res) => {
  const agent = getAgent();
  const body = (req.body ?? {}) as { task_id?: string; workdir?: string };
  if (!body.task_id || !body.workdir) {
    res.status(400).json({ error: '缺少 task_id 或 workdir' });
    return;
  }
  const r = await updateTaskWorkdir(agent, body.task_id, body.workdir);
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json({ ok: true, task_id: body.task_id, workdir: body.workdir });
});

// ─────────────────────────── 兼容：定时任务单轮结果 ───────────────────────────
agentRouter.post('/tasks/result', async (req, res) => {
  const agent = getAgent();
  const body = (req.body ?? {}) as { task_id?: string; status?: string; result?: string };
  if (!body.task_id || (body.status !== 'success' && body.status !== 'failed')) {
    res.status(400).json({ error: '缺少 task_id 或 status(success|failed)' });
    return;
  }
  const { submitTaskResult } = await import('../service/tasks.js');
  const r = await submitTaskResult(agent, body.task_id, body.status as SubmitStatus, body.result ?? '');
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json({ ok: true, task_id: body.task_id });
});

agentRouter.post('/tasks/renew', async (req, res) => {
  const agent = getAgent();
  const body = (req.body ?? {}) as { task_id?: string };
  if (!body.task_id) {
    res.status(400).json({ error: '缺少 task_id' });
    return;
  }
  const { renewTaskActivity } = await import('../service/tasks.js');
  const r = await renewTaskActivity(agent, body.task_id);
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json({ ok: true, task_id: body.task_id });
});

// ─────────────────────────── 报告投递（挂任务） ───────────────────────────
agentRouter.post('/tasks/report', async (req, res) => {
  const agent = getAgent();
  const body = (req.body ?? {}) as { task_id?: string; content?: string };
  if (!body.task_id || !body.content) {
    res.status(400).json({ error: '缺少 task_id 或 content' });
    return;
  }
  const { publishReportToTask } = await import('../service/tasks.js');
  const data = await publishReportToTask(agent, body.task_id, body.content);
  if (!data.ok) {
    res.status(400).json({ error: data.error });
    return;
  }
  res.json(data);
});
