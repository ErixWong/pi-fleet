import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

process.env.DB_NAME = 'erix';

const identity = await tsImport('./identity.ts', import.meta.url);
const hostControl = await tsImport('./host-control.ts', import.meta.url);
const {
  createAccount,
  createPrincipal,
  getPool,
  initSchema,
} = identity;
const {
  CONTROL_PENDING_LIMIT,
  CONTROL_PENDING_TTL_MS,
  answerListDirRequest,
  createListDirRequest,
  getControlRequest,
  listPendingControlRequests,
} = hostControl;

await initSchema();

const account = await createAccount({ name: `host-control-test-${Date.now()}` });
const host = await createPrincipal({
  account_id: account.id,
  kind: 'host',
  name: `host-control-host-${Date.now()}`,
});
const otherHost = await createPrincipal({
  account_id: account.id,
  kind: 'host',
  name: `host-control-other-${Date.now()}`,
});

const createdRequestIds = [];

function pathAt(index) {
  return `/home/pi/host-control-test/folder-${Date.now()}-${index}`;
}

test('同 host+path pending 去重：重复发起返回同一请求', async () => {
  const path = pathAt('dedup');
  const first = await createListDirRequest(account.id, host.id, path);
  const second = await createListDirRequest(account.id, host.id, path);
  assert.equal(first.id, second.id);
  assert.equal(first.status, 'pending');
  createdRequestIds.push(first.id);
});

test('path 必须是 /home/ 下且不逃逸的规范化路径', async () => {
  await assert.rejects(
    () => createListDirRequest(account.id, host.id, '/etc/passwd'),
    /\/home\//,
  );
  await assert.rejects(
    () => createListDirRequest(account.id, host.id, '/home/pi/../../etc'),
    /\/home\//,
  );
});

test('每 host pending 上限 5，超限拒绝', async () => {
  // 先清掉前面用例遗留的 pending，独占配额。
  await getPool().query(
    `UPDATE host_control_request SET status = 'expired', answered_at = ?
      WHERE host_principal_id = ? AND status = 'pending'`,
    [new Date().toISOString().slice(0, 19).replace('T', ' '), host.id],
  );
  const ids = [];
  for (let index = 0; index < CONTROL_PENDING_LIMIT; index += 1) {
    ids.push((await createListDirRequest(account.id, host.id, pathAt(`limit-${index}`))).id);
  }
  createdRequestIds.push(...ids);
  await assert.rejects(
    () => createListDirRequest(account.id, host.id, pathAt('over-limit')),
    /上限/,
  );
  // 上限按主机隔离：另一台主机不受限。
  const other = await createListDirRequest(account.id, otherHost.id, pathAt('other-1'));
  createdRequestIds.push(other.id);
  // 清出 pending 配额，避免影响后续用例。
  await getPool().query(
    `UPDATE host_control_request SET status = 'expired', answered_at = ?
      WHERE host_principal_id = ? AND status = 'pending'`,
    [new Date().toISOString().slice(0, 19).replace('T', ' '), host.id],
  );
});

test('pending 超 30s 惰性 expire：再次发起与拉取都视为 expired', async () => {
  const stale = await createListDirRequest(account.id, host.id, pathAt('stale'));
  createdRequestIds.push(stale.id);
  const staleAt = new Date(Date.now() - CONTROL_PENDING_TTL_MS - 2000);
  const pad = (value) => String(value).padStart(2, '0');
  const staleString = `${staleAt.getFullYear()}-${pad(staleAt.getMonth() + 1)}-${pad(staleAt.getDate())} ${pad(staleAt.getHours())}:${pad(staleAt.getMinutes())}:${pad(staleAt.getSeconds())}`;
  await getPool().query(
    `UPDATE host_control_request SET requested_at = ? WHERE id = ?`,
    [staleString, stale.id],
  );

  const refreshed = await getControlRequest(stale.id);
  assert.equal(refreshed.status, 'expired');
  assert.ok(refreshed.answered_at);

  const pending = await listPendingControlRequests(host.id);
  assert.equal(
    pending.some((request) => request.id === stale.id),
    false,
  );
});

