import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  principalAuthMiddleware,
  requirePrincipal,
  requireScope,
} from '../../auth-principal.js';
import {
  createApiKey,
  getApiKey,
  listApiKeys,
  revokeApiKey,
} from '../../service/identity.js';

export const identitiesV2Router = Router();

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

identitiesV2Router.get(
  '/',
  principalAuthMiddleware(),
  requireScope('key:manage'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const principalId = typeof req.query.principal_id === 'string'
        ? req.query.principal_id
        : context.principal.id;
      if (principalId !== context.principal.id) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json({
        principal_id: principalId,
        items: await listApiKeys(principalId),
      });
    } catch (error) {
      next(error);
    }
  },
);

identitiesV2Router.post(
  '/',
  principalAuthMiddleware(),
  requireScope('key:manage'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const body = bodyRecord(req.body);
      const principalId = typeof body.principal_id === 'string'
        ? body.principal_id
        : context.principal.id;
      // Issuing a key for another principal is an admin operation handled by the management DB/script path.
      if (principalId !== context.principal.id) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (!Array.isArray(body.scopes) || body.scopes.some((scope) => typeof scope !== 'string')) {
        res.status(400).json({ error: 'scopes must be an array of strings' });
        return;
      }
      if (body.scopes.some((scope) => !context.scopes.includes(scope as typeof context.scopes[number]))) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const created = await createApiKey({
        principal_id: principalId,
        scopes: body.scopes,
        label: typeof body.label === 'string' ? body.label : undefined,
        expires_at: typeof body.expires_at === 'string' ? body.expires_at : null,
      });
      res.status(201).json({ ok: true, key: created.key, api_key: created.apiKey });
    } catch (error) {
      next(error);
    }
  },
);

async function revokeKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = requirePrincipal();
    const body = bodyRecord(req.body);
    const keyId = req.params.id ?? (typeof body.key_id === 'string' ? body.key_id : '');
    const apiKey = await getApiKey(keyId);
    if (!apiKey) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (apiKey.principal_id !== context.principal.id) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    await revokeApiKey(keyId);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
}

identitiesV2Router.delete(
  '/',
  principalAuthMiddleware(),
  requireScope('key:manage'),
  revokeKey,
);

identitiesV2Router.delete(
  '/:id',
  principalAuthMiddleware(),
  requireScope('key:manage'),
  revokeKey,
);
