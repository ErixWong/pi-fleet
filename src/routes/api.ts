import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { generateApiKey, hashApiKey, requireAdmin, verifyPassword } from '../auth.js';
import { computeNextDue, toLocalString } from '../scheduler.js';
import { attachmentAbsPath, attachmentViewById, cleanupOrphanAttachments } from '../service/attachments.js';
import { getSettingsHistory, settingsView, updateSettings } from '../service/settings.js';
import {
  deleteModel,
  listLlmCalls,
  listModels,
  scanPendingAudits,
  scanPendingVerifications,
  testLlmConnection,
  upsertModel,
} from '../service/llm.js';
import { sendAttachmentFile } from './attach-shared.js';

export const apiRouter = Router();
// JSON body parser 只作用于 /api（MCP 端点不走这里，保留原始流给 transport）
apiRouter.use(express.json());

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
  const [agents, tasks, recentReports] = await Promise.all([
    query(`SELECT status, COUNT(*) AS cnt FROM agents GROUP BY status`),
    query(`SELECT status, COUNT(*) AS cnt FROM tasks GROUP BY status`),
    query(
      `SELECT r.content, r.created_at, a.agent_id, t.task_id
         FROM reports r
         LEFT JOIN agents a ON a.id = r.agent_id
         LEFT JOIN tasks t ON t.id = r.task_id
        ORDER BY r.created_at DESC LIMIT 5`,
    ),
  ]);
  res.json({
    agents: Object.fromEntries(agents.map((r) => [r.status, Number(r.cnt)])),
    tasks: Object.fromEntries(tasks.map((r) => [r.status, Number(r.cnt)])),
    recentReports,
  });
});

