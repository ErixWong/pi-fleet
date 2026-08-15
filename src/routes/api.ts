import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { generateApiKey, hashApiKey, requireAdmin, verifyPassword } from '../auth.js';
import { computeNextDue, nowString, toLocalString } from '../scheduler.js';
import { attachmentAbsPath, attachmentViewById, cleanupOrphanAttachments } from '../service/attachments.js';
import { getSettingInt, getSettingsHistory, settingsView, updateSettings } from '../service/settings.js';
import {
  deleteModel,
  deleteProvider,
  listLlmCalls,
  listModels,
  listProviders,
  scanPendingAudits,
  scanPendingVerifications,
  testLlmConnection,
  upsertModel,
  upsertProvider,
} from '../service/llm.js';
import { createPlan, listPlans, planTree, runPeriodicClones, runStageGates } from '../service/plans.js';
import {
  addChatMessage,
  archiveConversation,
  chatMessagesSince,
  getConversation,
  getOrCreateConversation,
  getTaskContext,
  listChatMessages,
  listConversations,
  setConversationWorkdir,
} from '../service/chat.js';
import { chatHub } from '../ws-server.js';
import { sendAttachmentFile } from './attach-shared.js';

export const apiRouter = Router();
// JSON body parser 只作用于 /api（MCP 端点不走这里，保留原始流给 transport）
apiRouter.use(express.json());

/** 解析分页参数（?page=1&page_size=20） */
function pageParams(q: Record<string, unknown>): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Math.floor(Number(q.page ?? 1)) || 1);
  const pageSize = Math.min(200, Math.max(1, Math.floor(Number(q.page_size ?? 10)) || 10));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** 主机失联判定：从未心跳或超过 agent_offline_after_min 分钟未心跳 → offline（只读标记，不自动禁用） */
function agentOffline(lastSeen: unknown, offlineAfterMin: number): boolean {
  if (!lastSeen) return true;
  const seen = new Date(lastSeen as string | Date).getTime();
  if (!Number.isFinite(seen)) return true;
  return Date.now() - seen > offlineAfterMin * 60 * 1000;
}

// ─────────────────────────── 鉴权辅助 ───────────────────────────
function isAdmin(req: Request): boolean {
  return Boolean((req.session as { admin?: boolean } | undefined)?.admin);
}

