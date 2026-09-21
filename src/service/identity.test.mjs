import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

process.env.DB_NAME = 'erix';

const identity = await tsImport('./identity.ts', import.meta.url);
const {
  createAccount,
  createPrincipal,
  createApiKey,
  getPrincipal,
  listApiKeys,
  registerDevice,
  reportExecutors,
  revokeApiKey,
  rotateApiKey,
  touchDevice,
  upsertHostFolders,
  verifyApiKey,
  hasScope,
} = identity;
const { getPool, initSchema } = identity;

await initSchema();

const account = await createAccount({ name: `identity-test-${Date.now()}` });
const host = await createPrincipal({
  account_id: account.id,
  kind: 'host',
  name: 'identity-test-host',
});
const agent = await createPrincipal({
  account_id: account.id,
  kind: 'agent',
  name: 'identity-test-agent',
  host_principal_id: host.id,
});
const createdApiKeyIds = [];
const createdPrincipalIds = [host.id, agent.id];
const eventlessTestPrefix = `identity-${Date.now()}`;

test('创建主体时 host 自动创建 device，并支持心跳和执行器上报', async () => {
  const deviceRows = await getPool().query(
    'SELECT principal_id FROM device WHERE principal_id = ?',
    [host.id],
  );
  assert.equal(deviceRows.length, 1);

  const device = await registerDevice({
    principal_id: host.id,
    hostname: 'test-host',
    os: 'linux',
    run_user: 'pi-agent',
  });
  assert.equal(device.hostname, 'test-host');
  assert.equal(device.os, 'linux');
  assert.equal(device.run_user, 'pi-agent');

  const touched = await touchDevice(host.id);
  assert.ok(touched.last_seen_at);

  const executors = await reportExecutors({
    principal_id: host.id,
    clis: ['pi', 'codex'],
    selected: 'pi',
  });
  assert.deepEqual(
    executors.map((executor) => [executor.cli, executor.enabled, executor.selected]),
    [
      ['codex', true, false],
      ['pi', true, true],
    ],
  );
  assert.equal((await getPrincipal(agent.id))?.host_principal_id, host.id);
});

test('主机目录上报去重、更新时间、拒绝越界路径并截断到 200 条', async () => {
  const root = `/home/identity-test-${Date.now()}`;
  const first = await upsertHostFolders(host.id, [
    `${root}/one`,
    `${root}/one/../one`,
    `${root}/two`,
  ]);
  assert.deepEqual(first.map((folder) => folder.path), [`${root}/one`, `${root}/two`]);

  await getPool().query(
    'UPDATE host_folder SET last_seen_at = ? WHERE host_principal_id = ? AND path = ?',
    ['2000-01-01 00:00:00', host.id, `${root}/one`],
  );
  const refreshed = await upsertHostFolders(host.id, [`${root}/one`]);
  assert.ok(refreshed.find((folder) => folder.path === `${root}/one`)?.last_seen_at > '2000-01-01 00:00:00');

  await assert.rejects(
    upsertHostFolders(host.id, ['/tmp/not-under-home']),
    /必须是 \/home\/ 下/,
  );

  await getPool().query('DELETE FROM host_folder WHERE host_principal_id = ?', [host.id]);
  const capped = await upsertHostFolders(
    host.id,
    Array.from({ length: 205 }, (_, index) => `${root}/folder-${index}`),
  );
  assert.equal(capped.length, 200);
});

test('api_key 命中、未命中、撤销和过期校验，并更新 last_used_at', async () => {
  const created = await createApiKey({
    principal_id: agent.id,
    scopes: ['task:read', 'task:submit'],
    label: eventlessTestPrefix,
  });
  createdApiKeyIds.push(created.apiKey.id);
  const verified = await verifyApiKey(created.key);
  assert.equal(verified?.key_id, created.apiKey.id);
  assert.deepEqual(verified?.scopes, ['task:read', 'task:submit']);
  assert.equal(verified?.principal.id, agent.id);
  assert.equal((await listApiKeys(agent.id)).find((key) => key.id === created.apiKey.id)?.last_used_at !== null, true);
  assert.equal(await verifyApiKey(`${created.key}-invalid`), null);

  await revokeApiKey(created.apiKey.id);
  assert.equal(await verifyApiKey(created.key), null);

  const expired = await createApiKey({
    principal_id: agent.id,
    scopes: ['task:read'],
    expires_at: '2000-01-01 00:00:00',
  });
  createdApiKeyIds.push(expired.apiKey.id);
  assert.equal(await verifyApiKey(expired.key), null);
});

