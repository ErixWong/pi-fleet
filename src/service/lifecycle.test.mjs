import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

process.env.DB_NAME_NEW = 'erix';

const identity = await tsImport('./identity.ts', import.meta.url);
const posts = await tsImport('./posts.ts', import.meta.url);
const lifecycle = await tsImport('./lifecycle.ts', import.meta.url);
const poolModule = await tsImport('../db/pool.ts', import.meta.url);
const eventOutbox = await tsImport('./event-outbox.ts', import.meta.url);

const { createAccount, createPrincipal, initSchema } = identity;
const { createPost } = posts;
const { getLifecyclePool, runLifecycleCollection } = lifecycle;

await initSchema();

const account = await createAccount({ name: `lifecycle-test-${Date.now()}` });
const author = await createPrincipal({
  account_id: account.id,
  kind: 'user',
  name: `lifecycle-author-${Date.now()}`,
});
const assignee = await createPrincipal({
  account_id: account.id,
  kind: 'agent',
  name: `lifecycle-assignee-${Date.now()}`,
});
const postIds = [];

async function createTask(status, times) {
  const post = await createPost({
    account_id: account.id,
    kind: 'task',
    author_principal_id: author.id,
    title: `lifecycle-${postIds.length}`,
    body: 'lifecycle test task',
    visibility: 'public',
    task: {
      status,
      assignee_principal_id: times.assignee ?? null,
      deliverable_spec: '{"items":["result"]}',
      claimed_at: times.claimed_at ?? null,
      submitted_at: times.submitted_at ?? null,
    },
  });
  postIds.push(post.id);
  return post.id;
}

test('新模型生命周期按 claimed_at/submitted_at 回收，且事件同事务落库', {
  concurrency: false,
}, async () => {
  const now = new Date('2026-09-15T12:00:00');
  const staleClaimed = await createTask('claimed', {
    assignee: assignee.id,
    claimed_at: '2026-09-15 09:00:00',
  });
  const freshClaimed = await createTask('claimed', {
    assignee: assignee.id,
    claimed_at: '2026-09-15 11:00:00',
  });
  const stalePending = await createTask('pending_confirm', {
    assignee: assignee.id,
    submitted_at: '2026-09-07 11:59:00',
  });
  const freshPending = await createTask('pending_confirm', {
    assignee: assignee.id,
    submitted_at: '2026-09-10 12:00:00',
  });

  const result = await runLifecycleCollection({
    now,
    batch: 1,
  });
  assert.deepEqual(result, { reclaimed: 1, autoConfirmed: 1 });

  const taskRows = await getLifecyclePool().query(
    `SELECT post_id, status, assignee_principal_id, claimed_at, closed_at
       FROM post_task
      WHERE post_id IN (?, ?, ?, ?)
      ORDER BY post_id`,
    [staleClaimed, freshClaimed, stalePending, freshPending],
  );
  const byId = new Map(taskRows.map((row) => [row.post_id, row]));
  assert.equal(byId.get(staleClaimed).status, 'open');
  assert.equal(byId.get(staleClaimed).assignee_principal_id, null);
  assert.equal(byId.get(staleClaimed).claimed_at, null);
  assert.equal(byId.get(freshClaimed).status, 'claimed');
  assert.equal(byId.get(freshClaimed).assignee_principal_id, assignee.id);
  assert.equal(byId.get(stalePending).status, 'done');
  assert.equal(byId.get(stalePending).closed_at, '2026-09-15 12:00:00');
  assert.equal(byId.get(freshPending).status, 'pending_confirm');

  const events = await getLifecyclePool().query(
    `SELECT action, resource_id
       FROM event
      WHERE account_id = ?
        AND resource_id IN (?, ?, ?, ?)
        AND action IN ('task.reclaimed', 'task.auto_confirmed')`,
    [account.id, staleClaimed, freshClaimed, stalePending, freshPending],
  );
  assert.deepEqual(
    events.map((row) => [row.action, row.resource_id]).sort(),
    [
      ['task.auto_confirmed', stalePending],
      ['task.reclaimed', staleClaimed],
    ].sort(),
  );
});

test.after(async () => {
  const pool = getLifecyclePool();
  if (postIds.length > 0) {
    await pool.query(`DELETE FROM event WHERE account_id = ?`, [account.id]);
    await pool.query(`DELETE FROM post_task WHERE post_id IN (${postIds.map(() => '?').join(',')})`, postIds);
    await pool.query(`DELETE FROM post WHERE id IN (${postIds.map(() => '?').join(',')})`, postIds);
  }
  await pool.query('DELETE FROM principal WHERE id IN (?, ?)', [author.id, assignee.id]);
  await pool.query('DELETE FROM account WHERE id = ?', [account.id]);
  const pools = new Set([
    pool,
    identity.getPool(),
    posts.getPool(),
    poolModule.getPool(),
    eventOutbox.getPool(),
  ]);
  for (const currentPool of pools) await currentPool.end();
});
