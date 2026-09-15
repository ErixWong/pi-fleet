import { Router } from 'express';
import {
  hasScopes,
  principalAuthMiddleware,
  requirePrincipal,
  requireScope,
} from '../../auth-principal.js';
import {
  cancelTask,
  claimTask,
  listTasks,
  publishTask,
  reassignTask,
  reopenTask,
  submitTask,
  verdictTask,
  type TaskListView,
  type TaskTargetInput,
} from '../../service/task-flow.js';
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

function targets(value: unknown): TaskTargetInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((target) => {
    if (typeof target === 'string') return target;
    const item = target as { principal_id?: unknown; role?: unknown };
    return {
      principal_id: String(item.principal_id ?? ''),
      role: (item.role ?? 'assignee') as 'assignee' | 'mention' | 'watcher',
    };
  });
}

tasksV2Router.post(
  '/',
  principalAuthMiddleware(),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      if (!hasScopes('task:write')) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const body = req.body as Record<string, unknown>;
      if (typeof body.body !== 'string') {
        res.status(400).json({ error: 'body is required' });
        return;
      }
      const published = await publishTask({
        account_id: context.account_id,
        author_principal_id: context.principal.id,
        title: typeof body.title === 'string' ? body.title : undefined,
        body: body.body,
        visibility: typeof body.visibility === 'string'
          ? body.visibility as 'private' | 'account' | 'public'
          : 'private',
        subtype: typeof body.subtype === 'string' ? body.subtype : undefined,
        deliverable_spec: body.deliverable_spec,
        targets: targets(body.targets),
        task: typeof body.task === 'object' && body.task !== null
          ? body.task as {
              deliverable_spec?: unknown;
              is_ready?: boolean;
              workdir?: string | null;
              executor?: string | null;
              max_attempts?: number;
              pipeline_step_id?: string | null;
              parent_task_id?: string | null;
            }
          : undefined,
      });
      res.status(201).json({ ok: true, post_id: published.post.id, status: published.task.status });
    } catch (error) {
      next(error);
    }
  },
);

tasksV2Router.post(
  '/:id/claim',
  principalAuthMiddleware(),
  requireScope('task:claim'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const task = await claimTask(req.params.id, { principal_id: context.principal.id });
      res.json({
        ok: true,
        status: task.status,
        assignee_principal_id: task.assignee_principal_id,
      });
    } catch (error) {
      next(error);
    }
  },
);

tasksV2Router.post(
  '/:id/submit',
  principalAuthMiddleware(),
  requireScope('task:submit'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const body = req.body as Record<string, unknown>;
      if (!Array.isArray(body.deliverables)) {
        res.status(400).json({ error: 'deliverables is required' });
        return;
      }
      const result = await submitTask(req.params.id, {
        principal_id: context.principal.id,
        deliverables: body.deliverables as Array<{
          name: string;
          attachment_id?: string | null;
          note?: string;
        }>,
        message: typeof body.message === 'string' ? body.message : undefined,
      });
      res.json({ ok: result.ok, precheck: result.precheck, task: result.task });
    } catch (error) {
      next(error);
    }
  },
);

tasksV2Router.post(
  '/:id/verdict',
  principalAuthMiddleware(),
  requireScope('task:verdict'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const body = req.body as Record<string, unknown>;
      if (body.decision !== 'accept' && body.decision !== 'reject') {
        res.status(400).json({ error: 'decision must be accept or reject' });
        return;
      }
      const result = await verdictTask(req.params.id, {
        operator_principal_id: context.principal.id,
        decision: body.decision,
        opinion: typeof body.opinion === 'string' ? body.opinion : undefined,
      });
      res.json({ ok: true, task: result.task, verdict: result.verdict });
    } catch (error) {
      next(error);
    }
  },
);

tasksV2Router.post(
  '/:id/reopen',
  principalAuthMiddleware(),
  requireScope('task:verdict'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const body = req.body as Record<string, unknown>;
      const task = await reopenTask(req.params.id, {
        operator_principal_id: context.principal.id,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
      });
      res.json({ ok: true, task });
    } catch (error) {
      next(error);
    }
  },
);

tasksV2Router.post(
  '/:id/reassign',
  principalAuthMiddleware(),
  requireScope('moderate'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const body = req.body as Record<string, unknown>;
      const task = await reassignTask(req.params.id, {
        operator_principal_id: context.principal.id,
        assignee_principal_id: body.assignee_principal_id === null
          ? null
          : String(body.assignee_principal_id ?? ''),
      });
      res.json({ ok: true, task });
    } catch (error) {
      next(error);
    }
  },
);

tasksV2Router.post(
  '/:id/cancel',
  principalAuthMiddleware(),
  requireScope('moderate'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const body = req.body as Record<string, unknown>;
      const task = await cancelTask(req.params.id, {
        operator_principal_id: context.principal.id,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
      });
      res.json({ ok: true, task });
    } catch (error) {
      next(error);
    }
  },
);

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
