import { Router } from 'express';
import { getPool } from '../../db/pool.js';
import {
  createApiKey,
  verifyPassword,
  type Scope,
} from '../../service/identity.js';

export const authV2Router = Router();

const LOGIN_SCOPES: Scope[] = [
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
  'moderate',
  'key:manage',
  'host:manage',
];

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function expiresAtAfterHours(hours: number): string {
  const date = new Date(Date.now() + hours * 3600_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

authV2Router.post('/login', async (req, res, next) => {
  try {
    const body = bodyRecord(req.body);
    const username = typeof body.username === 'string' ? body.username : null;
    const password = typeof body.password === 'string' ? body.password : null;
    const accountName = body.account_name === undefined
      ? undefined
      : typeof body.account_name === 'string' ? body.account_name : null;
    if (username === null || password === null || accountName === null) {
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }

    const params: unknown[] = [username];
    const accountPredicate = accountName === undefined ? '' : ' AND a.name = ?';
    if (accountName !== undefined) params.push(accountName);
    const result = await getPool().query(
      `SELECT p.id, p.name, p.kind, p.password_hash,
              a.id AS account_id, a.name AS account_name
         FROM principal p
         JOIN account a ON a.id = p.account_id
        WHERE p.kind = 'user'
          AND p.name = ?
          AND p.deleted_at IS NULL
          AND a.status = 'active'
          AND a.deleted_at IS NULL
          ${accountPredicate}`,
      params,
    );
    if (result.length !== 1) {
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }

    const row = result[0] as Record<string, unknown>;
    const passwordHash = typeof row.password_hash === 'string' ? row.password_hash : '';
    if (!verifyPassword(password, passwordHash)) {
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }

    const expiresAt = expiresAtAfterHours(12);
    const created = await createApiKey({
      principal_id: String(row.id),
      scopes: LOGIN_SCOPES,
      label: 'login',
      expires_at: expiresAt,
    });
    res.json({
      key: created.key,
      expires_at: created.apiKey.expires_at,
      principal: {
        id: String(row.id),
        name: String(row.name),
        kind: String(row.kind),
      },
      account: {
        id: String(row.account_id),
        name: String(row.account_name),
      },
    });
  } catch (error) {
    next(error);
  }
});
