import { Router } from 'express';
import {
  hasScopes,
  principalAuthMiddleware,
  requirePrincipal,
  requireScope,
} from '../../auth-principal.js';
import {
  readPostDetail,
  readPostList,
  type PublicPost,
} from '../../mcp/post-tools.js';
import {
  addTarget,
  createPost,
  deletePost,
  editPost,
  getPostDetail,
  getSummary,
  removeTarget,
  replyPost,
} from '../../service/posts.js';
import { publishTask } from '../../service/task-flow.js';
import type { ListPostsFilter, PostKind, PostVisibility } from '../../service/posts.js';

export const postsV2Router = Router();

function queryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : undefined;
  return value === undefined || value === null ? undefined : String(value);
}

function queryInteger(
  value: unknown,
  name: string,
  options: { min: number; max?: number },
): { value?: number; error?: string } {
  const raw = queryValue(value);
  if (raw === undefined || raw === '') return {};
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < options.min || (options.max !== undefined && parsed > options.max)) {
    return { error: `${name} must be an integer between ${options.min} and ${options.max ?? 'infinity'}` };
  }
  return { value: parsed };
}

function postKind(value: string | undefined): PostKind | undefined {
  if (value === undefined) return undefined;
  return ['note', 'task', 'message', 'verdict', 'channel'].includes(value)
    ? value as PostKind
    : undefined;
}

function visibility(value: string | undefined): PostVisibility | undefined {
  if (value === undefined) return undefined;
  return ['private', 'account', 'public'].includes(value)
    ? value as PostVisibility
    : undefined;
}

type TargetInput = { principal_id: string; role: 'assignee' | 'mention' | 'watcher' };

function targetInputs(value: unknown): TargetInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((target) => {
    const item = target as { principal_id?: unknown; role?: unknown };
    return {
      principal_id: String(item.principal_id ?? ''),
      role: (item.role ?? 'assignee') as TargetInput['role'],
    };
  });
}

postsV2Router.post(
  '/',
  principalAuthMiddleware(),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const body = req.body as Record<string, unknown>;
      const kind = typeof body.kind === 'string' ? postKind(body.kind) : undefined;
      if (!kind || typeof body.body !== 'string') {
        res.status(400).json({ error: 'kind and body are required' });
        return;
      }
      const postVisibility = typeof body.visibility === 'string'
        ? visibility(body.visibility)
        : 'private';
      if (!postVisibility) {
        res.status(400).json({ error: 'invalid visibility' });
        return;
      }
      const targets = targetInputs(body.targets);
      if (kind === 'task') {
        if (!hasScopes('task:write')) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        const task = await publishTask({
          account_id: context.account_id,
          author_principal_id: context.principal.id,
          title: typeof body.title === 'string' ? body.title : undefined,
          body: body.body,
          visibility: postVisibility,
          subtype: typeof body.subtype === 'string' ? body.subtype : undefined,
          deliverable_spec: body.deliverable_spec,
          targets,
          task: typeof body.task === 'object' && body.task !== null
            ? body.task as {
                deliverable_spec?: unknown;
                is_ready?: boolean;
                workdir?: string | null;
                executor?: string | null;
                max_attempts?: number;
              }
            : undefined,
        });
        res.status(201).json({ ok: true, post_id: task.post.id, status: task.task.status });
        return;
      }
      if (!hasScopes('post:write')) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const post = await createPost({
        account_id: context.account_id,
        kind,
        subtype: typeof body.subtype === 'string' ? body.subtype : undefined,
        author_principal_id: context.principal.id,
        title: typeof body.title === 'string' ? body.title : undefined,
        body: body.body,
        visibility: postVisibility,
        parent_id: typeof body.parent_id === 'string' ? body.parent_id : null,
        targets,
        channel: typeof body.channel === 'object' && body.channel !== null
          ? body.channel as {
              host_principal_id: string;
              workdir?: string | null;
              run_user?: string | null;
              name?: string;
              status?: 'open' | 'archived';
            }
          : undefined,
      });
      res.status(201).json({ ok: true, post_id: post.id, root_id: post.root_id });
    } catch (error) {
      next(error);
    }
  },
);

postsV2Router.post(
  '/:id/reply',
  principalAuthMiddleware(),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      if (!hasScopes('post:write')) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const body = req.body as Record<string, unknown>;
      if (typeof body.body !== 'string') {
        res.status(400).json({ error: 'body is required' });
        return;
      }
      const post = await replyPost({
        parent_id: req.params.id,
        author_principal_id: context.principal.id,
        body: body.body,
        subtype: typeof body.subtype === 'string' ? body.subtype : undefined,
        targets: targetInputs(body.targets),
      });
      res.status(201).json({ ok: true, post_id: post.id, root_id: post.root_id });
    } catch (error) {
      next(error);
    }
  },
);