test('key 轮换保留宽限期并继承旧 scopes，宽限期后拒绝旧 key', async () => {
  const old = await createApiKey({
    principal_id: agent.id,
    scopes: ['post:read', 'task:claim'],
  });
  createdApiKeyIds.push(old.apiKey.id);
  const rotated = await rotateApiKey(agent.id, { grace_hours: 1 });
  createdApiKeyIds.push(rotated.apiKey.id);
  assert.deepEqual(rotated.apiKey.scopes, ['post:read', 'task:claim']);
  assert.equal((await verifyApiKey(old.key))?.key_id, old.apiKey.id);
  assert.equal((await verifyApiKey(rotated.key))?.key_id, rotated.apiKey.id);

  await getPool().query(
    'UPDATE api_key SET expires_at = ? WHERE id = ?',
    ['2000-01-01 00:00:00', old.apiKey.id],
  );
  assert.equal(await verifyApiKey(old.key), null);
  assert.equal((await verifyApiKey(rotated.key))?.key_id, rotated.apiKey.id);
});

test('key 轮换只宽限指定 key，其他未撤销 key 的过期时间不变', async () => {
  const first = await createApiKey({
    principal_id: agent.id,
    scopes: ['post:read'],
  });
  const second = await createApiKey({
    principal_id: agent.id,
    scopes: ['task:read'],
    expires_at: '2099-01-01 00:00:00',
  });
  createdApiKeyIds.push(first.apiKey.id, second.apiKey.id);

  const rotated = await rotateApiKey(agent.id, {
    key_id: first.apiKey.id,
    grace_hours: 1,
  });
  createdApiKeyIds.push(rotated.apiKey.id);

  const keys = await listApiKeys(agent.id);
  const firstAfter = keys.find((key) => key.id === first.apiKey.id);
  const secondAfter = keys.find((key) => key.id === second.apiKey.id);
  assert.ok(firstAfter?.expires_at);
  assert.equal(secondAfter?.expires_at, '2099-01-01 00:00:00');
});

test('禁用账号的 key 不再通过认证', async () => {
  const created = await createApiKey({
    principal_id: agent.id,
    scopes: ['task:read'],
  });
  createdApiKeyIds.push(created.apiKey.id);
  await getPool().query(
    `UPDATE account SET status = 'disabled' WHERE id = ?`,
    [account.id],
  );
  assert.equal(await verifyApiKey(created.key), null);
  await getPool().query(
    `UPDATE account SET status = 'active' WHERE id = ?`,
    [account.id],
  );
});

test('hasScope 支持单 scope 和 all-of 检查', () => {
  assert.equal(hasScope(['task:read', 'task:submit'], 'task:read'), true);
  assert.equal(hasScope(['task:read'], 'task:write'), false);
  assert.equal(hasScope(['task:read', 'task:submit'], ['task:read', 'task:submit']), true);
  assert.equal(hasScope(['task:read'], ['task:read', 'task:submit']), false);
});

test.after(async () => {
  if (createdApiKeyIds.length > 0) {
    await getPool().query(
      `DELETE FROM api_key WHERE id IN (${createdApiKeyIds.map(() => '?').join(',')})`,
      createdApiKeyIds,
    );
  }
  await getPool().query('DELETE FROM host_folder WHERE host_principal_id IN (?, ?)', [host.id, agent.id]);
  await getPool().query(
    `DELETE FROM device_executor WHERE principal_id IN (${createdPrincipalIds.map(() => '?').join(',')})`,
    createdPrincipalIds,
  );
  await getPool().query(
    `DELETE FROM device WHERE principal_id IN (${createdPrincipalIds.map(() => '?').join(',')})`,
    createdPrincipalIds,
  );
  await getPool().query(
    'DELETE FROM principal WHERE id = ?',
    [agent.id],
  );
  await getPool().query(
    'DELETE FROM principal WHERE id = ?',
    [host.id],
  );
  await getPool().query('DELETE FROM account WHERE id = ?', [account.id]);
  await getPool().end();
});