test('list_dir 回传：有效路径 upsert 进 host_folder，非法路径逐项容错', async () => {
  const request = await createListDirRequest(account.id, host.id, '/home/pi/projects');
  createdRequestIds.push(request.id);
  const answered = await answerListDirRequest(host.id, request.id, {
    entries: [
      { path: '/home/pi/projects/demo' },
      { path: '/etc/passwd' },
      { path: '/home/pi/projects/demo' },
      { path: '/home/pi/projects/../projects/notes' },
    ],
  });
  assert.equal(answered.status, 'answered');
  assert.ok(answered.answered_at);
  const entries = answered.result.entries;
  assert.deepEqual(
    entries.filter((entry) => !entry.error).map((entry) => entry.path),
    ['/home/pi/projects/demo', '/home/pi/projects/notes'],
  );
  assert.equal(entries.filter((entry) => entry.error).length, 1);

  const folders = await getPool().query(
    `SELECT path FROM host_folder WHERE host_principal_id = ? ORDER BY path`,
    [host.id],
  );
  const paths = folders.map((row) => String(row.path));
  assert.ok(paths.includes('/home/pi/projects/demo'));
  assert.ok(paths.includes('/home/pi/projects/notes'));
});

test('list_dir 失败也回传 error 并结束请求；重复回传幂等', async () => {
  const request = await createListDirRequest(account.id, host.id, '/home/pi/missing');
  createdRequestIds.push(request.id);
  const failed = await answerListDirRequest(host.id, request.id, {
    error: '读取目录失败：ENOENT',
  });
  assert.equal(failed.status, 'answered');
  assert.equal(failed.error, '读取目录失败：ENOENT');
  assert.equal(failed.result, null);

  const again = await answerListDirRequest(host.id, request.id, {
    entries: [{ path: '/home/pi/missing/late' }],
  });
  assert.equal(again.error, '读取目录失败：ENOENT');
});

test('非本主机的 daemon 不能回传请求（按不存在处理）', async () => {
  const request = await createListDirRequest(account.id, host.id, pathAt('cross'));
  createdRequestIds.push(request.id);
  await assert.rejects(
    () => answerListDirRequest(otherHost.id, request.id, { entries: [] }),
    /not found/,
  );
});

test('daemon 拉取 pending：仅返回本主机未过期请求', async () => {
  const path = pathAt('poll');
  const request = await createListDirRequest(account.id, host.id, path);
  createdRequestIds.push(request.id);
  const pending = await listPendingControlRequests(host.id);
  assert.ok(pending.some((item) => item.id === request.id));
  assert.equal(
    pending.some((item) => item.path === '/home/pi/host-control-test/nope'),
    false,
  );
  const otherPending = await listPendingControlRequests(otherHost.id);
  assert.equal(otherPending.some((item) => item.id === request.id), false);
});

test.after(async () => {
  await getPool().query(
    `DELETE FROM host_control_request WHERE host_principal_id IN (?, ?)`,
    [host.id, otherHost.id],
  );
  await getPool().query(
    `DELETE FROM host_folder WHERE host_principal_id IN (?, ?)`,
    [host.id, otherHost.id],
  );
  await getPool().query(
    `DELETE FROM device WHERE principal_id IN (?, ?)`,
    [host.id, otherHost.id],
  );
  await getPool().query(
    `DELETE FROM principal WHERE id IN (?, ?)`,
    [host.id, otherHost.id],
  );
  await getPool().query(
    `DELETE FROM account WHERE id = ?`,
    [account.id],
  );
  // tsImport 的每个模块图持有独立 pool 单例，需分别关闭，否则测试进程挂起。
  const pools = new Set([getPool(), hostControl.getPool()]);
  for (const pool of pools) await pool.end();
});