postsV2Router.post(
  '/:id/edit',
  principalAuthMiddleware(),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      if (!hasScopes('post:write')) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const detail = await getPostDetail(req.params.id);
      if (!detail || detail.post.account_id !== context.account_id || detail.post.deleted_at) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (detail.post.author_principal_id !== context.principal.id && !hasScopes('moderate')) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const post = await editPost(req.params.id, {
        title: typeof body.title === 'string' ? body.title : undefined,
        body: typeof body.body === 'string' ? body.body : undefined,
      });
      res.json({ ok: true, revision: post.revision });
    } catch (error) {
      next(error);
    }
  },
);

postsV2Router.post(
  '/:id/delete',
  principalAuthMiddleware(),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      if (!hasScopes('post:write')) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const detail = await getPostDetail(req.params.id);
      if (!detail || detail.post.account_id !== context.account_id) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (detail.post.author_principal_id !== context.principal.id && !hasScopes('moderate')) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      await deletePost(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

postsV2Router.post(
  '/:id/target',
  principalAuthMiddleware(),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      if (!hasScopes('post:write')) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const detail = await getPostDetail(req.params.id);
      if (!detail || detail.post.account_id !== context.account_id || detail.post.deleted_at) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (detail.post.author_principal_id !== context.principal.id && !hasScopes('moderate')) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const body = req.body as Record<string, unknown>;
      for (const target of (Array.isArray(body.add) ? body.add : []) as Array<{ principal_id: string; role: 'assignee' | 'mention' | 'watcher' }>) {
        await addTarget(req.params.id, target.principal_id, target.role);
      }
      for (const target of (Array.isArray(body.remove) ? body.remove : []) as Array<{ principal_id: string; role: 'assignee' | 'mention' | 'watcher' }>) {
        await removeTarget(req.params.id, target.principal_id, target.role);
      }
      const updated = await getPostDetail(req.params.id);
      res.json({
        ok: true,
        targets: updated?.targets.map((target) => ({
          principal_id: target.principal_id,
          role: target.role,
          read_at: target.read_at,
        })) ?? [],
      });
    } catch (error) {
      next(error);
    }
  },
);

postsV2Router.post(
  '/:id/summary',
  principalAuthMiddleware(),
  async (req, res, next) => {
    try {
      requirePrincipal();
      if (!hasScopes('post:read')) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const detail = await getPostDetail(req.params.id);
      if (!detail || detail.post.account_id !== requirePrincipal().account_id) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const summary = await getSummary(detail.post.root_id);
      res.json({
        ...(summary ?? { summary: null }),
        pending_worker: (req.body as Record<string, unknown>).refresh === true,
      });
    } catch (error) {
      next(error);
    }
  },
);

postsV2Router.get(
  '/',
  principalAuthMiddleware(),
  requireScope('post:read'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const kindValue = queryValue(req.query.kind);
      const visibilityValue = queryValue(req.query.visibility);
      const kind = postKind(kindValue);
      const postVisibility = visibility(visibilityValue);
      if (kindValue !== undefined && !kind) {
        res.status(400).json({ error: 'invalid kind' });
        return;
      }
      if (visibilityValue !== undefined && !postVisibility) {
        res.status(400).json({ error: 'invalid visibility' });
        return;
      }
      const page = queryInteger(req.query.page, 'page', { min: 1 });
      const pageSize = queryInteger(req.query.page_size, 'page_size', { min: 1, max: 200 });
      const limit = queryInteger(req.query.limit, 'limit', { min: 1, max: 200 });
      if (page.error || pageSize.error || limit.error) {
        res.status(400).json({ error: page.error ?? pageSize.error ?? limit.error });
        return;
      }
      const after = queryValue(req.query.after);
      const rootId = queryValue(req.query.root_id);
      const parentIdValue = queryValue(req.query.parent_id);
      const filter: ListPostsFilter = {
        account_id: context.account_id,
        kind,
        root_id: rootId,
        parent_id: parentIdValue === undefined
          ? undefined
          : parentIdValue === 'null' ? null : parentIdValue,
        author_principal_id: queryValue(req.query.author_principal_id),
        visibility: postVisibility,
        target_principal_id: queryValue(req.query.target_principal_id),
        page: page.value,
        page_size: pageSize.value,
        after,
        limit: limit.value,
      };
      const result: { items: PublicPost[]; total: number; next_after: string | null } =
        await readPostList(filter);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

postsV2Router.get(
  '/:id',
  principalAuthMiddleware(),
  requireScope('post:read'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const detail = await readPostDetail(req.params.id, context.account_id, context.principal.id);
      if (!detail) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json(detail);
    } catch (error) {
      next(error);
    }
  },
);
