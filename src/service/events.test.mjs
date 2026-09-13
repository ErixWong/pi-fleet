import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

process.env.DB_NAME = 'erix';

const events = await tsImport('./event-outbox.ts', import.meta.url);
const { recordEvent, publishPending, markPublished, markFailed, pruneNotified } = events;
const { getPool, initSchema, withTransaction } = events;

await initSchema();

const eventIds = [];
const uniqueResource = `evt-${Date.now().toString(36)}`;
const actorAccountId = `acct-${Date.now().toString(36)}`;
const actorPrincipalId = `prn-${Date.now().toString(36)}`;

await getPool().query(
  `INSERT INTO account (id, name, created_at) VALUES (?, ?, NOW())`,
  [actorAccountId, actorAccountId],
);
await getPool().query(
  `INSERT INTO principal (id, account_id, kind, name, created_at)
   VALUES (?, ?, 'agent', ?, NOW())`,
  [actorPrincipalId, actorAccountId, actorPrincipalId],
);

async function createEvent(input = {}) {
  const id = await withTransaction((conn) =>
    recordEvent(conn, {
      action: input.action ?? 'test.created',
      resource_type: 'test',
      resource_id: `${uniqueResource}-${eventIds.length}`,
      payload: input.payload ?? { test: true },
      retention: input.retention,
    }),
  );
  eventIds.push(id);
  return id;
}

test('同事务一致性：rollback 不产生事件，commit 后事件存在', { concurrency: false }, async () => {
  let rolledBackId;
  await assert.rejects(
    withTransaction(async (conn) => {
      rolledBackId = await recordEvent(conn, {
        action: 'test.rollback',
        resource_type: 'test',
        resource_id: `${uniqueResource}-rollback`,
      });
      throw new Error('intentional rollback');
    }),
    /intentional rollback/,
  );
  const rolledBackRows = await getPool().query('SELECT id FROM event WHERE id = ?', [rolledBackId]);
  assert.equal(rolledBackRows.length, 0);

  const committedId = await createEvent({ action: 'test.commit' });
  const committedRows = await getPool().query('SELECT id FROM event WHERE id = ?', [committedId]);
  assert.equal(committedRows.length, 1);
});

test('outbox 返回未投递事件并标记，第二次不重复返回', { concurrency: false }, async () => {
  const id = await createEvent({ action: 'test.outbox' });
  const published = await publishPending({ limit: 100 });
  assert.equal(published.some((event) => event.id === id), true);
  assert.equal(published.find((event) => event.id === id)?.published_at !== null, true);
  const second = await publishPending({ limit: 100 });
  assert.equal(second.some((event) => event.id === id), false);
});

test('recordEvent 未传 account_id 时从 actor principal 推导账号', { concurrency: false }, async () => {
  const id = await withTransaction((conn) =>
    recordEvent(conn, {
      actor_principal_id: actorPrincipalId,
      action: 'test.account-derived',
      resource_type: 'test',
      resource_id: `${uniqueResource}-account-derived`,
    }),
  );
  eventIds.push(id);
  const rows = await getPool().query('SELECT account_id FROM event WHERE id = ?', [id]);
  assert.equal(rows[0].account_id, actorAccountId);
});

test('markFailed 递增 attempts、写入错误并应用 next_attempt_at', { concurrency: false }, async () => {
  const id = await createEvent({ action: 'test.retry' });
  const nextAttemptAt = '2999-01-01 00:00:00';
  await markFailed(id, 'delivery failed', nextAttemptAt);
  const rows = await getPool().query(
    'SELECT published_at, attempts, last_error, next_attempt_at FROM event WHERE id = ?',
    [id],
  );
  assert.equal(rows[0].published_at, null);
  assert.equal(Number(rows[0].attempts), 1);
  assert.equal(rows[0].last_error, 'delivery failed');
  assert.equal(rows[0].next_attempt_at, nextAttemptAt);
  assert.equal((await publishPending({ limit: 100 })).some((event) => event.id === id), false);
});

test('SKIP LOCKED 不重复消费：两个连接并发消费同一批事件', { concurrency: false }, async () => {
  const ids = await Promise.all([
    createEvent({ action: 'test.concurrent-a' }),
    createEvent({ action: 'test.concurrent-b' }),
  ]);
  const [first, second] = await Promise.all([
    publishPending({ limit: 1 }),
    publishPending({ limit: 1 }),
  ]);
  const consumed = [...first, ...second].filter((event) => ids.includes(event.id));
  assert.equal(consumed.length, 2);
  assert.equal(new Set(consumed.map((event) => event.id)).size, 2);
});

test('markPublished 可确认事件，pruneNotified 不删除 audit', { concurrency: false }, async () => {
  const notifyId = await createEvent({ action: 'test.notify', retention: 'notify' });
  const auditId = await createEvent({ action: 'test.audit', retention: 'audit' });
  await markPublished(notifyId);
  await markPublished(auditId);
  await getPool().query(
    `UPDATE event SET occurred_at = '2000-01-01 00:00:00'
      WHERE id IN (?, ?)`,
    [notifyId, auditId],
  );
  assert.equal(await pruneNotified({ olderThanDays: 1 }), 1);
  assert.equal((await getPool().query('SELECT id FROM event WHERE id = ?', [notifyId])).length, 0);
  assert.equal((await getPool().query('SELECT id FROM event WHERE id = ?', [auditId])).length, 1);
});

test.after(async () => {
  if (eventIds.length > 0) {
    await getPool().query(
      `DELETE FROM event WHERE id IN (${eventIds.map(() => '?').join(',')})`,
      eventIds,
    );
  }
  await getPool().query('DELETE FROM principal WHERE id = ?', [actorPrincipalId]);
  await getPool().query('DELETE FROM account WHERE id = ?', [actorAccountId]);
  await getPool().end();
});
