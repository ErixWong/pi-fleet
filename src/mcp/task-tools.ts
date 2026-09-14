import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  claimTask,
  listTasks,
  reopenTask,
  submitTask,
  verdictTask,
  type ListTasksFilter,
} from '../service/task-flow.js';
import type { TaskStatus } from '../service/posts.js';
import {
  mcpPrincipal,
  guardScope,
  toolFailure,
  toolOk,
  toolErr,
  type ToolResult,
} from './context.js';
import { presentTaskListItem } from './post-tools.js';

export { presentTaskListItem };

const TASK_VIEWS = ['due', 'mine', 'pool'] as const;
const TASK_STATUSES = [
  'pending_audit',
  'rejected',
  'open',
  'claimed',
  'submitted',
  'pending_confirm',
  'done',
  'failed',
  'cancelled',
] as const;

export function registerTaskTools(server: McpServer): void {
  server.tool(
    'task',
    'Read task views and perform task state transitions.',
    {
      action: z.string(),
      view: z.enum(TASK_VIEWS).optional(),
      status: z.enum(TASK_STATUSES).optional(),
      page: z.number().int().min(1).optional(),
      page_size: z.number().int().min(1).max(200).optional(),
      task_id: z.string().optional(),
      deliverables: z.array(z.object({
        name: z.string(),
        attachment_id: z.string().nullable().optional(),
        note: z.string().optional(),
      })).optional(),
      message: z.string().optional(),
      decision: z.enum(['accept', 'reject']).optional(),
      opinion: z.string().optional(),
      reason: z.string().optional(),
    },
    async (args): Promise<ToolResult> => {
      try {
        const context = mcpPrincipal();
        if (args.action === 'claim') {
          guardScope('task:claim');
          if (!args.task_id) return toolErr('task_id is required');
          const task = await claimTask(args.task_id, { principal_id: context.principal.id });
          return toolOk({
            ok: true,
            status: task.status,
            assignee_principal_id: task.assignee_principal_id,
          });
        }
        if (args.action === 'submit') {
          guardScope('task:submit');
          if (!args.task_id || !args.deliverables) {
            return toolErr('task_id and deliverables are required');
          }
          const submitted = await submitTask(args.task_id, {
            principal_id: context.principal.id,
            deliverables: args.deliverables,
            message: args.message,
          });
          return toolOk({
            ok: submitted.ok,
            precheck: submitted.precheck,
            task: submitted.task,
          });
        }
        if (args.action === 'verdict') {
          guardScope('task:verdict');
          if (!args.task_id || !args.decision) {
            return toolErr('task_id and decision are required');
          }
          const result = await verdictTask(args.task_id, {
            operator_principal_id: context.principal.id,
            decision: args.decision,
            opinion: args.opinion,
          });
          return toolOk({ ok: true, task: result.task, verdict: result.verdict });
        }
        if (args.action === 'reopen') {
          guardScope('task:verdict');
          if (!args.task_id) return toolErr('task_id is required');
          const task = await reopenTask(args.task_id, {
            operator_principal_id: context.principal.id,
            reason: args.reason,
          });
          return toolOk({ ok: true, task });
        }
        if (args.action !== 'list') return toolErr(`unknown action: ${args.action}`);
        guardScope('task:read');
        if (!args.view) return toolErr('view is required');
        const filter: ListTasksFilter = {
          view: args.view,
          principal_id: context.principal.id,
          account_id: context.account_id,
          status: args.status as TaskStatus | undefined,
          page: args.page,
          page_size: args.page_size,
        };
        const result = await listTasks(filter);
        return toolOk({
          view: args.view,
          items: result.items.map((item) => presentTaskListItem(item)),
          total: result.total,
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
