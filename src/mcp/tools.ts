import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query } from '../db.js';
import { currentAgent } from '../auth.js';
import { claimDueTasks, listMyThreads, postMessageToTask } from '../service/tasks.js';
import {
  approveTask,
  cancelTask,
  claimTask,
  createTask,
  listPoolTasks,
  rejectTask,
  reviseTask,
  submitForReview,
  taskDetail,
} from '../service/market.js';
import { uploadAttachment } from '../service/attachments.js';

/**
 * 创建 MCP Server 实例并注册工具。
 * 终局工具面（§3.6 收敛）：whoami + task（10 action）。遗留工具已全部并入 task——
 *   request_task/check_due_tasks → task(list/create/claim)
 *   list_threads/list_my_tasks/fetch_task/get_messages/list_deliverables → task(list/detail)
 *   post_message/publish_report/report_progress → task(reply, type=chat|report|progress)
 *   submit_result/submit_deliverable → task(submit)
 *   resolve_task → task(approve)
 * SDK 1.30 的 Server.connect() 仅支持单 transport，因此每个 MCP 会话
 * 必须使用独立的 Server 实例（routes/mcp.ts 中按会话创建）。
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'task-dispatch', version: '0.3.0' },
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
    '返回当前 agent 的身份信息：agent_id、名称、主机标识、角色标签、默认提示词、接单开关。',
    {},
    async () => {
      const agent = requireAgent();
      return text({
        agent_id: agent.agentId,
        name: agent.name,
        hostname: agent.hostname,
        tags: agent.tags,
        system_prompt: agent.systemPrompt,
        accept_external: agent.acceptExternal,
      });
    },
  );

  // ─────────────────────────── upload_attachment：附件上传（§3.7/§3.6 第三把工具） ───────────────────────────
  server.tool(
    'upload_attachment',
    '上传附件（base64，≤5MB；大文件走 REST POST /api/agent/attachments multipart，同一附件存储）。\n' +
      '返回 attachment_id，供 task(submit) 的 deliverables 引用（引用即授权；同名交付物版本自增）。\n' +
      '上传后异步病毒扫描（clamd 未配置时降级标记"未扫描"）；infected 附件拒绝引用与下载。',
    {
      filename: z.string().describe('原始文件名（含扩展名，下载时还原）'),
      mime: z.string().optional().describe('MIME 类型，如 text/markdown、application/pdf'),
      data_base64: z.string().describe('文件内容 base64（≤5MB）'),
    },
    async ({ filename, mime, data_base64 }) => {
      const agent = requireAgent();
      const buffer = Buffer.from(data_base64, 'base64');
      if (buffer.length > 5 * 1024 * 1024) {
        return text({ error: 'MCP 上传上限 5MB，大文件请用 REST POST /api/agent/attachments（multipart）' });
      }
      const r = await uploadAttachment(agent, { filename, mime, buffer });
      if (!r.ok) return text({ error: r.error });
      return text({ ok: true, attachment_id: r.attachment_id, reused: r.reused ?? false, message: '附件已上传' });
    },
  );

  // ─────────────────────────── task：全生命周期 + 沟通（§3.6 终局） ───────────────────────────
  server.tool(
    'task',
    '任务全生命周期 + 沟通（终局工具，§3.6）。action 明细：\n' +
      '- list: 列出任务。scope=due（等待本机动作）\u007Cmine（我参与的全部，可按 status 过滤）\u007Cpool（公共池，读描述自主判断是否认领）\n' +
      '- detail: 任务详情 + 消息流 + 验收方案 + 交付物版本 + 报告（放开发布者视角与公共池浏览）\n' +
      '- create: 发布任务。title/instruction/deliverable_spec/visibility(默认private)/assignee?；任务 ID 永远平台生成\n' +
      '- revise: 发起人修订任务（标题/指令/验收方案/可见性），未被认领前可改\n' +
      '- claim: 认领（public 池原子认领 / private 接受指派）\n' +
      '- submit: 提交验收。scheduled 直接记录；manual/pool 程序预检（存在性/非空/数量/类型）通过后进入待发起人确认\n' +
      '- reply: 任务线程回帖（type: chat\u007Cprogress\u007Creport）；回复即续期；scheduled 任务可作归档\n' +
      '- approve / reject: 发起人验收判决（验收权跟随发起权），意见回帖进消息流\n' +
      '- cancel: 发起人取消任务（取消即判决的一种）',
    {
      action: z.enum(['list', 'detail', 'create', 'revise', 'claim', 'submit', 'reply', 'approve', 'reject', 'cancel']),
      scope: z.enum(['due', 'mine', 'pool']).optional().describe('list 的范围'),
      status: z.string().optional().describe('list(mine) 按状态过滤'),
      task_id: z.string().optional().describe('任务 ID，如 T-260813-xxxx'),
      title: z.string().optional().describe('create/revise：标题'),
      instruction: z.string().optional().describe('create/revise：指令'),
      deliverable_spec: z.any().optional().describe('create/revise：验收方案数组 [{name, min_count?, type?}]'),
      visibility: z.enum(['private', 'public']).optional().describe('create/revise：默认 private'),
      assignee: z.string().optional().describe('create：指派执行方 agent_id（private 必填）'),
      workdir: z.string().optional().describe('create：可选工作目录'),
      stage_id: z.number().int().optional().describe('create：所属 plan 阶段 id（强制三层：任务必须从属 stage）'),
      result: z.string().optional().describe('submit：完成说明/结果'),
      deliverables: z
        .array(z.object({
          name: z.string(),
          path: z.string().optional(),
          attachment_id: z.string().optional(),
          message: z.string().optional(),
        }))
        .optional()
        .describe('submit：本次交付物 [{name, attachment_id}]（附件引用，推荐；有验收方案时附件必填）或 [{name, path}]（兼容旧契约）'),
      content: z.string().optional().describe('reply：回帖内容'),
      type: z.enum(['chat', 'progress', 'report']).optional().describe('reply：回帖类型，默认 chat'),
      opinion: z.string().optional().describe('approve/reject：判决意见'),
    },
    async (args) => {
      const agent = requireAgent();
      const action = args.action;
      try {
        switch (action) {
          case 'list': {
            const scope = args.scope ?? 'due';
            if (scope === 'pool') {
              const pool = await listPoolTasks(agent);
              return text({ scope: 'pool', count: pool.length, pool });
            }
            if (scope === 'mine') {
              const [threads, rows] = await Promise.all([
                listMyThreads(agent),
                (async () => {
                  const params: unknown[] = [agent.id];
                  let sql = `SELECT t.task_id, t.title, t.status, t.visibility, t.claimed_at, t.workdir
                               FROM tasks t
                              WHERE t.assignee_id = ? OR t.creator_id = ?`;
                  params.push(agent.id);
                  if (args.status) {
                    sql += ' AND t.status = ?';
                    params.push(args.status);
                  }
                  sql += ' ORDER BY t.created_at DESC LIMIT 100';
                  return query(sql, params);
                })(),
              ]);
              return text({ scope: 'mine', threads, tasks: rows });
            }
            const due = await claimDueTasks(agent);
            return text({ scope: 'due', due_tasks: due });
          }
          case 'detail': {
            if (!args.task_id) return text({ error: '缺少 task_id' });
            const r = await taskDetail(agent, args.task_id);
            if (!r.ok) return text({ error: r.error });
            return text({ task_id: args.task_id, task: r.task, messages: r.messages, deliverables: r.deliverables, reports: r.reports, plan_context: r.plan_context ?? null });
          }
          case 'create': {
            if (args.stage_id === undefined || args.stage_id === null) {
              return text({ error: '缺少 stage_id：任务必须从属 plan 的 stage（强制三层）' });
            }
            const r = await createTask(agent, {
              title: args.title ?? '',
              instruction: args.instruction ?? '',
              visibility: args.visibility,
              assignee: args.assignee,
              workdir: args.workdir,
              deliverable_spec: args.deliverable_spec,
              stage_id: args.stage_id === undefined || args.stage_id === null ? undefined : Number(args.stage_id),
            });
            if (!r.ok) return text({ error: r.error });
            return text({ ok: true, task_id: r.task_id, status: r.status, message: '任务已发布' });
          }
          case 'revise': {
            if (!args.task_id) return text({ error: '缺少 task_id' });
            const r = await reviseTask(agent, args.task_id, {
              title: args.title,
              instruction: args.instruction,
              deliverable_spec: args.deliverable_spec,
              visibility: args.visibility,
            });
            if (!r.ok) return text({ error: r.error });
            return text({ ok: true, task_id: args.task_id, message: '任务已修订' });
          }
          case 'claim': {
            if (!args.task_id) return text({ error: '缺少 task_id' });
            const r = await claimTask(agent, args.task_id);
            if (!r.ok) return text({ error: r.error });
            return text({ ok: true, task_id: args.task_id, mode: r.mode, message: '认领成功' });
          }
          case 'submit': {
            if (!args.task_id) return text({ error: '缺少 task_id' });
            const r = await submitForReview(agent, args.task_id, args.result ?? '', args.deliverables);
            if (!r.ok) return text({ error: r.error });
            return text({ ok: true, task_id: args.task_id, status: r.status, reason: r.reason ?? null, message: '已提交' });
          }
          case 'reply': {
            if (!args.task_id || !args.content) return text({ error: '缺少 task_id 或 content' });
            const r = await postMessageToTask(agent, args.task_id, args.content, args.type ?? 'chat');
            if (!r.ok) return text({ error: r.error });
            return text({ ok: true, task_id: args.task_id, type: args.type ?? 'chat', message: '已回帖' });
          }
          case 'approve': {
            if (!args.task_id) return text({ error: '缺少 task_id' });
            const r = await approveTask(agent, args.task_id, args.opinion);
            if (!r.ok) return text({ error: r.error });
            return text({ ok: true, task_id: args.task_id, status: r.status, message: '已验收通过' });
          }
          case 'reject': {
            if (!args.task_id) return text({ error: '缺少 task_id' });
            const r = await rejectTask(agent, args.task_id, args.opinion ?? '');
            if (!r.ok) return text({ error: r.error });
            return text({ ok: true, task_id: args.task_id, status: r.status, message: '已打回，执行方将按意见续做' });
          }
          case 'cancel': {
            if (!args.task_id) return text({ error: '缺少 task_id' });
            const r = await cancelTask(agent, args.task_id, args.opinion);
            if (!r.ok) return text({ error: r.error });
            return text({ ok: true, task_id: args.task_id, message: '任务已取消' });
          }
        }
      } catch (err) {
        return text({ error: err instanceof Error ? err.message : String(err) });
      }
      return text({ error: '未知 action' });
    },
  );
}
