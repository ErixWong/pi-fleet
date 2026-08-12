import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { currentAgent } from '../auth.js';
import { claimDueTasks, renewTaskActivity, submitTaskResult } from '../service/tasks.js';

/**
 * 创建 MCP Server 实例并注册全部工具。
 * SDK 1.30 的 Server.connect() 仅支持单 transport，因此每个 MCP 会话
 * 必须使用独立的 Server 实例（routes/mcp.ts 中按会话创建）。
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'task-dispatch', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerTools(server);
  return server;
}

/** 工具结果文本（JSON，便于 agent 解析） */
function text(content: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [
      { type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) },
    ],
  };
}

function requireAgent() {
  const agent = currentAgent();
  if (!agent) throw new Error('unauthenticated: no agent in context');
  return agent;
}

function registerTools(server: McpServer): void {
  // ─────────────────────────── whoami ───────────────────────────
  server.tool(
    'whoami',
    '返回当前 agent 的身份信息：agent_id、名称、主机标识、角色标签、默认提示词。',
    {},
    async () => {
      const agent = requireAgent();
      return text({
        agent_id: agent.agentId,
        name: agent.name,
        hostname: agent.hostname,
        tags: agent.tags,
        system_prompt: agent.systemPrompt,
      });
    },
  );

  // ─────────────────────────── list_my_tasks ───────────────────────────
  server.tool(
    'list_my_tasks',
    '列出指派给当前 agent 的任务（含手动任务与定时任务）。可按状态过滤：pending/assigned/running/done/failed。',
    { status: z.string().optional().describe('可选：按任务状态过滤') },
    async ({ status }) => {
      const agent = requireAgent();
      const params: unknown[] = [agent.id];
      let sql = `
        SELECT t.task_id, t.title, t.kind, t.status, t.schedule_cron,
               t.window_start, t.window_end, t.next_due_at, t.claimed_at, t.workdir,
               tp.topic AS topic
          FROM tasks t
          LEFT JOIN topics tp ON tp.id = t.topic_id
         WHERE t.assignee_id = ?`;
      if (status) {
        sql += ' AND t.status = ?';
        params.push(status);
      }
      sql += ' ORDER BY t.created_at DESC LIMIT 100';
      const rows = await query(sql, params);
      const tasks = rows.map((r) => {
        const rr = r as Record<string, unknown>;
        return {
          task_id: rr.task_id,
          title: rr.title,
          kind: rr.kind,
          status: rr.status,
          schedule_cron: rr.schedule_cron ?? null,
          window_start: rr.window_start ?? null,
          window_end: rr.window_end ?? null,
          next_due_at: rr.next_due_at ?? null,
          topic: rr.topic ?? null,
          workdir: rr.workdir ?? null,
          claimed_at: rr.claimed_at ?? null,
        };
      });
      return text({ tasks });
    },
  );

  // ─────────────────────────── fetch_task ───────────────────────────
  server.tool(
    'fetch_task',
    '拉取指派给当前 agent 的单个任务详情，包含完整自然语言指令与上下文。',
    { task_id: z.string().describe('任务 ID，如 T-20260812-0001') },
    async ({ task_id }) => {
      const agent = requireAgent();
      const rows = await query(
        `SELECT t.task_id, t.title, t.instruction, t.kind, t.status,
                t.schedule_cron, t.window_start, t.window_end, t.next_due_at,
                t.result, t.result_status, t.claimed_at, t.workdir,
                tp.topic AS topic
           FROM tasks t
           LEFT JOIN topics tp ON tp.id = t.topic_id
          WHERE t.task_id = ? AND t.assignee_id = ? LIMIT 1`,
        [task_id, agent.id],
      );
      if (rows.length === 0) {
        return text({ error: `任务 ${task_id} 不存在或未指派给当前 agent` });
      }
      const r = rows[0] as Record<string, unknown>;
      return text({
        task_id: r.task_id,
        title: r.title,
        instruction: r.instruction,
        kind: r.kind,
        status: r.status,
        schedule_cron: r.schedule_cron ?? null,
        window_start: r.window_start ?? null,
        window_end: r.window_end ?? null,
        next_due_at: r.next_due_at ?? null,
        topic: r.topic ?? null,
        workdir: r.workdir ?? null,
        previous_result: r.result ?? null,
        previous_result_status: r.result_status ?? null,
      });
    },
  );

  // ─────────────────────────── submit_result ───────────────────────────
  server.tool(
    'submit_result',
    '汇报任务执行结果。status 为 success 或 failed，result 为执行结果/总结文本。',
    {
      task_id: z.string().describe('任务 ID'),
      status: z.enum(['success', 'failed']).describe('执行结果状态'),
      result: z.string().describe('结果内容（执行总结、输出、产出物说明等）'),
    },
    async ({ task_id, status, result }) => {
      const agent = requireAgent();
      const res = await submitTaskResult(agent, task_id, status, result);
      if (!res.ok) return text({ error: res.error });
      return text({ ok: true, task_id, status, message: '结果已记录' });
    },
  );

  // ─────────────────────────── report_progress ───────────────────────────
  server.tool(
    'report_progress',
    '长任务执行中上报进度：刷新任务的最后活跃时间（续期，避免被超时回收误杀）。建议执行超过 1 小时的长时间任务每 30-60 分钟调用一次。',
    {
      task_id: z.string().describe('任务 ID'),
      progress: z.string().optional().describe('可选：进度描述文本'),
    },
    async ({ task_id, progress }) => {
      const agent = requireAgent();
      const res = await renewTaskActivity(agent, task_id);
      if (!res.ok) return text({ error: res.error });
      return text({ ok: true, task_id, renewed: true, progress: progress ?? null });
    },
  );

  // ─────────────────────────── publish_report ───────────────────────────
  server.tool(
    'publish_report',
    '向指定主题投递一份报告（定时任务常用）。主题不存在会自动创建。可关联任务 ID。',
    {
      topic: z.string().describe('主题名，如 disk-report'),
      content: z.string().describe('报告正文'),
      task_id: z.string().optional().describe('可选：关联的任务 ID'),
    },
    async ({ topic, content, task_id }) => {
      const agent = requireAgent();
      const data = await withTransaction(async (conn) => {
        // 主题不存在则创建
        const topics = await conn.query(`SELECT id FROM topics WHERE topic = ? LIMIT 1`, [topic]);
        let topicId: number;
        if ((topics as unknown[]).length === 0) {
          const ins = await conn.query(`INSERT INTO topics (topic) VALUES (?)`, [topic]);
          topicId = Number((ins as unknown as { insertId: unknown }).insertId);
        } else {
          topicId = Number(((topics as unknown[])[0] as { id: unknown }).id);
        }

        // 关联任务（若提供）：校验属于当前 agent
        let taskId: number | null = null;
        if (task_id) {
          const tasks = await conn.query(
            `SELECT id FROM tasks WHERE task_id = ? AND assignee_id = ? LIMIT 1`,
            [task_id, agent.id],
          );
          if ((tasks as unknown[]).length > 0) {
            taskId = Number(((tasks as unknown[])[0] as { id: unknown }).id);
          }
        }

        await conn.query(
          `INSERT INTO reports (topic_id, task_id, agent_id, content) VALUES (?, ?, ?, ?)`,
          [topicId, taskId, agent.id, content],
        );
        return { ok: true, topic, task_id: task_id ?? null };
      });
      return text(data);
    },
  );

  // ─────────────────────────── check_due_tasks ───────────────────────────
  server.tool(
    'check_due_tasks',
    '主 agent 轮询接口：返回当前 agent 已到期的定时任务（含完整指令）。调用后任务被标记为 running 并推进下次到期时间；无到期任务返回空数组。',
    {},
    async () => {
      const agent = requireAgent();
      const dueTasks = await claimDueTasks(agent);
      return text({ due_tasks: dueTasks });
    },
  );
}
