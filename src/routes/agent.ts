import { Router } from 'express';
import multer from 'multer';
import { currentAgent, mcpAuthMiddleware } from '../auth.js';
import { query } from '../db.js';
import {
  claimDueTasks,
  postMessageToTask,
  resolveTask,
  updateTaskWorkdir,
  type SubmitStatus,
} from '../service/tasks.js';
import { addChatMessage, chatCheck, getConversation, getTaskContext, listChatMessages, setAgentProjects } from '../service/chat.js';
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

// ─────────────────────────── 心跳 / 身份 / 目录上报 ───────────────────────────
agentRouter.post('/heartbeat', async (_req, res) => {
  const agent = getAgent();
  res.json({ ok: true, agent_id: agent.agentId, server_time: nowString() });
});

/** 上报主机 ~/projects 下目录列表（bridge 常驻调用；创建主机会话时供选择工作目录） */
agentRouter.post('/projects', async (req, res) => {
  const agent = getAgent();
  const body = (req.body ?? {}) as { dirs?: unknown[]; clis?: unknown[] };
  const hasDirs = Object.prototype.hasOwnProperty.call(body, 'dirs');
  const hasClis = Object.prototype.hasOwnProperty.call(body, 'clis');
  const dirs = Array.isArray(body.dirs) ? body.dirs.map(String) : [];
  const supportedClis = new Set(['pi', 'erix', 'copilot', 'claude', 'codex']);
  const clis = Array.isArray(body.clis)
    ? [...new Set(body.clis.map((cli) => String(cli).trim().toLowerCase()).filter((cli) => supportedClis.has(cli)))]
    : [];
  if (hasDirs) await setAgentProjects(agent.id, dirs);
  if (hasClis) {
    await query(`DELETE FROM agent_clis WHERE agent_id = ?`, [agent.id]);
    for (const cli of clis) {
      await query(`REPLACE INTO agent_clis (agent_id, cli) VALUES (?, ?)`, [agent.id, cli]);
    }
  }
  res.json({ ok: true, count: dirs.length, clis });
});

/** 读取平台为本机指定的执行器；空值表示继续使用客户端本地配置。 */
agentRouter.post('/config', async (_req, res) => {
  const agent = getAgent();
  const rows = (await query(`SELECT agent_cli FROM agents WHERE id = ? LIMIT 1`, [agent.id])) as Array<Record<string, unknown>>;
  res.json({ agent_cli: rows.length > 0 && rows[0].agent_cli ? String(rows[0].agent_cli) : null });
});

// ─────────────────────────── 独立对话通道（chat bridge / 兜底轮询） ───────────────────────────
/** 对话回合检测（零副作用，供 WS 断线兜底/chat-check 轮询） */
agentRouter.post('/chat-check', async (_req, res) => {
  const agent = getAgent();
  const conversations = await chatCheck(agent.id);
  res.json({ conversations });
});

/** 拉对话历史 + 任务上下文（pi 上下文重建；归属校验） */
agentRouter.post('/chat-messages', async (req, res) => {
  const agent = getAgent();
  const convId = String((req.body ?? {}).conversation_id ?? '');
  const conv = await getConversation(convId, agent.id);
  if (!conv) {
    res.status(404).json({ error: '对话不存在' });
    return;
  }
  const r = await listChatMessages(convId, 1, 100);
  const task = conv.task_id ? await getTaskContext(conv.task_id) : null;
  res.json({ conversation: conv, messages: r.items, task });
});

/** agent 回复落库（非流式路径；流式走 WS conv_stream*） */
agentRouter.post('/chat-reply', async (req, res) => {
  const agent = getAgent();
  const convId = String((req.body ?? {}).conversation_id ?? '');
  const content = String((req.body ?? {}).content ?? '').trim();
  if (!content) {
    res.status(400).json({ error: '内容为空' });
    return;
  }
  const conv = await getConversation(convId, agent.id);
  if (!conv) {
    res.status(404).json({ error: '对话不存在' });
    return;
  }
  const message = await addChatMessage(convId, 'agent', content);
  res.json({ ok: true, message });
});

/**
 * 对话回合检测（零副作用，供 agent 侧常驻监听器 1-2s 高频轮询，零 token）：
 * 只读查询“我参与、未终结、最后一条消息是管理员发的”任务 → 管理员刚点名，轮到我回话。
 * 判定用 sender_role='admin'：管理员消息 sender_id 为 NULL（不能按 sender_id 比较）；
 * platform 回帖（审核/闸门）不触发对话。与 poll 不同：chat-check 零副作用，可高频调用。
 */
agentRouter.post('/chat-check', async (_req, res) => {
  const agent = getAgent();
  const rows = await query(
    `SELECT t.task_id, t.title, t.status, t.workdir
       FROM tasks t
       LEFT JOIN (
         SELECT task_id, sender_role FROM task_messages m1
          WHERE m1.id = (SELECT MAX(m2.id) FROM task_messages m2 WHERE m2.task_id = m1.task_id)
       ) lm ON lm.task_id = t.id
      WHERE (t.assignee_id = ? OR t.creator_id = ?)
        AND t.status NOT IN ('done','failed','cancelled','resolved','rejected')
        AND lm.sender_role = 'admin'
      ORDER BY t.id DESC LIMIT 5`,
    [agent.id, agent.id],
  );
  res.json({ tasks: rows });
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
  const body = (req.body ?? {}) as {
    task_id?: string;
    status?: string;
    result?: string;
    deliverables?: Array<{ name: string; path?: string; attachment_id?: string; message?: string }>;
  };
  if (!body.task_id || (body.status !== 'success' && body.status !== 'failed')) {
    res.status(400).json({ error: '缺少 task_id 或 status(success|failed)' });
    return;
  }
  // success：走完整提交验收链（交付物版本登记 + 程序预检 + LLM 验收，§3.6 submit 语义）
  if (body.status === 'success') {
    const { submitForReview } = await import('../service/market.js');
    const r = await submitForReview(agent, body.task_id, body.result ?? '', body.deliverables ?? []);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.json({ ok: true, task_id: body.task_id, status: r.status, reason: r.reason ?? null });
    return;
  }
  // failed：直接置失败（result_status=failed）
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
