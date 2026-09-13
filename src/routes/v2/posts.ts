import { Router } from 'express';
import {
  principalAuthMiddleware,
  requirePrincipal,
  requireScope,
} from '../../auth-principal.js';
import {
  readPostDetail,
  readPostList,
  type PublicPost,
} from '../../mcp/post-tools.js';
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
      const detail = await readPostDetail(req.params.id, context.account_id);
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
