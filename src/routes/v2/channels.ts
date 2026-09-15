import { Router } from 'express';
import {
  principalAuthMiddleware,
  requirePrincipal,
  requireScope,
} from '../../auth-principal.js';
import {
  createOrGetChannel,
  listChannelMessages,
  listChannels,
  sendChannelMessage,
} from '../../service/channels.js';

export const channelsV2Router = Router();

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function queryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : undefined;
  return value === undefined || value === null ? undefined : String(value);
}

function queryLimit(value: unknown): { value?: number; error?: string } {
  const raw = queryValue(value);
  if (raw === undefined || raw === '') return {};
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    return { error: 'limit must be an integer between 1 and 100' };
  }
  return { value: parsed };
}

channelsV2Router.post(
  '/',
  principalAuthMiddleware(),
  requireScope('post:write'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const body = bodyRecord(req.body);
      if (typeof body.host_principal_id !== 'string' || body.host_principal_id.trim() === '') {
        res.status(400).json({ error: 'host_principal_id is required' });
        return;
      }
      if (body.title !== undefined && typeof body.title !== 'string') {
        res.status(400).json({ error: 'title must be a string' });
        return;
      }
      const channel = await createOrGetChannel({
        account_id: context.account_id,
        principal_id: context.principal.id,
        host_principal_id: body.host_principal_id,
        title: typeof body.title === 'string' ? body.title : undefined,
      });
      res.status(201).json({ ok: true, channel_id: channel.id, channel });
    } catch (error) {
      next(error);
    }
  },
);

channelsV2Router.get(
  '/',
  principalAuthMiddleware(),
  requireScope('post:read'),
  async (_req, res, next) => {
    try {
      const context = requirePrincipal();
      res.json({ items: await listChannels(context.account_id, context.principal.id) });
    } catch (error) {
      next(error);
    }
  },
);

channelsV2Router.get(
  '/:id/messages',
  principalAuthMiddleware(),
  requireScope('post:read'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const limit = queryLimit(req.query.limit);
      if (limit.error) {
        res.status(400).json({ error: limit.error });
        return;
      }
      const result = await listChannelMessages({
        account_id: context.account_id,
        principal_id: context.principal.id,
        channel_id: req.params.id,
        after: queryValue(req.query.after),
        limit: limit.value,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

channelsV2Router.post(
  '/:id/messages',
  principalAuthMiddleware(),
  requireScope('post:write'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const body = bodyRecord(req.body);
      if (typeof body.body !== 'string') {
        res.status(400).json({ error: 'body is required' });
        return;
      }
      const post = await sendChannelMessage({
        account_id: context.account_id,
        principal_id: context.principal.id,
        channel_id: req.params.id,
        body: body.body,
      });
      res.status(201).json({ ok: true, post_id: post.id, root_id: post.root_id });
    } catch (error) {
      next(error);
    }
  },
);