// ─────────────────────────── Agent ───────────────────────────
apiRouter.get('/agents', requireAdminJson, async (_req, res) => {
  const agents = await query(
    `SELECT id, agent_id, name, hostname, description, tags, accept_external, status, last_seen_at, created_at
       FROM agents ORDER BY created_at DESC`,
  );
  res.json({ agents });
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
  const tasks = await query(
    `SELECT task_id, title, kind, status, next_due_at, result_status
       FROM tasks WHERE assignee_id = ? ORDER BY created_at DESC LIMIT 20`,
    [id],
  );
  res.json({ agent, tasks });
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
  const params: unknown[] = [];
  let sql = `
    SELECT t.task_id, t.title, t.kind, t.visibility, t.status, t.schedule_cron, t.next_due_at,
           t.result_status, t.result_at, t.created_at, t.workdir, t.deliver_attempts, t.max_attempts,
           a.agent_id AS assignee, a.name AS assignee_name
      FROM tasks t
      LEFT JOIN agents a ON a.id = t.assignee_id
     WHERE 1=1`;
  if (kind) {
    sql += ' AND t.kind = ?';
    params.push(kind);
  }
  if (status) {
    sql += ' AND t.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY t.created_at DESC LIMIT 200';
  const tasks = await query(sql, params);
  const agents = await query(
    `SELECT id, agent_id, name, hostname FROM agents WHERE status='active' ORDER BY name`,
  );
  res.json({ tasks, agents });
});

apiRouter.post('/tasks', requireAdminJson, async (req, res) => {
  const body = (req.body ?? {}) as {
    kind?: string;
    title?: string;
    instruction?: string;
    assignee_id?: string | number;
    /** 可见性（§3.2）：默认 private；public = 丢公共池待认领 */
    visibility?: string;
    schedule_cron?: string;
    window_start?: string;
    window_end?: string;
    workdir?: string;
    deliverable_spec?: unknown;
  };
  const kind = body.kind === 'scheduled' ? 'scheduled' : 'manual';
  const title = (body.title ?? '').trim();
  const instruction = (body.instruction ?? '').trim();
  const assigneeId = body.assignee_id ? Number(body.assignee_id) : null;
  const visibility: 'private' | 'public' = body.visibility === 'public' ? 'public' : 'private';
  if (!title || !instruction) {
    res.status(400).json({ error: '缺少标题或指令' });
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

      if (kind === 'scheduled') {
        const cron = (body.schedule_cron ?? 'daily').trim() || 'daily';
        const ws = (body.window_start ?? '').trim() || '03:00';
        const we = (body.window_end ?? '').trim() || '06:00';
        if (!assigneeId) {
          throw new Error('定时任务必须指派给一个 agent');
        }
        const nextDue = computeNextDue(cron, ws, we, new Date());
        await conn.query(
          `INSERT INTO tasks (task_id, title, instruction, kind, visibility, assignee_id, status,
                              schedule_cron, window_start, window_end, next_due_at, workdir, deliverable_spec)
           VALUES (?, ?, ?, 'scheduled', ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
          [taskId, title, instruction, visibility, assigneeId, cron, ws, we, toLocalString(nextDue), workdir, deliverableSpec],
        );
      } else {
        // manual：有指派 → 协作会话（open）；无指派 + public → 公共池（active 待认领）；
        // 配置了 LLM → 先过 pending_audit 审核（§3.4）
        if (!assigneeId && visibility !== 'public') {
          throw new Error('指派任务必须选择 agent；或设 visibility=public 丢入公共池待认领');
        }
        const { llmConfigured } = await import('../service/llm.js');
        const llmOn = await llmConfigured();
        const status = llmOn ? 'pending_audit' : assigneeId ? 'open' : 'active';
        const ins = await conn.query(
          `INSERT INTO tasks (task_id, title, instruction, kind, visibility, assignee_id, status, workdir, deliverable_spec)
           VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?)`,
          [taskId, title, instruction, visibility, assigneeId, status, workdir, deliverableSpec],
        );
        await conn.query(
          `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'admin', 'chat', ?)`,
          [Number((ins as unknown as { insertId: unknown }).insertId), instruction],
        );
        if (!llmOn) {
          await conn.query(
            `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'platform', 'verdict', ?)`,
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
    `SELECT r.content, r.created_at, a.agent_id
       FROM reports r LEFT JOIN agents a ON a.id = r.agent_id
      WHERE r.task_id = ? ORDER BY r.created_at DESC LIMIT 10`,
    [task.id],
  );
  // 协作会话：返回消息流
  const messages = await query(
    `SELECT m.id, m.sender_id, m.sender_role, m.type, a.name AS sender_name, m.content, m.created_at
       FROM messages m LEFT JOIN agents a ON a.id = m.sender_id
      WHERE m.task_id = ? ORDER BY m.created_at ASC, m.id ASC`,
    [task.id],
  );
  // 交付物：约定（解析为数组）+ 版本记录
  const { listDeliverables } = await import('../service/tasks.js');
  const deliverables = await listDeliverables(String(task.task_id));
  res.json({ task, reports, messages, deliverables });
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
  await query(`INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'admin', 'chat', ?)`, [
    task[0].id,
    body.content,
  ]);
  await query(`UPDATE tasks SET last_activity_at = NOW() WHERE id = ?`, [task[0].id]);
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
    `UPDATE tasks SET status=?, result=?, result_status='success', result_at=NOW(), resolved_by_id=NULL
      WHERE task_id = ? AND status = ?`,
    [terminal, body.final_result ?? null, req.params.taskId, status],
  );
  const info = (result as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (info === 0) {
    res.status(400).json({ error: '任务状态已变化，请刷新重试' });
    return;
  }
  if (body.final_result?.trim()) {
    await query(
      `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'admin', 'verdict', ?)`,
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
        `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'admin', 'verdict', ?)`,
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
  const result = await query(
    `UPDATE tasks SET status = 'cancelled' WHERE task_id = ? AND status IN ('pending','active','claimed','submitted','pending_confirm','assigned','running','open')`,
    [req.params.taskId],
  );
  const info = (result as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (info === 0) {
    res.status(400).json({ error: '任务不存在或状态不允许取消' });
    return;
  }
  res.json({ ok: true });
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

/** 测试 LLM 连接（可选指定模型 id；不落库配置） */
apiRouter.post('/settings/llm-test', requireAdminJson, async (req, res) => {
  const body = (req.body ?? {}) as { model_id?: string };
  const r = await testLlmConnection(body.model_id);
  res.json(r);
});

/** 模型列表 */
apiRouter.get('/settings/llm-models', requireAdminJson, async (_req, res) => {
  const models = await listModels();
  res.json({ models });
});

/** 新增/更新模型（api_key 空串 = 不改，保留原值） */
apiRouter.put('/settings/llm-models', requireAdminJson, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const r = await upsertModel({
    id: String(body.id ?? ''),
    name: String(body.name ?? ''),
    base_url: String(body.base_url ?? ''),
    model: String(body.model ?? ''),
    api_key: String(body.api_key ?? ''),
    vision: body.vision === true || body.vision === 1,
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

/** 调用日志（成本留痕：模型/用途/任务/tokens/价格） */
apiRouter.get('/settings/llm-calls', requireAdminJson, async (_req, res) => {
  const calls = await listLlmCalls(50);
  res.json({ calls });
});

/** 立即扫描审核/验收队列（pending_audit + submitted；LLM 未配置时降级处理） */
apiRouter.post('/settings/llm-scan', requireAdminJson, async (_req, res) => {
  const [audit, verify] = await Promise.all([scanPendingAudits(), scanPendingVerifications()]);
  res.json({
    ok: true,
    audit: { processed: audit.audited, rejected: audit.rejected, degraded: audit.degraded },
    verify: { processed: verify.verified, passed: verify.passed, failed: verify.failed, degraded: verify.degraded },
  });
});

/** 提示词修改留痕历史（§3.4：改人/改时/前值） */
apiRouter.get('/settings/history', requireAdminJson, async (_req, res) => {
  const history = await getSettingsHistory(50);
  res.json({ history });
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

// ─────────────────────────── 全局动态（最新产出/回复） ───────────────────────────
apiRouter.get('/activity', requireAdminJson, async (_req, res) => {
  const activity = await query(
    `(SELECT 'report' AS type, r.created_at, a.agent_id AS who, t.task_id, r.content AS content
        FROM reports r
        LEFT JOIN agents a ON a.id = r.agent_id
        LEFT JOIN tasks t ON t.id = r.task_id)
     UNION ALL
     (SELECT 'message' AS type, m.created_at, a.agent_id AS who, t.task_id, m.content AS content
        FROM messages m
        LEFT JOIN agents a ON a.id = m.sender_id
        LEFT JOIN tasks t ON t.id = m.task_id)
     ORDER BY created_at DESC LIMIT 10`,
  );
  res.json({ activity });
});
