import { Router } from 'express';
import {
  principalAuthMiddleware,
  requirePrincipal,
  requireScope,
} from '../../auth-principal.js';
import { listEventLog } from '../../service/event-log.js';

export const eventsV2Router = Router();

function queryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : undefined;
  return value === undefined || value === null ? undefined : String(value);
}

function queryLimit(value: unknown): number | undefined {
  const raw = queryValue(value);
  if (raw === undefined || raw === '') return undefined;
  const limit = Number(raw);
  return Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : undefined;
}

eventsV2Router.get(
  '/',
  principalAuthMiddleware(),
  requireScope('post:read'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const rawLimit = queryValue(req.query.limit);
      const limit = queryLimit(req.query.limit);
      if (rawLimit !== undefined && limit === undefined) {
        res.status(400).json({ error: 'limit must be an integer between 1 and 200' });
        return;
      }
      res.json(await listEventLog({
        account_id: context.account_id,
        action: queryValue(req.query.action),
        resource_type: queryValue(req.query.resource_type),
        resource_id: queryValue(req.query.resource_id),
        actor_principal_id: queryValue(req.query.actor_principal_id),
        after: queryValue(req.query.after),
        limit,
      }));
    } catch (error) {
      next(error);
    }
  },
);
