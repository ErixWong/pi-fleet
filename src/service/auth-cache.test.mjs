import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

process.env.DB_NAME = 'erix';

const identity = await tsImport('./identity.ts', import.meta.url);
const authCache = await tsImport('./auth-cache.ts', import.meta.url);
const {
  authCacheSize,
  clearAuthCache,
  createAccount,
  createApiKey,
  createPrincipal,
  getPool,
  initSchema,
  revokeApiKey,
  verifyApiKey,
} = identity;
const { AUTH_CACHE_TTL_MS } = authCache;

await initSchema();
clearAuthCache();

assert.ok(
  AUTH_CACHE_TTL_MS >= 30_000 && AUTH_CACHE_TTL_MS <= 60_000,
  '鉴权缓存 TTL 必须在 30~60s',
);

const account = await createAccount({ name: `auth-cache-test-${Date.now()}` });
const host = await createPrincipal({
  account_id: account.id,
  kind: 'host',
  name: `auth-cache-host-${Date.now()}`,
});
const keyA = await createApiKey({ principal_id: host.id, scopes: ['task:read'] });
const keyB = await createApiKey({ principal_id: host.id, scopes: ['task:write'] });

test('校验走进程内缓存：重复校验命中缓存', async () => {
  clearAuthCache();
  const first = await verifyApiKey(keyA.key);
  assert.equal(first.key_id, keyA.apiKey.id);
  assert.equal(authCacheSize(), 1);
  const second = await verifyApiKey(keyA.key);
  assert.equal(second.key_id, keyA.apiKey.id);
  assert.equal(authCacheSize(), 1);
});

test('revoke 主动失效对应 key：立即返回未认证', async () => {
  const before = await verifyApiKey(keyB.key);
  assert.equal(before.key_id, keyB.apiKey.id);
  const sizeBefore = authCacheSize();
  await revokeApiKey(keyB.apiKey.id);
  // 只主动失效被 revoke 的 key，其余缓存项不受影响。
  assert.equal(authCacheSize(), sizeBefore - 1);
  const after = await verifyApiKey(keyB.key);
  assert.equal(after, null);
});

test('无效 key 负结果同样缓存', async () => {
  clearAuthCache();
  assert.equal(await verifyApiKey('pk_not_a_real_key'), null);
  assert.equal(authCacheSize(), 1);
  assert.equal(await verifyApiKey('pk_not_a_real_key'), null);
  assert.equal(authCacheSize(), 1);
});

test('缓存中的 principal 信息包含 scope 与 account', async () => {
  clearAuthCache();
  const verified = await verifyApiKey(keyA.key);
  assert.equal(verified.principal.id, host.id);
  assert.equal(verified.principal.account_id, account.id);
  assert.deepEqual(verified.scopes, ['task:read']);
});

test.after(async () => {
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
  clearAuthCache();
  // tsImport 的每个模块图持有独立 pool 单例，需分别关闭，否则测试进程挂起。
  const pools = new Set([getPool(), authCache.getPool()]);
  for (const pool of pools) await pool.end();
});
