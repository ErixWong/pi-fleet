import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  listTasks,
  type ListTasksFilter,
} from '../service/task-flow.js';
import type { TaskStatus } from '../service/posts.js';
import {
  mcpPrincipal,
  guardScope,
  toolFailure,
  toolOk,
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
    'Read task views. This read-only batch supports list only.',
    {
      action: z.literal('list'),
      view: z.enum(TASK_VIEWS),
      status: z.enum(TASK_STATUSES).optional(),
      page: z.number().int().min(1).optional(),
      page_size: z.number().int().min(1).max(200).optional(),
    },
    async (args): Promise<ToolResult> => {
      try {
        guardScope('task:read');
        const context = mcpPrincipal();
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
