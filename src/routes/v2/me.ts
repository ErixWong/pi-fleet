import { Router } from 'express';
import {
  principalAuthMiddleware,
  requirePrincipal,
  requireScope,
} from '../../auth-principal.js';
import {
  changePassword,
  createPersonalApiKey,
  listPersonalApiKeys,
  revokePersonalApiKey,
} from '../../service/identity.js';

export const meV2Router = Router();

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

meV2Router.post(
  '/password',
  principalAuthMiddleware(),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const body = bodyRecord(req.body);
      const oldPassword = typeof body.old_password === 'string' ? body.old_password : null;
      const newPassword = typeof body.new_password === 'string' ? body.new_password : null;
      if (oldPassword === null || newPassword === null) {
        res.status(400).json({ error: 'old_password 和 new_password 必须是字符串' });
        return;
      }
      await changePassword(context.principal.id, oldPassword, newPassword);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

meV2Router.get(
  '/keys',
  principalAuthMiddleware(),
  requireScope('key:manage'),
  async (_req, res, next) => {
    try {
      const context = requirePrincipal();
      res.json({
        principal_id: context.principal.id,
        items: await listPersonalApiKeys(context.principal.id),
      });
    } catch (error) {
      next(error);
    }
  },
);

meV2Router.post(
  '/keys',
  principalAuthMiddleware(),
  requireScope('key:manage'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const body = bodyRecord(req.body);
      if (!Array.isArray(body.scopes)) {
        res.status(400).json({ error: 'scopes must be an array of strings' });
        return;
      }
      if (
        body.expires_at !== undefined
        && body.expires_at !== null
        && typeof body.expires_at !== 'string'
      ) {
        res.status(400).json({ error: 'expires_at 必须是 YYYY-MM-DD HH:mm:ss 或 null' });
        return;
      }
      const created = await createPersonalApiKey(context.principal.id, {
        label: typeof body.label === 'string' ? body.label : undefined,
        scopes: body.scopes,
        expires_at: body.expires_at === undefined || body.expires_at === null
          ? null
          : body.expires_at,
      });
      res.status(201).json({ ok: true, key: created.key, api_key: created.apiKey });
    } catch (error) {
      next(error);
    }
  },
);

meV2Router.delete(
  '/keys/:id',
  principalAuthMiddleware(),
  requireScope('key:manage'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      await revokePersonalApiKey(context.principal.id, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);