function requireAdminJson(req: Request, res: Response, next: NextFunction): void {
  if (isAdmin(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
}

// ─────────────────────────── 登录 / 会话 ───────────────────────────
apiRouter.post('/login', async (req, res) => {
  const { password } = (req.body ?? {}) as { password?: string };
  const rows = await query(`SELECT password_hash FROM admin WHERE id = 1 LIMIT 1`);
  if (rows.length === 0) {
    res.status(500).json({ error: '管理员未初始化，请先运行 npm run init-admin' });
    return;
  }
  const stored = String((rows[0] as Record<string, unknown>).password_hash);
  if (password && verifyPassword(password, stored)) {
    (req.session as { admin?: boolean }).admin = true;
    res.json({ ok: true });
    return;
  }
  res.status(401).json({ error: '密码错误' });
});

apiRouter.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

apiRouter.get('/me', (req, res) => {
  res.json({ admin: isAdmin(req) });
});

// ─────────────────────────── 仪表盘 ───────────────────────────
apiRouter.get('/stats', requireAdminJson, async (_req, res) => {
  const offlineAfterMin = getSettingInt('agent_offline_after_min', 30);
  const [agents, tasks, recentReports, activeAgents] = await Promise.all([
    query(`SELECT status, COUNT(*) AS cnt FROM agents GROUP BY status`),
    query(`SELECT status, COUNT(*) AS cnt FROM tasks GROUP BY status`),
    query(
      `SELECT r.content, r.created_at, a.agent_id, t.task_id
         FROM reports r
         LEFT JOIN agents a ON a.id = r.agent_id
         LEFT JOIN tasks t ON t.id = r.task_id
        ORDER BY r.created_at DESC LIMIT 5`,
    ),
    query(`SELECT id, last_seen_at FROM agents WHERE status = 'active'`),
  ]);
  const offline = (activeAgents as Array<Record<string, unknown>>).filter((a) => agentOffline(a.last_seen_at, offlineAfterMin)).length;
  res.json({
    agents: { ...Object.fromEntries(agents.map((r) => [r.status, Number(r.cnt)])), offline },
    tasks: Object.fromEntries(tasks.map((r) => [r.status, Number(r.cnt)])),
    recentReports,
    offline_after_min: offlineAfterMin,
  });
});

// ─────────────────────────── Agent ───────────────────────────
apiRouter.get('/agents', requireAdminJson, async (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query as Record<string, unknown>);
  const offlineAfterMin = getSettingInt('agent_offline_after_min', 30);
  const totalRows = (await query(`SELECT COUNT(*) AS c FROM agents`)) as Array<Record<string, unknown>>;
  const total = Number(totalRows[0]?.c ?? 0);
  const agents = (await query(
    `SELECT id, agent_id, name, hostname, description, tags, accept_external, status, last_seen_at, created_at
       FROM agents ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [pageSize, offset],
  )) as Array<Record<string, unknown>>;
  const list = agents.map((a) => ({ ...a, offline: agentOffline(a.last_seen_at, offlineAfterMin) }));
  res.json({ agents: list, total, page, page_size: pageSize, offline_after_min: offlineAfterMin });
});

apiRouter.post('/agents', requireAdminJson, async (req, res) => {
  const body = (req.body ?? {}) as {
    name?: string;
    hostname?: string;
    description?: string;
    system_prompt?: string;
    tags?: string;
    /** 接单开关（§3.2/§五）：是否允许认领公共池外单，默认关闭 */
    accept_external?: boolean;
  };
  const name = (body.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: '缺少 agent 名称' });
    return;
  }
  const agentId = `agent-${randomBytes(3).toString('hex')}`;
  const key = generateApiKey();
  // 系统提示词：未填时自动生成（主机视角，用户无需关心 agent 细节）
  const hostname = (body.hostname ?? '').trim();
  const description = (body.description ?? '').trim();
  const customPrompt = (body.system_prompt ?? '').trim();
  const systemPrompt =
    customPrompt ||
    `你是主机「${name}」的 agent（agent_id: ${agentId}）。${hostname ? `位于 ${hostname}。` : ''}${description ? `职责：${description}。` : ''}通过任务分发平台接收任务并执行，完成后汇报结果。`;
  await query(
    `INSERT INTO agents (agent_id, name, hostname, description, system_prompt, tags, accept_external, key_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      agentId,
      name,
      hostname,
      description,
      systemPrompt,
      (body.tags ?? '').trim(),
      body.accept_external ? 1 : 0,
      hashApiKey(key),
    ],
  );
  const rows = await query(
    `SELECT id, agent_id, name, hostname, description, tags, accept_external, status, last_seen_at, created_at
       FROM agents WHERE agent_id = ?`,
    [agentId],
  );
  // key 仅此一次返回（明文只在创建时暴露）
  res.status(201).json({ agent: rows[0], key });
});

apiRouter.get('/agents/:id', requireAdminJson, async (req, res) => {
  const id = Number(req.params.id);
  const rows = await query(
    `SELECT id, agent_id, name, hostname, description, system_prompt, tags, accept_external, status,
            last_seen_at, created_at
       FROM agents WHERE id = ?`,
    [id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'agent 不存在' });
    return;
  }
  const agent = rows[0] as Record<string, unknown>;
  const offlineAfterMin = getSettingInt('agent_offline_after_min', 30);
  agent.offline = agentOffline(agent.last_seen_at, offlineAfterMin);
  const { page, pageSize, offset } = pageParams(req.query as Record<string, unknown>);
  const totalRows = (await query(`SELECT COUNT(*) AS c FROM tasks WHERE assignee_id = ?`, [id])) as Array<Record<string, unknown>>;
  const total = Number(totalRows[0]?.c ?? 0);
  const tasks = await query(
    `SELECT task_id, title, kind, status, next_due_at, result_status
       FROM tasks WHERE assignee_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [id, pageSize, offset],
  );
  res.json({ agent, tasks, total, page, page_size: pageSize, offline_after_min: offlineAfterMin });
});

apiRouter.post('/agents/:id/toggle', requireAdminJson, async (req, res) => {
  const result = await query(
    `UPDATE agents SET status = IF(status='active','disabled','active') WHERE id = ?`,
    [Number(req.params.id)],
  );
  const info = (result as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (info === 0) {
    res.status(404).json({ error: 'agent 不存在' });
    return;
  }
  res.json({ ok: true });
});

/** 重置 agent key：吊销旧 key，生成新 key（一次性返回） */
apiRouter.post('/agents/:id/reset-key', requireAdminJson, async (req, res) => {
  const id = Number(req.params.id);
  const newKey = generateApiKey();
  const result = await query(`UPDATE agents SET key_hash = ? WHERE id = ?`, [hashApiKey(newKey), id]);
  const info = (result as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (info === 0) {
    res.status(404).json({ error: 'agent 不存在' });
    return;
  }
  res.json({ ok: true, key: newKey });
});

/** 接单开关（§3.2/§五）：是否允许该主机认领公共池外单 */
apiRouter.post('/agents/:id/accept-toggle', requireAdminJson, async (req, res) => {
  const result = await query(
    `UPDATE agents SET accept_external = IF(accept_external=1, 0, 1) WHERE id = ?`,
    [Number(req.params.id)],
  );
  const info = (result as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (info === 0) {
    res.status(404).json({ error: 'agent 不存在' });
    return;
  }
  const rows = await query(`SELECT accept_external FROM agents WHERE id = ?`, [Number(req.params.id)]);
  res.json({ ok: true, accept_external: rows.length > 0 ? Number((rows[0] as Record<string, unknown>).accept_external) : 0 });
});

// ─────────────────────────── 任务 ───────────────────────────
/** 生成 task_id：T-yymmdd-8位hex（short uuid，天然唯一，免序号并发冲突） */
function nextTaskId(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const yymmdd = `${String(now.getFullYear()).slice(2)}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  return `T-${yymmdd}-${randomBytes(4).toString('hex')}`;
}

apiRouter.get('/tasks', requireAdminJson, async (req, res) => {
  const { kind, status } = req.query as { kind?: string; status?: string };
  const { page, pageSize, offset } = pageParams(req.query as Record<string, unknown>);
  const params: unknown[] = [];
  let where = ' WHERE 1=1';
  if (kind) {
    where += ' AND t.kind = ?';
    params.push(kind);
  }
  if (status) {
    where += ' AND t.status = ?';
    params.push(status);
  }
  const totalRows = (await query(`SELECT COUNT(*) AS c FROM tasks t${where}`, params)) as Array<Record<string, unknown>>;
  const total = Number(totalRows[0]?.c ?? 0);
  const sql = `
    SELECT t.task_id, t.title, t.kind, t.visibility, t.status, t.schedule_cron, t.next_due_at,
           t.result_status, t.result_at, t.created_at, t.workdir, t.deliver_attempts, t.max_attempts,
           a.id AS assignee_id, a.agent_id AS assignee, a.name AS assignee_name
      FROM tasks t
      LEFT JOIN agents a ON a.id = t.assignee_id
      ${where}
     ORDER BY t.created_at DESC LIMIT ? OFFSET ?`;
  const tasks = await query(sql, [...params, pageSize, offset]);
  const agents = await query(
    `SELECT id, agent_id, name, hostname FROM agents WHERE status='active' ORDER BY name`,
  );
  res.json({ tasks, agents, total, page, page_size: pageSize });
});

apiRouter.post('/tasks', requireAdminJson, async (req, res) => {
  const body = (req.body ?? {}) as {
    title?: string;
    instruction?: string;
    plan_id?: string | number;
    stage_id?: string | number;
    assignee_id?: string | number;
    /** 可见性（§3.2）：默认 private；public = 丢公共池待认领 */
    visibility?: string;
    workdir?: string;
    deliverable_spec?: unknown;
  };
  const title = (body.title ?? '').trim();
  const instruction = (body.instruction ?? '').trim();
  const planId = body.plan_id ? Number(body.plan_id) : null;
  const stageId = body.stage_id ? Number(body.stage_id) : null;
  const assigneeId = body.assignee_id ? Number(body.assignee_id) : null;
  const visibility: 'private' | 'public' = body.visibility === 'public' ? 'public' : 'private';
  if (!title || !instruction) {
    res.status(400).json({ error: '缺少标题或指令' });
    return;
  }
  // 强制三层：任务必须从属 plan 的 stage（2026-08-15 编排模型重构；旧 kind='scheduled' 入口废弃，定时由 stage 负责）
  if (!planId || !stageId) {
    res.status(400).json({ error: '任务必须从属 plan 的 stage（缺少 plan_id 或 stage_id）' });
    return;
  }

  // 验收方案 schema 程序校验（§3.3 发布硬阻断）
  const { validateDeliverableSpec } = await import('../service/tasks.js');
  const specCheck = validateDeliverableSpec(body.deliverable_spec);
  if (!specCheck.ok) {
    res.status(400).json({ error: specCheck.error });
    return;
  }

  try {
    await withTransaction(async (conn) => {
      const taskId = nextTaskId();
      const workdir = (body.workdir ?? '').trim() || null;
      // 交付物约定：数组 → JSON 字符串落库
      const deliverableSpec =
        body.deliverable_spec === undefined || body.deliverable_spec === null
          ? null
          : typeof body.deliverable_spec === 'string'
            ? (body.deliverable_spec as string).trim() || null
            : JSON.stringify(body.deliverable_spec);

      // 校验 stage 属于 plan；定时 stage 禁止手动追加（只收周期生成）
      const stRows = (await conn.query(
        `SELECT s.recurrence FROM plan_stages s WHERE s.id = ? AND s.plan_id = ? LIMIT 1`,
        [stageId, planId],
      )) as Array<Record<string, unknown>>;
      if (stRows.length === 0) {
        throw new Error('stage 不存在或不属于该 plan');
      }
      if (String(stRows[0].recurrence ?? 'none') !== 'none') {
        throw new Error('定时 stage 不接受手动追加任务（任务由周期自动生成）');
      }
      {
        // manual：有指派 → 协作会话（open）；无指派 + public → 公共池（active 待认领）；
        // 配置了 LLM → 先过 pending_audit 审核（§3.4）
        if (!assigneeId && visibility !== 'public') {
          throw new Error('指派任务必须选择 agent；或设 visibility=public 丢入公共池待认领');
        }
        const { llmConfigured } = await import('../service/llm.js');
        const llmOn = await llmConfigured();
        const status = llmOn ? 'pending_audit' : assigneeId ? 'open' : 'active';
        const ins = await conn.query(
          `INSERT INTO tasks (task_id, title, instruction, origin, visibility, plan_id, stage_id, assignee_id, status, workdir, deliverable_spec)
           VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`,
          [taskId, title, instruction, visibility, planId, stageId, assigneeId, status, workdir, deliverableSpec],
        );
        await conn.query(
          `INSERT INTO task_messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'admin', 'chat', ?)`,
          [Number((ins as unknown as { insertId: unknown }).insertId), instruction],
        );
        if (!llmOn) {
          await conn.query(
            `INSERT INTO task_messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'platform', 'verdict', ?)`,
            [Number((ins as unknown as { insertId: unknown }).insertId), '[平台] LLM 审核未配置，降级放行（未经 LLM 审核）；任务已发布'],
          );
        }
      }
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  res.status(201).json({ ok: true });
});

apiRouter.get('/tasks/:taskId', requireAdminJson, async (req, res) => {
  const rows = await query(
    `SELECT t.*, a.agent_id AS assignee, a.name AS assignee_name,
            c.agent_id AS creator_agent_id, c.name AS creator_name,
            rby.agent_id AS resolved_by_agent_id, rby.name AS resolved_by_name
       FROM tasks t
       LEFT JOIN agents a ON a.id = t.assignee_id
       LEFT JOIN agents c ON c.id = t.creator_id
       LEFT JOIN agents rby ON rby.id = t.resolved_by_id
      WHERE t.task_id = ? LIMIT 1`,
    [req.params.taskId],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  const task = rows[0] as Record<string, unknown>;
  const reports = await query(
    `SELECT r.content, r.created_at, a.agent_id, a.name AS sender_name, a.hostname AS sender_hostname
       FROM reports r LEFT JOIN agents a ON a.id = r.agent_id
      WHERE r.task_id = ? ORDER BY r.created_at DESC LIMIT 10`,
    [task.id],
  );
  // 协作会话：返回消息流（分页：倒序取最新一页，前端反转成正序渲染）
  const mPage = Math.max(1, Math.floor(Number(req.query.messages_page ?? 1)) || 1);
  const mPageSize = Math.min(200, Math.max(1, Math.floor(Number(req.query.messages_page_size ?? 10)) || 10));
  const mTotalRows = (await query(`SELECT COUNT(*) AS c FROM task_messages WHERE task_id = ?`, [task.id])) as Array<Record<string, unknown>>;
  const messagesTotal = Number(mTotalRows[0]?.c ?? 0);
  const messages = await query(
    `SELECT m.id, m.sender_id, m.sender_role, m.type, a.name AS sender_name, a.hostname AS sender_hostname, m.content, m.created_at
       FROM task_messages m LEFT JOIN agents a ON a.id = m.sender_id
      WHERE m.task_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
    [task.id, mPageSize, (mPage - 1) * mPageSize],
  );
  // 交付物：约定（解析为数组）+ 版本记录
  const { listDeliverables } = await import('../service/tasks.js');
  const deliverables = await listDeliverables(String(task.task_id));
  res.json({ task, reports, messages, deliverables, messages_total: messagesTotal, messages_page: mPage, messages_page_size: mPageSize });
});

// 管理员回复协作任务
apiRouter.post('/tasks/:taskId/reply', requireAdminJson, async (req, res) => {
  const body = (req.body ?? {}) as { content?: string };
  if (!body.content) {
    res.status(400).json({ error: '缺少 content' });
    return;
  }
  const task = await query(`SELECT id, status FROM tasks WHERE task_id = ? LIMIT 1`, [req.params.taskId]);
  if (task.length === 0) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  if (!['open', 'claimed'].includes(String(task[0].status))) {
    res.status(400).json({ error: `任务已 ${task[0].status}，无法回复` });
    return;
  }
  await query(`INSERT INTO task_messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'admin', 'chat', ?)`, [
    task[0].id,
    body.content,
  ]);
  await query(`UPDATE tasks SET last_activity_at = ? WHERE id = ?`, [nowString(), task[0].id]);
  res.json({ ok: true });
});

// 管理员关闭协作任务（关闭者=管理员，resolved_by_id NULL）
// 终态统一（§3.4 映射）：验收链路（submitted/pending_confirm）通过 → done；遗留 open/claimed 会话 → resolved
apiRouter.post('/tasks/:taskId/resolve', requireAdminJson, async (req, res) => {
  const body = (req.body ?? {}) as { final_result?: string };
  const rows = await query(`SELECT id, status FROM tasks WHERE task_id = ? LIMIT 1`, [req.params.taskId]);
  if (rows.length === 0) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  const tid = rows[0].id;
  const status = String(rows[0].status);
  if (!['open', 'claimed', 'submitted', 'pending_confirm'].includes(status)) {
    res.status(400).json({ error: `任务已 ${status}，无法验收` });
    return;
  }
  const terminal = ['submitted', 'pending_confirm'].includes(status) ? 'done' : 'resolved';
  const result = await query(
    `UPDATE tasks SET status=?, result=?, result_status='success', result_at=?, resolved_by_id=NULL
      WHERE task_id = ? AND status = ?`,
    [terminal, body.final_result ?? null, nowString(), req.params.taskId, status],
  );
  const info = (result as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (info === 0) {
    res.status(400).json({ error: '任务状态已变化，请刷新重试' });
    return;
  }
  if (body.final_result?.trim()) {
    await query(
      `INSERT INTO task_messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'admin', 'verdict', ?)`,
      [tid, `[验收通过 by 管理员] ${body.final_result.trim()}`],
    );
  }
  res.json({ ok: true, status: terminal });
});

// 管理员验收打回（§3.3 续做回路）：打回 → claimed，deliver_attempts+1，超上限 → failed。
// 状态读取+更新+回帖包在同一事务，避免半完成状态（UPDATE 生效而回帖失败）。
apiRouter.post('/tasks/:taskId/reject', requireAdminJson, async (req, res) => {
  const body = (req.body ?? {}) as { opinion?: string };
  const opinion = (body.opinion ?? '').trim();
  if (!opinion) {
    res.status(400).json({ error: '缺少打回意见 opinion' });
    return;
  }
  try {
    const outcome = await withTransaction(async (conn) => {
      const rows = (await conn.query(
        `SELECT id, status, deliver_attempts, max_attempts FROM tasks WHERE task_id = ? LIMIT 1 FOR UPDATE`,
        [req.params.taskId],
      )) as Array<Record<string, unknown>>;
      if (rows.length === 0) return { status: 404, error: '任务不存在' };
      const t = rows[0] as Record<string, unknown>;
      if (!['open', 'claimed', 'submitted', 'pending_confirm'].includes(String(t.status))) {
        return { status: 400, error: `任务已 ${t.status}，无法打回` };
      }
      const attempts = Number(t.deliver_attempts) + 1;
      const maxAttempts = Number(t.max_attempts) || 3;
      const terminal = attempts >= maxAttempts ? 'failed' : 'claimed';
      await conn.query(`UPDATE tasks SET status=?, deliver_attempts=? WHERE id = ?`, [terminal, attempts, t.id]);
      await conn.query(
        `INSERT INTO task_messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'admin', 'verdict', ?)`,
        [
          t.id,
          `[验收打回 by 管理员] ${opinion}（第 ${attempts}/${maxAttempts} 次，请按原因续做；任务目录保留=工作现场保留）`,
        ],
      );
      return { status: 200, data: { ok: true, status: terminal, attempts } };
    });
    if (outcome.status !== 200) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    res.json(outcome.data);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

apiRouter.post('/tasks/:taskId/cancel', requireAdminJson, async (req, res) => {
  // failed 可取消 = 跳过（不阻塞闸门，§编排五）；blocked 可取消为闸门死锁兜底
  const result = await query(
    `UPDATE tasks SET status = 'cancelled' WHERE task_id = ? AND status IN ('pending','active','claimed','submitted','pending_confirm','assigned','running','open','failed','blocked')`,
    [req.params.taskId],
  );
  const info = (result as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (info === 0) {
    res.status(400).json({ error: '任务不存在或状态不允许取消' });
    return;
  }
  res.json({ ok: true });
});

// ─────────────────────────── 编排：plan（§编排：人建 / 树视图 / failed 处置 / 交付物可见性） ───────────────────────────
/** plan 列表 */
apiRouter.get('/plans', requireAdminJson, async (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query as Record<string, unknown>);
  const totalRows = (await query(`SELECT COUNT(*) AS c FROM plans`)) as Array<Record<string, unknown>>;
  const total = Number(totalRows[0]?.c ?? 0);
  const plans = await listPlans(pageSize, offset);
  res.json({ plans, total, page, page_size: pageSize });
});

/** 创建 plan（stages + tasks 一次性定义；仅人建） */
apiRouter.post('/plans', requireAdminJson, async (req, res) => {
  const body = (req.body ?? {}) as {
    name?: string;
    stages?: { name?: string; wait_prev?: number | boolean; recurrence?: string; window_start?: string; window_end?: string; tasks?: { title?: string; instruction?: string; deliverable_spec?: unknown; visibility?: string; assignee?: string }[] }[];
  };
  try {
    const r = await createPlan(
      null, // 管理员创建（creator_agent_id=null）
      {
        name: body.name ?? '',
        stages: (body.stages ?? []).map((s) => ({
          name: s.name ?? '',
          wait_prev: s.wait_prev,
          recurrence: s.recurrence,
          window_start: s.window_start,
          window_end: s.window_end,
          tasks: (s.tasks ?? []).map((t) => ({
            title: t.title ?? '',
            instruction: t.instruction ?? '',
            deliverable_spec: t.deliverable_spec,
            visibility: t.visibility as 'private' | 'public' | undefined,
            assignee: t.assignee,
          })),
        })),
      },
    );
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.status(201).json({ ok: true, plan_id: r.plan_id });
  } catch (err) {
    // createPlan 内部校验错误（如私有任务缺执行方）经事务回滚后抛出——必须转 400，否则未捕获异常会崩掉整个进程
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** plan 树视图（当前 stage 高亮、后续置灰、stalled 可见） */
apiRouter.get('/plans/:planId', requireAdminJson, async (req, res) => {
  const r = await planTree(req.params.planId);
  if (!r.ok) {
    res.status(404).json({ error: r.error });
    return;
  }
  res.json({ plan: r.plan });
});

/** failed 处置共用：落点 SQL（reopen 与 reassign 仅在有指派兜底上不同）+ 留痕回帖 */
const REOPEN_LANDING = `IF(visibility='public' OR assignee_id IS NULL, 'active', 'open')`;
const REASSIGN_LANDING = `IF(visibility='public', 'active', 'open')`;

/** 处置后读回落点并写 verdict 回帖（message 中 {s} 占位落点状态） */
async function reportFailedDisposition(taskId: string, landingExpr: string, message: string): Promise<string> {
  const st = await query(`SELECT ${landingExpr} AS s FROM tasks WHERE task_id = ?`, [taskId]);
  const s = String((st[0] as Record<string, unknown> | undefined)?.s ?? 'open');
  await query(
    `INSERT INTO task_messages (task_id, sender_id, sender_role, type, content) VALUES ((SELECT id FROM tasks WHERE task_id = ?), NULL, 'admin', 'verdict', ?)`,
    [taskId, message.replace('{s}', s)],
  );
  return s;
}

/** 重开任务（failed/done/cancelled/resolved 皆可）：attempts 清零、清结果，按落点回 open（private+assignee）/ active（public）
 *  终态重开用于补充信息——恢复 agent 回帖通道（postMessageToTask 仅限 open/claimed） */
apiRouter.post('/tasks/:taskId/reopen', requireAdminJson, async (req, res) => {
  const rows = await query(`SELECT status FROM tasks WHERE task_id = ? LIMIT 1`, [req.params.taskId]);
  const prev = String((rows[0] as Record<string, unknown> | undefined)?.status ?? '');
  if (!['failed', 'done', 'cancelled', 'resolved'].includes(prev)) {
    res.status(400).json({ error: '任务不存在或不是可重开状态（failed/done/cancelled/resolved）' });
    return;
  }
  await query(
    `UPDATE tasks SET status = ${REOPEN_LANDING},
            deliver_attempts=0, result=NULL, result_status=NULL, result_at=NULL, last_activity_at=?
      WHERE task_id = ?`,
    [nowString(), req.params.taskId],
  );
  const s = await reportFailedDisposition(
    req.params.taskId,
    REOPEN_LANDING,
    prev === 'failed'
      ? '[处置] 发起人重开：尝试次数清零，任务回到 {s}'
      : `[处置] 管理员重开任务（原 ${prev}，补充信息）：回到 {s}，可继续交流`,
  );
  res.json({ ok: true, status: s, from: prev });
});

/** failed 处置：改派 assignee（留痕回帖）。改派后直接落 open/active（P3-2：不再需要 reopen 两步） */
apiRouter.post('/tasks/:taskId/reassign', requireAdminJson, async (req, res) => {
  const body = (req.body ?? {}) as { assignee_agent_id?: string };
  const target = await query(`SELECT id, name FROM agents WHERE agent_id = ? AND status='active' LIMIT 1`, [
    body.assignee_agent_id,
  ]);
  if (target.length === 0) {
    res.status(400).json({ error: '目标主机不存在或已禁用' });
    return;
  }
  const result = await query(
    `UPDATE tasks SET assignee_id = ?, status = ${REASSIGN_LANDING},
            deliver_attempts = 0, last_activity_at = ?
      WHERE task_id = ? AND status = 'failed'`,
    [target[0].id, nowString(), req.params.taskId],
  );
  const info = (result as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (info === 0) {
    res.status(400).json({ error: '任务不存在或不是 failed 状态' });
    return;
  }
  const s = await reportFailedDisposition(
    req.params.taskId,
    REASSIGN_LANDING,
    `[处置] 发起人改派执行方为 ${target[0].name}（${body.assignee_agent_id}），尝试次数清零，任务回到 {s}`,
  );
  res.json({ ok: true, status: s });
});

/** 交付物可见性改档（§编排八：可改，改档留痕回帖；回溯改变存量交付物暴露面） */
apiRouter.post('/tasks/:taskId/deliverable-visibility', requireAdminJson, async (req, res) => {
  const body = (req.body ?? {}) as { value?: string };
  const value = body.value;
  if (!['participants', 'account', 'public'].includes(String(value))) {
    res.status(400).json({ error: 'value 须为 participants / account / public' });
    return;
  }
  const rows = await query(`SELECT id, deliverable_visibility FROM tasks WHERE task_id = ? LIMIT 1`, [
    req.params.taskId,
  ]);
  if (rows.length === 0) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  const old = String((rows[0] as Record<string, unknown>).deliverable_visibility);
  await query(`UPDATE tasks SET deliverable_visibility = ? WHERE task_id = ?`, [value, req.params.taskId]);
  await query(
    `INSERT INTO task_messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'admin', 'verdict', ?)`,
    [rows[0].id, `[交付物可见性] ${old} → ${value}（改档回溯改变存量交付物暴露面）`],
  );
  res.json({ ok: true, value });
});

// ─────────────────────────── 系统设置（§3.4/§3.7）：附件 / LLM / 提示词 panel ───────────────────────────
/** 读全部设置（api_key 掩码回显） */
apiRouter.get('/settings', requireAdminJson, async (_req, res) => {
  res.json({ settings: settingsView() });
});

/** 批量更新设置（提示词修改自动留痕 settings_history） */
apiRouter.put('/settings', requireAdminJson, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const entries: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'string') entries[k] = v;
  }
  await updateSettings(entries, 'admin');
  res.json({ ok: true, settings: settingsView() });
});

/** 测试 LLM 连接（可选：指定模型 / provider+模型串 / provider / 默认第一个可用模型；不落库配置） */
apiRouter.post('/settings/llm-test', requireAdminJson, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const r = await testLlmConnection({
    model_id: typeof body.model_id === 'string' ? body.model_id : undefined,
    provider_id: typeof body.provider_id === 'string' ? body.provider_id : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
  });
  res.json(r);
});

/** Provider 列表（api_key 掩码回显） */
apiRouter.get('/settings/llm-providers', requireAdminJson, async (_req, res) => {
  res.json({ providers: await listProviders() });
});

/** 新增/更新 provider（api_key 空串或 ****** = 不改，保留原值） */
apiRouter.put('/settings/llm-providers', requireAdminJson, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const r = await upsertProvider({
    id: String(body.id ?? ''),
    name: String(body.name ?? ''),
    base_url: String(body.base_url ?? ''),
    api_key: String(body.api_key ?? ''),
    note: String(body.note ?? ''),
    enabled: body.enabled !== false,
  });
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json({ ok: true, id: r.id, providers: await listProviders() });
});

/** 删除 provider（其下仍有模型时拒绝） */
apiRouter.delete('/settings/llm-providers/:id', requireAdminJson, async (req, res) => {
  const r = await deleteProvider(req.params.id);
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json({ ok: true, providers: await listProviders() });
});

/** 模型列表 */
apiRouter.get('/settings/llm-models', requireAdminJson, async (_req, res) => {
  const models = await listModels();
  res.json({ models });
});

/** 新增/更新模型（挂在 provider 下；api_key 由 provider 继承，模型行不再持有） */
apiRouter.put('/settings/llm-models', requireAdminJson, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const r = await upsertModel({
    id: String(body.id ?? ''),
    provider_id: String(body.provider_id ?? ''),
    name: String(body.name ?? ''),
    model: String(body.model ?? ''),
    vision: body.vision === true || body.vision === 1,
    temperature: body.temperature === undefined || body.temperature === null || body.temperature === '' ? null : Number(body.temperature),
    price: String(body.price ?? ''),
    note: String(body.note ?? ''),
    enabled: body.enabled !== false,
  });
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json({ ok: true, models: await listModels() });
});

/** 删除模型 */
apiRouter.delete('/settings/llm-models/:id', requireAdminJson, async (req, res) => {
  const r = await deleteModel(req.params.id);
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json({ ok: true, models: await listModels() });
});

/** 调用日志（分页：?page=1&page_size=20；成本留痕：provider/模型/用途/任务/tokens/价格） */
apiRouter.get('/settings/llm-calls', requireAdminJson, async (req, res) => {
  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.page_size ?? 10);
  const r = await listLlmCalls(page, pageSize);
  res.json({ calls: r.items, total: r.total, page, page_size: pageSize });
});

/** 立即扫描队列（审核/验收 + 编排闸门/周期克隆；LLM 未配置时降级处理） */
apiRouter.post('/settings/llm-scan', requireAdminJson, async (_req, res) => {
  const [audit, verify, gates, clones] = await Promise.all([
    scanPendingAudits(),
    scanPendingVerifications(),
    runStageGates(),
    runPeriodicClones(),
  ]);
  res.json({
    ok: true,
    audit: { processed: audit.audited, rejected: audit.rejected, degraded: audit.degraded },
    verify: { processed: verify.verified, passed: verify.passed, failed: verify.failed, degraded: verify.degraded },
    plan: { gates_released: gates, clones: clones },
  });
});

/** 提示词/设置修改留痕历史（分页：?page=1&page_size=20；§3.4：改人/改时/前值） */
apiRouter.get('/settings/history', requireAdminJson, async (req, res) => {
  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.page_size ?? 10);
  const r = await getSettingsHistory(page, pageSize);
  res.json({ history: r.items, total: r.total, page, page_size: pageSize });
});

// ─────────────────────────── 附件（§3.7）：管理端浏览/预览/清理 ───────────────────────────
/** 管理端下载/预览附件（人侧浏览；上传是 agent 通道） */
apiRouter.get('/attachments/:id', requireAdminJson, async (req, res) => {
  const view = await attachmentViewById(req.params.id);
  if (!view) {
    res.status(404).json({ error: '附件不存在' });
    return;
  }
  if (view.scan_status === 'infected') {
    res.status(403).json({ error: '附件被判定为感染，拒绝下载' });
    return;
  }
  const abs = await attachmentAbsPath(req.params.id);
  if (!abs) {
    res.status(404).json({ error: '附件文件缺失' });
    return;
  }
  sendAttachmentFile(res, abs, view.filename, view.mime);
});

/** 清理孤儿附件（未被任何交付物引用，释放配额） */
apiRouter.post('/attachments/cleanup', requireAdminJson, async (_req, res) => {
  const cleaned = await cleanupOrphanAttachments();
  res.json({ ok: true, cleaned });
});

// ─────────────────────────── 全局动态（最新产出/回复，分页） ───────────────────────────
apiRouter.get('/activity', requireAdminJson, async (req, res) => {
  const page = Math.max(1, Math.floor(Number(req.query.page ?? 1)));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(req.query.page_size ?? 10))));
  const inner = `(SELECT 'report' AS type, r.created_at, a.agent_id AS who, t.task_id, r.content AS content
        FROM reports r
        LEFT JOIN agents a ON a.id = r.agent_id
        LEFT JOIN tasks t ON t.id = r.task_id)
     UNION ALL
     (SELECT 'message' AS type, m.created_at, a.agent_id AS who, t.task_id, m.content AS content
        FROM task_messages m
        LEFT JOIN agents a ON a.id = m.sender_id
        LEFT JOIN tasks t ON t.id = m.task_id)`;
  const totalRows = (await query(`SELECT COUNT(*) AS c FROM (${inner}) t`)) as Array<Record<string, unknown>>;
  const total = Number(totalRows[0]?.c ?? 0);
  const activity = (await query(
    `SELECT * FROM (${inner}) t ORDER BY created_at DESC, type LIMIT ? OFFSET ?`,
    [pageSize, (page - 1) * pageSize],
  )) as Array<Record<string, unknown>>;
  res.json({ activity, total, page, page_size: pageSize });
});

// ─────────────────────────── 对话通道（管理员 ↔ agent 独立对话） ───────────────────────────
/** 对话列表 */
apiRouter.get('/conversations', requireAdminJson, async (req, res) => {
  const { page, pageSize } = pageParams(req.query as Record<string, unknown>);
  const r = await listConversations(page, pageSize);
  res.json({ conversations: r.items, total: r.total, page, page_size: pageSize });
});

/** 发起对话（同 agent 已有 open 对话 → 返回现有，幂等；task_id 可选：从任务发起时关联上下文；workdir 可选：远程 pi 在该路径下运行，须为 ~ 开头限制在 home 下） */
apiRouter.post('/conversations', requireAdminJson, async (req, res) => {
  const agentId = Number((req.body ?? {}).agent_id);
  if (!agentId) {
    res.status(400).json({ error: '缺少 agent_id' });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const taskIdRaw = body.task_id;
  const taskId = taskIdRaw === undefined || taskIdRaw === null || taskIdRaw === '' ? undefined : String(taskIdRaw);
  const workdirRaw = body.workdir;
  const workdir = workdirRaw === undefined || workdirRaw === null || workdirRaw === '' ? undefined : String(workdirRaw);
  if (workdir !== undefined && !/^~[\/\\]|^\/|^[A-Za-z]:[\/\\]/.test(workdir)) {
    res.status(400).json({ error: '工作目录须为 ~/ 开头（限制在主机 home 下）或绝对路径（由主机校验是否在 home 内）' });
    return;
  }
  const agentRows = (await query(`SELECT id FROM agents WHERE id = ?`, [agentId])) as Array<Record<string, unknown>>;
  if (agentRows.length === 0) {
    res.status(404).json({ error: '主机不存在' });
    return;
  }
  const conversation = await getOrCreateConversation(agentId, taskId, workdir);
  res.json({ conversation });
});

/** 更新对话工作目录（远程 pi 下次回复在该路径下运行；限制在主机 home 下） */
apiRouter.post('/conversations/:id/workdir', requireAdminJson, async (req, res) => {
  const raw = (req.body ?? {}).workdir;
  const workdir = raw === undefined || raw === null || raw === '' ? null : String(raw);
  if (workdir !== null && !/^~[\/\\]|^\/|^[A-Za-z]:[\/\\]/.test(workdir)) {
    res.status(400).json({ error: '工作目录须为 ~/ 开头（限制在主机 home 下）或绝对路径' });
    return;
  }
  const conv = await getConversation(req.params.id);
  if (!conv) {
    res.status(404).json({ error: '对话不存在' });
    return;
  }
  await setConversationWorkdir(req.params.id, workdir);
  res.json({ ok: true, workdir });
});

/** 对话历史（正序分页） */
apiRouter.get('/conversations/:id/messages', requireAdminJson, async (req, res) => {
  const { page, pageSize } = pageParams(req.query as Record<string, unknown>);
  const conv = await getConversation(req.params.id);
  if (!conv) {
    res.status(404).json({ error: '对话不存在' });
    return;
  }
  const r = await listChatMessages(req.params.id, page, pageSize);
  res.json({ messages: r.items, total: r.total, page, page_size: pageSize });
});

/** 增量拉取（打字机轮询：since_id 之后的消息） */
apiRouter.get('/conversations/:id/messages/since', requireAdminJson, async (req, res) => {
  const since = Math.max(0, Number(req.query.since_id ?? 0));
  const conv = await getConversation(req.params.id);
  if (!conv) {
    res.status(404).json({ error: '对话不存在' });
    return;
  }
  const messages = await chatMessagesSince(req.params.id, since);
  res.json({ messages });
});

/** 管理员发消息（落库 + 推送 agent 桥接器） */
apiRouter.post('/conversations/:id/messages', requireAdminJson, async (req, res) => {
  const content = String((req.body ?? {}).content ?? '').trim();
  if (!content) {
    res.status(400).json({ error: '消息不能为空' });
    return;
  }
  const conv = await getConversation(req.params.id);
  if (!conv) {
    res.status(404).json({ error: '对话不存在' });
    return;
  }
  const message = await addChatMessage(req.params.id, 'admin', content);
  // 推送给 agent 桥接器（在线才推；离线由桥接器 chat-check 兜底）；带任务上下文 + 工作目录
  const task = conv.task_id ? await getTaskContext(conv.task_id) : null;
  chatHub.publishToAgent(Number(conv.agent_id), { type: 'conv_new_message', conversation_id: req.params.id, content, task, workdir: conv.workdir });
  res.json({ message });
});

/** 归档对话 */
apiRouter.post('/conversations/:id/archive', requireAdminJson, async (req, res) => {
  const ok = await archiveConversation(req.params.id);
  res.json({ ok });
});
