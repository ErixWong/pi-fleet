import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

process.env.DB_NAME = 'erix';

const events = await tsImport('./event-outbox.ts', import.meta.url);
const { recordEvent, publishPending, markPublished, markFailed, pruneNotified } = events;
const { getPool, initSchema, withTransaction } = events;
const { listEventLog, getPool: getEventLogPool } = await tsImport('./event-log.ts', import.meta.url);

await initSchema();

const eventIds = [];
const uniqueResource = `evt-${Date.now().toString(36)}`;
const actionPrefix = `test.events.${Date.now().toString(36)}`;
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
      action: input.action ?? `${actionPrefix}.created`,
      resource_type: input.resourceType ?? 'test',
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
        action: `${actionPrefix}.rollback`,
        resource_type: 'test',
        resource_id: `${uniqueResource}-rollback`,
      });
      throw new Error('intentional rollback');
    }),
    /intentional rollback/,
  );
  const rolledBackRows = await getPool().query('SELECT id FROM event WHERE id = ?', [rolledBackId]);
  assert.equal(rolledBackRows.length, 0);

  const committedId = await createEvent({ action: `${actionPrefix}.commit` });
  const committedRows = await getPool().query('SELECT id FROM event WHERE id = ?', [committedId]);
  assert.equal(committedRows.length, 1);
});

test('outbox 返回未投递事件并标记，第二次不重复返回', { concurrency: false }, async () => {
  const foreignId = await createEvent({ action: 'other-process.pending' });
  const id = await createEvent({ action: `${actionPrefix}.outbox` });
  const published = await publishPending({ limit: 100, actionPrefix });
  assert.equal(published.some((event) => event.id === id), true);
  assert.equal(published.find((event) => event.id === id)?.published_at !== null, true);
  const foreignRows = await getPool().query('SELECT published_at FROM event WHERE id = ?', [foreignId]);
  assert.equal(foreignRows[0].published_at, null);
  const second = await publishPending({ limit: 100, actionPrefix });
  assert.equal(second.some((event) => event.id === id), false);
});

test('publishPending 对 actionPrefix 的 %, _, \\ 和 resourceType 使用显式 ESCAPE', { concurrency: false }, async () => {
  for (const prefix of ['%', '_', '\\']) {
    const id = await createEvent({
      action: `${prefix}literal-${actionPrefix}`,
      resourceType: `resource-${prefix}`,
    });
    const published = await publishPending({
      limit: 10,
      actionPrefix: prefix,
      resourceType: `resource-${prefix}`,
    });
    assert.equal(published.some((event) => event.id === id), true);
  }
});

test('recordEvent 未传 account_id 时从 actor principal 推导账号', { concurrency: false }, async () => {
  const id = await withTransaction((conn) =>
    recordEvent(conn, {
      actor_principal_id: actorPrincipalId,
      action: `${actionPrefix}.account-derived`,
      resource_type: 'test',
      resource_id: `${uniqueResource}-account-derived`,
    }),
  );
  eventIds.push(id);
  const rows = await getPool().query('SELECT account_id FROM event WHERE id = ?', [id]);
  assert.equal(rows[0].account_id, actorAccountId);
  await markPublished(id);
});

test('markFailed 递增 attempts、写入错误并应用 next_attempt_at', { concurrency: false }, async () => {
  const id = await createEvent({ action: `${actionPrefix}.retry` });
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
  assert.equal((await publishPending({ limit: 100, actionPrefix })).some((event) => event.id === id), false);
});

test('SKIP LOCKED 不重复消费：两个连接并发消费同一批事件', { concurrency: false }, async () => {
  const ids = await Promise.all([
    createEvent({ action: `${actionPrefix}.concurrent-a` }),
    createEvent({ action: `${actionPrefix}.concurrent-b` }),
  ]);
  const [first, second] = await Promise.all([
    publishPending({ limit: 1, actionPrefix }),
    publishPending({ limit: 1, actionPrefix }),
  ]);
  const consumed = [...first, ...second].filter((event) => ids.includes(event.id));
  assert.equal(consumed.length, 2);
  assert.equal(new Set(consumed.map((event) => event.id)).size, 2);
});

test('历史事件很多时并发消费仍返回全部未投递事件', { concurrency: false }, async () => {
  const historicalIds = [];
  await withTransaction(async (conn) => {
    for (let index = 0; index < 200; index += 1) {
      const id = await recordEvent(conn, {
        action: `${actionPrefix}.historical`,
        resource_type: 'test',
        resource_id: `${uniqueResource}-historical-${index}`,
        payload: { historical: true },
      });
      historicalIds.push(id);
      eventIds.push(id);
    }
  });
  await getPool().query(
    `UPDATE event SET published_at = NOW()
      WHERE id IN (${historicalIds.map(() => '?').join(',')})`,
    historicalIds,
  );

  const pendingIds = [];
  for (let index = 0; index < 3; index += 1) {
    pendingIds.push(await createEvent({ action: `${actionPrefix}.concurrent-history-${index}` }));
  }
  const [first, second] = await Promise.all([
    publishPending({ limit: 2, actionPrefix }),
    publishPending({ limit: 2, actionPrefix }),
  ]);
  const consumed = [...first, ...second].filter((event) => pendingIds.includes(event.id));
  assert.equal(consumed.length, 3);
  assert.equal(new Set(consumed.map((event) => event.id)).size, 3);
  assert.deepEqual([...consumed].map((event) => event.id).sort(), [...pendingIds].sort());
  for (const batch of [first, second]) {
    const batchIds = batch.map((event) => event.id);
    assert.deepEqual(batchIds, [...batchIds].sort());
  }
});

test('markPublished 可确认事件，pruneNotified 不删除 audit', { concurrency: false }, async () => {
  const notifyId = await createEvent({ action: `${actionPrefix}.notify`, retention: 'notify' });
  const auditId = await createEvent({ action: `${actionPrefix}.audit`, retention: 'audit' });
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

test('listEventLog：order=desc 返回最新 N 条且 after 分页语义一致', { concurrency: false }, async () => {
  const descAction = `${actionPrefix}.desc-order`;
  const first = await createEvent({ action: descAction });
  const second = await createEvent({ action: descAction });
  const third = await createEvent({ action: descAction });

  // 缺省 asc 保持事件日志管理面语义（id 升序）
  const asc = await listEventLog({
    action: descAction,
    limit: 100,
  });
  const ascIds = asc.items.map((item) => item.id);
  assert.equal(ascIds.indexOf(first) < ascIds.indexOf(second), true);
  assert.equal(ascIds.indexOf(second) < ascIds.indexOf(third), true);

  // desc 取最新 2 条（Hosts「最近活动」场景：事件多于 limit 时不能返回最早的）
  const desc = await listEventLog({
    action: descAction,
    limit: 2,
    order: 'desc',
  });
  assert.deepEqual(desc.items.map((item) => item.id), [third, second]);
  assert.equal(desc.next_after, second);

  // desc + after 继续向更早翻页（e.id < after）
  const page2 = await listEventLog({
    action: descAction,
    limit: 2,
    order: 'desc',
    after: desc.next_after ?? undefined,
  });
  assert.equal(page2.items[0]?.id, first);
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
  // event-log 是独立 tsImport 图，池子也要单独关闭，否则进程无法退出
  await getEventLogPool().end();
});
