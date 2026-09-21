import { Router } from 'express';
import {
  principalAuthMiddleware,
  requirePrincipal,
  requireScope,
} from '../../auth-principal.js';
import {
  createApiKey,
  createPrincipal,
  deleteHost,
  getHost,
  listHosts,
  rotateApiKey,
  upsertHostFolders,
  updateHost,
  type HostStatus,
  type Scope,
} from '../../service/identity.js';
import { getSettingInt } from '../../service/new-settings.js';

export const hostsV2Router = Router();

const HOST_KEY_SCOPES: Scope[] = [
  'post:read',
  'post:write',
  'task:read',
  'task:write',
  'task:claim',
  'task:submit',
  'task:verdict',
  'attachment:read',
  'attachment:write',
  'device:execute',
];

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function offline(lastSeen: string | null, offlineAfterMin: number): boolean {
  if (!lastSeen) return true;
  const seen = new Date(lastSeen).getTime();
  return !Number.isFinite(seen) || Date.now() - seen > offlineAfterMin * 60 * 1000;
}

function presentHost(host: {
  id: string;
  name: string;
  status: HostStatus;
  last_seen_at: string | null;
  created_at: string;
  folders: { path: string; last_seen_at: string }[];
}, offlineAfterMin: number): Record<string, unknown> {
  return {
    id: host.id,
    name: host.name,
    status: host.status,
    last_seen: host.last_seen_at,
    created_at: host.created_at,
    offline: offline(host.last_seen_at, offlineAfterMin),
    folders: host.folders.map((folder) => ({
      path: folder.path,
      last_seen_at: folder.last_seen_at,
    })),
  };
}

hostsV2Router.post(
  '/folders',
  principalAuthMiddleware(),
  requireScope('device:execute'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const body = bodyRecord(req.body);
      if (context.principal.kind !== 'host') {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (
        body.host_principal_id !== undefined
        && body.host_principal_id !== context.principal.id
      ) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (!Array.isArray(body.folders)) {
        res.status(400).json({ error: 'folders must be an array' });
        return;
      }
      const folders = await upsertHostFolders(context.principal.id, body.folders);
      res.json({ ok: true, folders });
    } catch (error) {
      next(error);
    }
  },
);

hostsV2Router.post(
  '/',
  principalAuthMiddleware(),
  requireScope('host:manage'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const body = bodyRecord(req.body);
      if (typeof body.name !== 'string' || body.name.trim() === '' || body.name.trim().length > 128) {
        res.status(400).json({ error: 'name must be 1-128 characters' });
        return;
      }
      const host = await createPrincipal({
        account_id: context.account_id,
        kind: 'host',
        name: body.name.trim(),
      });
      let created;
      try {
        created = await createApiKey({
          principal_id: host.id,
          scopes: HOST_KEY_SCOPES,
          label: 'initial',
        });
      } catch (error) {
        await deleteHost(context.account_id, host.id);
        throw error;
      }
      const summary = await getHost(context.account_id, host.id);
      if (!summary) throw new Error(`Host was not created: ${host.id}`);
      res.status(201).json({
        host: presentHost(summary, getSettingInt('agent_offline_after_min', 30)),
        key: created.key,
      });
    } catch (error) {
      next(error);
    }
  },
);

hostsV2Router.get(
  '/',
  principalAuthMiddleware(),
  requireScope('host:manage'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const offlineAfterMin = getSettingInt('agent_offline_after_min', 30);
      const items = (await listHosts(context.account_id)).map((host) => presentHost(host, offlineAfterMin));
      res.json({ items, offline_after_min: offlineAfterMin });
    } catch (error) {
      next(error);
    }
  },
);

hostsV2Router.patch(
  '/:id',
  principalAuthMiddleware(),
  requireScope('host:manage'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const body = bodyRecord(req.body);
      const changes: { name?: string; status?: HostStatus } = {};
      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || body.name.trim() === '' || body.name.trim().length > 128) {
          res.status(400).json({ error: 'name must be 1-128 characters' });
          return;
        }
        changes.name = body.name.trim();
      }
      if (body.status !== undefined) {
        if (body.status !== 'active' && body.status !== 'disabled') {
          res.status(400).json({ error: 'status must be active or disabled' });
          return;
        }
        changes.status = body.status;
      }
      if (Object.keys(changes).length === 0) {
        res.status(400).json({ error: 'name or status is required' });
        return;
      }
      const host = await updateHost(context.account_id, req.params.id, changes);
      if (!host) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json({
        host: presentHost(host, getSettingInt('agent_offline_after_min', 30)),
      });
    } catch (error) {
      next(error);
    }
  },
);

hostsV2Router.delete(
  '/:id',
  principalAuthMiddleware(),
  requireScope('host:manage'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      if (!await deleteHost(context.account_id, req.params.id)) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

hostsV2Router.post(
  '/:id/keys/rotate',
  principalAuthMiddleware(),
  requireScope('host:manage'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const host = await getHost(context.account_id, req.params.id);
      if (!host || host.status === 'disabled') {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const created = await rotateApiKey(host.id, {
        scopes: HOST_KEY_SCOPES,
        label: 'rotated',
        grace_hours: 24,
      });
      res.json({
        key: created.key,
        expires_at: created.apiKey.expires_at,
      });
    } catch (error) {
      next(error);
    }
  },
);
