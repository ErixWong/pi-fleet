import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { currentAgent } from '../auth.js';
import {
  claimDueTasks,
  getTaskMessages,
  listMyThreads,
  postMessageToTask,
  renewTaskActivity,
  requestTask,
  resolveTask,
  submitTaskResult,
} from '../service/tasks.js';

/**
 * 创建 MCP Server 实例并注册全部工具。
 * SDK 1.30 的 Server.connect() 仅支持单 transport，因此每个 MCP 会话
 * 必须使用独立的 Server 实例（routes/mcp.ts 中按会话创建）。
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'task-dispatch', version: '0.2.0' },
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

  // ─────────────────────────── 会话：我参与的任务 ───────────────────────────
  server.tool(
    'list_threads',
    '列出我参与的任务线程（我发起或指派给我的）。每条含：任务、状态、最后消息、awaiting_me（是否轮到本机回复）。',
    {},
    async () => {
      const agent = requireAgent();
      const threads = await listMyThreads(agent);
      return text({ threads });
    },
  );

  server.tool(
    'get_messages',
    '拉取指定任务的完整消息流（协作会话的所有回合，时间正序）。',
    { task_id: z.string().describe('任务 ID，如 T-260813-xxxx') },
    async ({ task_id }) => {
      const agent = requireAgent();
      const { isParticipant } = await import('../service/tasks.js');
      if (!(await isParticipant(agent.id, task_id))) {
        return text({ error: `任务 ${task_id} 不存在或你未参与` });
      }
      const messages = await getTaskMessages(task_id);
      return text({ task_id, messages });
    },
  );

  server.tool(
    'post_message',
    '向任务回复一条消息（协作会话的回合回复）。回复后等待对方继续；若任务已关闭则拒绝。',
    {
      task_id: z.string().describe('任务 ID'),
      content: z.string().describe('回复内容（处理结果、进展、问题、请求等）'),
    },
    async ({ task_id, content }) => {
      const agent = requireAgent();
      const r = await postMessageToTask(agent, task_id, content);
      if (!r.ok) return text({ error: r.error });
      return text({ ok: true, task_id, message: '已回复' });
    },
  );

  server.tool(
    'resolve_task',
    '关闭任务（协作会话结束）。可选附最终总结；关闭后任务状态为 resolved。',
    {
      task_id: z.string().describe('任务 ID'),
      final_result: z.string().optional().describe('可选：最终总结/结论'),
    },
    async ({ task_id, final_result }) => {
      const agent = requireAgent();
      const r = await resolveTask(agent, task_id, final_result);
      if (!r.ok) return text({ error: r.error });
      return text({ ok: true, task_id, status: 'resolved', message: '任务已关闭' });
    },
  );

  server.tool(
    'request_task',
    '向另一台主机发起协作任务：创建会话并写入首条请求消息。目标主机下次轮询时领取处理，完成后回复，本机可轮询查看。',
    {
      assignee: z.string().describe('目标主机的 agent_id（如 agent-xxxx，用 whoami/list_threads 可查到）'),
      title: z.string().describe('任务标题'),
      instruction: z.string().describe('请求内容（明确要对方做什么、提供什么）'),
      workdir: z.string().optional().describe('可选：对方机器上的工作目录'),
    },
    async ({ assignee, title, instruction, workdir }) => {
      const agent = requireAgent();
      const r = await requestTask(agent, assignee, title, instruction, workdir);
      if (!r.ok) return text({ error: r.error });
      return text({ ok: true, task_id: r.task_id, message: `已发起任务，等待 ${assignee} 处理` });
    },
  );

  // ─────────────────────────── 回合领取 ───────────────────────────
  server.tool(
    'check_due_tasks',
    '领取"等待本机动作"的任务回合：①被指派且对方刚回复的协作任务 ②本机发起且对方已回复的协作任务 ③到期的定时任务。协作任务附带完整消息流（上下文重建）；领取后需处理并 post_message 回复。',
    {},
    async () => {
      const agent = requireAgent();
      const tasks = await claimDueTasks(agent);
      return text({ due_tasks: tasks });
    },
  );

  // ─────────────────────────── 兼容：定时任务单轮 ───────────────────────────
  server.tool(
    'list_my_tasks',
    '列出指派给当前 agent 的定时任务（可按状态过滤：pending/running/done/failed）。协作会话请用 list_threads。',
    { status: z.string().optional().describe('可选：按任务状态过滤') },
    async ({ status }) => {
      const agent = requireAgent();
      const params: unknown[] = [agent.id];
      let sql = `
        SELECT t.task_id, t.title, t.kind, t.status, t.schedule_cron,
               t.window_start, t.window_end, t.next_due_at, t.claimed_at, t.workdir
          FROM tasks t
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
          workdir: rr.workdir ?? null,
          claimed_at: rr.claimed_at ?? null,
        };
      });
      return text({ tasks });
    },
  );

  server.tool(
    'fetch_task',
    '拉取指派给当前 agent 的单个任务详情（含完整指令、workdir；协作任务含消息流）。',
    { task_id: z.string().describe('任务 ID，如 T-20260812-0001') },
    async ({ task_id }) => {
      const agent = requireAgent();
      const rows = await query(
        `SELECT t.task_id, t.title, t.instruction, t.kind, t.status,
                t.schedule_cron, t.window_start, t.window_end, t.next_due_at,
                t.result, t.result_status, t.claimed_at, t.workdir
           FROM tasks t
          WHERE t.task_id = ? AND t.assignee_id = ? LIMIT 1`,
        [task_id, agent.id],
      );
      if (rows.length === 0) {
        return text({ error: `任务 ${task_id} 不存在或未指派给当前 agent` });
      }
      const r = rows[0] as Record<string, unknown>;
      const messages = r.kind === 'manual' ? await getTaskMessages(task_id) : [];
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
        workdir: r.workdir ?? null,
        messages,
        previous_result: r.result ?? null,
        previous_result_status: r.result_status ?? null,
      });
    },
  );

  server.tool(
    'submit_result',
    '汇报定时任务执行结果（scheduled 单轮任务用）。status 为 success 或 failed。协作会话请用 post_message。',
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

  server.tool(
    'publish_report',
    '向任务投递一份报告（定时任务产出归档，直接挂在任务下）。报告可在任务详情页查看历史时间线。',
    {
      task_id: z.string().describe('关联的任务 ID'),
      content: z.string().describe('报告正文'),
    },
    async ({ task_id, content }) => {
      const agent = requireAgent();
      const { publishReportToTask } = await import('../service/tasks.js');
      const data = await publishReportToTask(agent, task_id, content);
      if (!data.ok) return text({ error: data.error });
      return text({ ok: true, task_id, message: '报告已归档到任务' });
    },
  );

  // ─────────────────────────── 交付物 ───────────────────────────
  server.tool(
    'list_deliverables',
    '查看任务的交付物约定清单（创建任务时约定：名称/路径/验收标准）与全部已提交版本历史。',
    { task_id: z.string().describe('任务 ID') },
    async ({ task_id }) => {
      const agent = requireAgent();
      const { isParticipant, listDeliverables } = await import('../service/tasks.js');
      if (!(await isParticipant(agent.id, task_id))) {
        return text({ error: `任务 ${task_id} 不存在或你未参与` });
      }
      const data = await listDeliverables(task_id);
      return text({ task_id, spec: data.spec, versions: data.versions });
    },
  );

  server.tool(
    'submit_deliverable',
    '提交交付物版本（任务约定要交付的东西）。name 需与任务约定对齐（若有约定）；同一交付物每次提交版本自增（v1→v2…），历史全留。提交后应 post_message 告知对方。',
    {
      task_id: z.string().describe('任务 ID'),
      name: z.string().describe('交付物名称（对应任务约定）'),
      path: z.string().describe('交付物实际路径（如 src/login.ts）'),
      message: z.string().optional().describe('可选：本次版本变更说明'),
    },
    async ({ task_id, name, path, message }) => {
      const agent = requireAgent();
      const { submitDeliverable } = await import('../service/tasks.js');
      const r = await submitDeliverable(agent, task_id, name, path, message);
      if (!r.ok) return text({ error: r.error });
      return text({ ok: true, task_id, name, version: r.version, message: '交付物已提交' });
    },
  );
}
