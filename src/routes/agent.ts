import { Router } from 'express';
import multer from 'multer';
import { currentAgent, mcpAuthMiddleware } from '../auth.js';
import {
  claimDueTasks,
  postMessageToTask,
  resolveTask,
  updateTaskWorkdir,
  type SubmitStatus,
} from '../service/tasks.js';
import { claimTask, listPoolTasks } from '../service/market.js';
import {
  attachmentAbsPath,
  attachmentViewById,
  canDownload,
  uploadAttachment,
} from '../service/attachments.js';
import { getSettingInt } from '../service/settings.js';
import { nowString } from '../scheduler.js';
import { sendAttachmentFile } from './attach-shared.js';

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
    accept_external: agent.acceptExternal,
  });
});

// ─────────────────────────── 领取回合（poll） ───────────────────────────
agentRouter.post('/poll', async (_req, res) => {
  const agent = getAgent();
  const tasks = await claimDueTasks(agent);
  res.json({ tasks });
});

// ─────────────────────────── 公共池（§3.2 二段式：程序拉列表 → 有候选才拉起 LLM 判断认领） ───────────────────────────
agentRouter.post('/pool', async (_req, res) => {
  const agent = getAgent();
  const pool = await listPoolTasks(agent);
  res.json({ ok: true, count: pool.length, pool });
});

agentRouter.post('/claim', async (req, res) => {
  const agent = getAgent();
  const body = (req.body ?? {}) as { task_id?: string };
  if (!body.task_id) {
    res.status(400).json({ error: '缺少 task_id' });
    return;
  }
  const r = await claimTask(agent, body.task_id);
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json({ ok: true, task_id: body.task_id, mode: r.mode });
});

// ─────────────────────────── 附件（§3.7）：REST multipart 上传（大文件）/ 下载 ───────────────────────────
// 内存暂存（需要 buffer 计算 sha256）；单文件上限与系统设置一致
const attachUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: getSettingInt('max_attachment_bytes', 50 * 1024 * 1024) },
});

/** 上传大文件（调度脚本/程序用；MCP upload_attachment 处理 ≤5MB 小文件） */
agentRouter.post('/attachments', attachUpload.single('file'), async (req, res) => {
  const agent = getAgent();
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: '缺少 file（multipart 字段名 file）' });
    return;
  }
  const r = await uploadAttachment(agent, {
    filename: file.originalname,
    mime: file.mimetype,
    buffer: file.buffer,
  });
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.status(201).json({
    ok: true,
    attachment_id: r.attachment_id,
    reused: r.reused ?? false,
    filename: file.originalname,
    size_bytes: file.size,
  });
});

/** 下载附件：owner 或参与被引用任务的 agent；无公开 URL */
agentRouter.get('/attachments/:id', async (req, res) => {
  const agent = getAgent();
  const view = await attachmentViewById(req.params.id);
  if (!view) {
    res.status(404).json({ error: '附件不存在' });
    return;
  }
  if (view.scan_status === 'infected') {
    res.status(403).json({ error: '附件被判定为感染，拒绝下载' });
    return;
  }
  if (!(await canDownload(agent.id, req.params.id))) {
    res.status(403).json({ error: '无权限下载该附件（非所属账号，且未被授权参与相关任务）' });
    return;
  }
  const abs = await attachmentAbsPath(req.params.id);
  if (!abs) {
    res.status(404).json({ error: '附件文件缺失' });
    return;
  }
  sendAttachmentFile(res, abs, view.filename, view.mime);
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
