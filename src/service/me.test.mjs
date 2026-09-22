import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

process.env.DB_NAME = 'erix';

const identity = await tsImport('./identity.ts', import.meta.url);
const {
  createAccount,
  createPrincipal,
  createApiKey,
  createPersonalApiKey,
  changePassword,
  getPrincipal,
  listPersonalApiKeys,
  revokePersonalApiKey,
  verifyApiKey,
  verifyPassword,
  hashPassword,
} = identity;
const { getPool, initSchema } = identity;

await initSchema();

const account = await createAccount({ name: `me-test-${Date.now()}` });
const password = `me-test-password-${Date.now()}`;
const user = await createPrincipal({
  account_id: account.id,
  kind: 'user',
  name: `me-test-user-${Date.now()}`,
  password_hash: hashPassword(password),
});
const other = await createPrincipal({
  account_id: account.id,
  kind: 'user',
  name: `me-test-other-${Date.now()}`,
  password_hash: hashPassword('other-password'),
});
const createdApiKeyIds = [];
const createdPrincipalIds = [user.id, other.id];

test('changePassword 旧密码错误返回 401，正确后更新 hash 并吊销 login key', async () => {
  const loginKey = await createApiKey({
    principal_id: user.id,
    scopes: ['task:read', 'key:manage'],
    label: 'login',
  });
  const longTermKey = await createApiKey({
    principal_id: user.id,
    scopes: ['task:read'],
    label: 'cli',
  });
  createdApiKeyIds.push(loginKey.apiKey.id, longTermKey.apiKey.id);

  await assert.rejects(
    changePassword(user.id, 'wrong-old-password', 'new-password-1'),
    (error) => error.status === 401,
  );

  const newPassword = `me-test-new-${Date.now()}`;
  await changePassword(user.id, password, newPassword);

  const principal = await getPrincipal(user.id);
  assert.ok(principal?.password_hash);
  assert.equal(verifyPassword(newPassword, principal.password_hash), true);
  assert.equal(verifyPassword(password, principal.password_hash), false);

  // login key 被吊销，其他 label 的长期 key 不受影响。
  assert.equal(await verifyApiKey(loginKey.key), null);
  assert.equal((await verifyApiKey(longTermKey.key))?.key_id, longTermKey.apiKey.id);

  // 记录 password.changed 事件。
  const events = await getPool().query(
    `SELECT action FROM event
      WHERE resource_type = 'principal' AND resource_id = ? AND action = 'password.changed'`,
    [user.id],
  );
  assert.equal(events.length, 1);
});

test('changePassword 拒绝空新密码', async () => {
  await assert.rejects(changePassword(user.id, `me-test-new`, ''), /非空/);
});

