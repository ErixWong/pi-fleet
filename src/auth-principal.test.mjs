import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { tsImport } from 'tsx/esm/api';

process.env.DB_NAME_NEW ??= 'erix';

const identity = await tsImport('./service/identity.js', import.meta.url);
const auth = await tsImport('./auth-principal.ts', import.meta.url);
const {
  createAccount,
  createApiKey,
  createPrincipal,
  getPool,
  initSchema,
  revokeApiKey,
} = identity;
const {
  currentPrincipal,
  hasScopes,
  principalAuthMiddleware,
  requireScope,
} = auth;

await initSchema();

const account = await createAccount({ name: `auth-principal-test-${Date.now()}` });
const host = await createPrincipal({
  account_id: account.id,
  kind: 'host',
  name: `auth-principal-host-${Date.now()}`,
});
const readKey = await createApiKey({
  principal_id: host.id,
  scopes: ['task:read'],
});
const fullKey = await createApiKey({
  principal_id: host.id,
  scopes: ['task:read', 'task:write'],
});
const revokedKey = await createApiKey({
  principal_id: host.id,
  scopes: ['task:read'],
});
await revokeApiKey(revokedKey.apiKey.id);

await getPool().query(
  `UPDATE device SET last_seen_at = '2000-01-01 00:00:00' WHERE principal_id = ?`,
  [host.id],
);

const app = express();
app.use((_req, res, next) => {
  res.setHeader('Connection', 'close');
  next();
});
app.get('/protected', principalAuthMiddleware(), (_req, res) => {
  const context = currentPrincipal();
  res.json({
    principal_id: context?.principal.id,
    account_id: context?.account_id,
    key_id: context?.key_id,
    can_read: hasScopes('task:read'),
  });
});
app.get(
  '/write',
  principalAuthMiddleware(),
  requireScope('task:write'),
  (_req, res) => res.json({ ok: true }),
);

const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function request(path, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}${path}`, {
      headers,
      agent: false,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        response: { status: response.statusCode },
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('无 Bearer 返回 401', async () => {
  const { response, body } = await request('/protected');
  assert.equal(response.status, 401);
  assert.deepEqual(body, { error: 'missing bearer token' });
});

test('无效或撤销 key 返回 401', async () => {
  const invalid = await request('/protected', 'pk_invalid');
  assert.equal(invalid.response.status, 401);
  assert.deepEqual(invalid.body, { error: 'invalid or revoked key' });

  const revoked = await request('/protected', revokedKey.key);
  assert.equal(revoked.response.status, 401);
  assert.deepEqual(revoked.body, { error: 'invalid or revoked key' });
});

test('有效 key 放行，ALS 可取 principal，host 会刷新 last_seen_at', async () => {
  const { response, body } = await request('/protected', fullKey.key);
  assert.equal(response.status, 200);
  assert.equal(body.principal_id, host.id);
  assert.equal(body.account_id, account.id);
  assert.equal(body.key_id, fullKey.apiKey.id);
  assert.equal(body.can_read, true);

  const rows = await getPool().query(
    `SELECT last_seen_at FROM device WHERE principal_id = ?`,
    [host.id],
  );
  assert.notEqual(rows[0].last_seen_at, '2000-01-01 00:00:00');
});

test('requireScope 不足返回 404，scope 足够时放行', async () => {
  const insufficient = await request('/write', readKey.key);
  assert.equal(insufficient.response.status, 404);
  assert.deepEqual(insufficient.body, { error: 'not found' });

  const sufficient = await request('/write', fullKey.key);
  assert.equal(sufficient.response.status, 200);
  assert.deepEqual(sufficient.body, { ok: true });
});

test.after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await getPool().query(
    `DELETE FROM api_key WHERE principal_id = ?`,
    [host.id],
  );
  await getPool().query(
    `DELETE FROM device WHERE principal_id = ?`,
    [host.id],
  );
  await getPool().query(
    `DELETE FROM principal WHERE id = ?`,
    [host.id],
  );
  await getPool().query(
    `DELETE FROM account WHERE id = ?`,
    [account.id],
  );
  const pools = new Set([getPool(), auth.getPool()]);
  for (const pool of pools) await pool.end();
});
