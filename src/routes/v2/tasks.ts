import { Router } from 'express';
import {
  principalAuthMiddleware,
  requirePrincipal,
  requireScope,
} from '../../auth-principal.js';
import { listTasks, type TaskListView } from '../../service/task-flow.js';
import type { TaskStatus } from '../../service/posts.js';
import { presentTaskListItem } from '../../mcp/post-tools.js';

export const tasksV2Router = Router();

const TASK_VIEWS = new Set<TaskListView>(['due', 'mine', 'pool']);
const TASK_STATUSES = new Set<TaskStatus>([
  'pending_audit',
  'rejected',
  'open',
  'claimed',
  'submitted',
  'pending_confirm',
  'done',
  'failed',
  'cancelled',
]);

function queryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : undefined;
  return value === undefined || value === null ? undefined : String(value);
}

function queryInteger(value: unknown, name: string, min: number, max?: number): {
  value?: number;
  error?: string;
} {
  const raw = queryValue(value);
  if (raw === undefined || raw === '') return {};
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    return { error: `${name} must be an integer between ${min} and ${max ?? 'infinity'}` };
  }
  return { value: parsed };
}

tasksV2Router.get(
  '/',
  principalAuthMiddleware(),
  requireScope('task:read'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const viewValue = queryValue(req.query.view) ?? 'due';
      if (!TASK_VIEWS.has(viewValue as TaskListView)) {
        res.status(400).json({ error: 'view must be due, mine, or pool' });
        return;
      }
      const page = queryInteger(req.query.page, 'page', 1);
      const pageSize = queryInteger(req.query.page_size, 'page_size', 1, 200);
      if (page.error || pageSize.error) {
        res.status(400).json({ error: page.error ?? pageSize.error });
        return;
      }
      const statusValue = queryValue(req.query.status);
      if (statusValue !== undefined && !TASK_STATUSES.has(statusValue as TaskStatus)) {
        res.status(400).json({ error: 'invalid status' });
        return;
      }
      const result = await listTasks({
        view: viewValue as TaskListView,
        principal_id: context.principal.id,
        account_id: context.account_id,
        status: statusValue as TaskStatus | undefined,
        page: page.value,
        page_size: pageSize.value,
      });
      res.json({
        view: viewValue,
        items: result.items.map((item) => presentTaskListItem(item)),
        total: result.total,
      });
    } catch (error) {
      next(error);
    }
  },
);