test('createPersonalApiKey scopes 必须是本人现有 key scopes 的子集', async () => {
  const loginKey = await createApiKey({
    principal_id: user.id,
    scopes: ['task:read', 'task:write', 'key:manage'],
    label: 'login',
  });
  createdApiKeyIds.push(loginKey.apiKey.id);

  const subset = await createPersonalApiKey(user.id, {
    label: 'me-test-subset',
    scopes: ['task:read'],
    expires_at: null,
  });
  createdApiKeyIds.push(subset.apiKey.id);
  assert.equal(subset.apiKey.expires_at, null);
  assert.equal(typeof subset.key, 'string');
  assert.equal((await verifyApiKey(subset.key))?.key_id, subset.apiKey.id);

  // 越权 scope 按资源不存在隐藏。
  await assert.rejects(
    createPersonalApiKey(user.id, { label: 'me-test-elevated', scopes: ['moderate'] }),
    (error) => error.status === 404,
  );
  await assert.rejects(
    createPersonalApiKey(user.id, { label: 'me-test-unknown', scopes: ['scope:nope'] }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    createPersonalApiKey(user.id, { label: 'me-test-empty', scopes: [] }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    createPersonalApiKey(user.id, {
      label: 'me-test-bad-expiry',
      scopes: ['task:read'],
      expires_at: 'not-a-time',
    }),
    (error) => error.status === 400,
  );

  // 只有窄 scope key 的主体不能签发自己没有的 scope。
  const narrowUser = await createPrincipal({
    account_id: account.id,
    kind: 'user',
    name: `me-test-narrow-user-${Date.now()}`,
    password_hash: hashPassword('narrow-password'),
  });
  const narrow = await createApiKey({
    principal_id: narrowUser.id,
    scopes: ['task:read'],
    label: 'login',
  });
  createdApiKeyIds.push(narrow.apiKey.id);
  createdPrincipalIds.push(narrowUser.id);
  await assert.rejects(
    createPersonalApiKey(narrowUser.id, {
      label: 'me-test-narrow-elevated',
      scopes: ['task:read', 'task:write'],
    }),
    (error) => error.status === 404,
  );

  // 吊销和过期的 key 不再贡献可用 scopes。
  const wide = await createApiKey({
    principal_id: other.id,
    scopes: ['task:read', 'moderate'],
    label: 'login',
  });
  createdApiKeyIds.push(wide.apiKey.id);
  await revokePersonalApiKey(other.id, wide.apiKey.id);
  await assert.rejects(
    createPersonalApiKey(other.id, { label: 'me-test-revoked', scopes: ['moderate'] }),
    (error) => error.status === 404,
  );
  const expired = await createApiKey({
    principal_id: other.id,
    scopes: ['task:write'],
    label: 'me-test-expired',
    expires_at: '2000-01-01 00:00:00',
  });
  createdApiKeyIds.push(expired.apiKey.id);
  await assert.rejects(
    createPersonalApiKey(other.id, { label: 'me-test-expired-scope', scopes: ['task:write'] }),
    (error) => error.status === 404,
  );
});

test('listPersonalApiKeys 按 created_at 倒序返回本人全部 key', async () => {
  const keys = await listPersonalApiKeys(user.id);
  assert.ok(keys.length >= 3);
  const timestamps = keys.map((key) => `${key.created_at}#${key.id}`);
  assert.deepEqual(timestamps, [...timestamps].sort().reverse());
  for (const key of keys) {
    assert.equal(key.principal_id, user.id);
    assert.ok(Array.isArray(key.scopes));
    assert.equal('key' in key, false);
    assert.equal('key_hash' in key, false);
  }
});

test('revokePersonalApiKey 只能吊销本人的 key，他人 key 一律 404', async () => {
  const own = await createPersonalApiKey(user.id, {
    label: 'me-test-revoke-own',
    scopes: ['task:read'],
  });
  createdApiKeyIds.push(own.apiKey.id);
  const foreign = await createApiKey({
    principal_id: other.id,
    scopes: ['task:read'],
    label: 'me-test-foreign',
  });
  createdApiKeyIds.push(foreign.apiKey.id);

  await assert.rejects(
    revokePersonalApiKey(user.id, foreign.apiKey.id),
    (error) => error.status === 404,
  );
  assert.equal((await verifyApiKey(foreign.key))?.key_id, foreign.apiKey.id);

  await revokePersonalApiKey(user.id, own.apiKey.id);
  assert.equal(await verifyApiKey(own.key), null);
  // 重复吊销按资源不存在处理。
  await assert.rejects(
    revokePersonalApiKey(user.id, own.apiKey.id),
    (error) => error.status === 404,
  );
});

test.after(async () => {
  if (createdApiKeyIds.length > 0) {
    await getPool().query(
      `DELETE FROM api_key WHERE id IN (${createdApiKeyIds.map(() => '?').join(',')})`,
      createdApiKeyIds,
    );
  }
  await getPool().query(
    `DELETE FROM principal WHERE id IN (${createdPrincipalIds.map(() => '?').join(',')})`,
    createdPrincipalIds,
  );
  await getPool().query('DELETE FROM account WHERE id = ?', [account.id]);
  await getPool().end();
});
