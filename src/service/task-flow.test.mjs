import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

process.env.DB_NAME = 'erix';
process.env.NO_PROXY = '127.0.0.1,localhost';

const identity = await tsImport('./identity.ts', import.meta.url);
const poolModule = await tsImport('../db/pool.ts', import.meta.url);
const eventOutbox = await tsImport('./event-outbox.ts', import.meta.url);
const posts = await tsImport('./posts.ts', import.meta.url);
const resources = await tsImport('./resources.ts', import.meta.url);
const taskFlow = await tsImport('./task-flow.ts', import.meta.url);

const {
  createAccount,
  createPrincipal,
  getPool,
  initSchema,
} = identity;
const { withTransaction } = poolModule;
const { getThread } = posts;
const {
  createAttachment,
  markScanStatus,
  softDeleteAttachment,
} = resources;
const {
  publishTask,
  claimTask,
  submitTask,
  verdictTask,
  reopenTask,
  reassignTask,
  cancelTask,
  listTasks,
  setReady,
} = taskFlow;

await initSchema();

const account = await createAccount({ name: `task-flow-test-${Date.now()}` });
const author = await createPrincipal({
  account_id: account.id,
  kind: 'user',
  name: `task-flow-author-${Date.now()}`,
});
const assignee = await createPrincipal({
  account_id: account.id,
  kind: 'agent',
  name: `task-flow-assignee-${Date.now()}`,
});
const otherAssignee = await createPrincipal({
  account_id: account.id,
  kind: 'agent',
  name: `task-flow-other-${Date.now()}`,
});
const postIds = [];
const attachmentIds = [];

async function publishAssigned(extra = {}) {
  const task = await publishTask({
    account_id: account.id,
    author_principal_id: author.id,
    title: `task-${Date.now()}-${postIds.length}`,
    body: 'perform the requested work',
    visibility: 'private',
    deliverable_spec: '{"items":["result"]}',
    targets: [{ principal_id: assignee.id, role: 'assignee' }],
    ...extra,
  });
  postIds.push(task.post.id);
  return task;
}

test('全链通：publish → claim → submit → verdict accept → done', { concurrency: false }, async () => {
  const published = await publishAssigned();
  assert.equal(published.task.status, 'open');

  const claimed = await claimTask(published.post.id, { principal_id: assignee.id });
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.assignee_principal_id, assignee.id);

  let verifierCalled = false;
  const submitted = await submitTask(published.post.id, {
    principal_id: assignee.id,
    deliverables: [{ name: 'result', note: 'finished' }],
    message: 'The result is ready.',
  }, {
    verifier: async ({ task, deliverables }) => {
      verifierCalled = task.status === 'claimed' && deliverables.length === 1;
      return { ok: true, source: 'llm' };
    },
  });
  assert.equal(submitted.ok, true);
  assert.equal(verifierCalled, true);
  assert.deepEqual(submitted.precheck, { ok: true, issues: [] });
  assert.equal(submitted.task.status, 'submitted');
  assert.equal((await getThread(published.post.id)).some((post) => post.body === 'The result is ready.'), true);

  const verdict = await verdictTask(published.post.id, {
    operator_principal_id: author.id,
    decision: 'accept',
    opinion: 'accepted',
  });
  assert.equal(verdict.task.status, 'done');
  assert.equal(verdict.verdict.decision, 'accept');
  assert.ok(verdict.task.closed_at);

  const events = await getPool().query(
    `SELECT action FROM event WHERE account_id = ? ORDER BY id`,
    [account.id],
  );
  assert.deepEqual(events.map((row) => row.action), [
    'post.created',
    'task.created',
    'task.claimed',
    'post.target.read',
    'deliverable.created',
    'task.submitted',
    'post.created',
    'post.replied',
    'post.created',
    'verdict.created',
    'task.verdict',
  ]);
});

test('打回链：reject 回 claimed，达到 max_attempts 后 failed', { concurrency: false }, async () => {
  const published = await publishAssigned({ task: { max_attempts: 3 } });
  await claimTask(published.post.id, { principal_id: assignee.id });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const submitted = await submitTask(published.post.id, {
      principal_id: assignee.id,
      deliverables: [{ name: 'result', note: `attempt ${attempt}` }],
    });
    assert.equal(submitted.task.status, 'submitted');
    const verdict = await verdictTask(published.post.id, {
      operator_principal_id: author.id,
      decision: 'reject',
      opinion: `fix attempt ${attempt}`,
    });
    assert.equal(verdict.task.attempts, attempt);
    assert.equal(verdict.task.status, attempt === 3 ? 'failed' : 'claimed');
  }
});

test('预检失败：空交付物、缺失、已删和感染附件均被拒绝', { concurrency: false }, async () => {
  const published = await publishAssigned({ task: { max_attempts: 10 } });
  await claimTask(published.post.id, { principal_id: assignee.id });

  const empty = await submitTask(published.post.id, {
    principal_id: assignee.id,
    deliverables: [],
  });
  assert.equal(empty.ok, false);
  assert.match(empty.precheck.issues.join('\n'), /at least one deliverable/);
  assert.equal(empty.task.status, 'claimed');

  const missing = await submitTask(published.post.id, {
    principal_id: assignee.id,
    deliverables: [{ name: 'missing', attachment_id: 'att_missing_task_flow' }],
  });
  assert.equal(missing.ok, false);
  assert.match(missing.precheck.issues.join('\n'), /does not exist/);

  const deleted = await createAttachment({
    account_id: account.id,
    owner_principal_id: assignee.id,
    filename: 'deleted.txt',
    mime: 'text/plain',
    size_bytes: 1,
    sha256: 'd'.repeat(64),
    relative_path: `${assignee.id}/deleted.txt`,
  });
  attachmentIds.push(deleted.attachment.id);
  await softDeleteAttachment(deleted.attachment.id);
  const deletedResult = await submitTask(published.post.id, {
    principal_id: assignee.id,
    deliverables: [{ name: 'deleted', attachment_id: deleted.attachment.id }],
  });
  assert.match(deletedResult.precheck.issues.join('\n'), /is deleted/);

  const infected = await createAttachment({
    account_id: account.id,
    owner_principal_id: assignee.id,
    filename: 'infected.txt',
    mime: 'text/plain',
    size_bytes: 1,
    sha256: 'e'.repeat(64),
    relative_path: `${assignee.id}/infected.txt`,
  });
  attachmentIds.push(infected.attachment.id);
  await markScanStatus(infected.attachment.id, 'infected');
  const infectedResult = await submitTask(published.post.id, {
    principal_id: assignee.id,
    deliverables: [{ name: 'infected', attachment_id: infected.attachment.id }],
  });
  assert.match(infectedResult.precheck.issues.join('\n'), /is infected/);
  assert.equal(infectedResult.task.status, 'claimed');
  assert.equal(Number((await getPool().query(
    `SELECT COUNT(*) AS total FROM event
      WHERE resource_id = ? AND action = 'task.precheck_failed'`,
    [published.post.id],
  ))[0].total), 4);
});

test('认领门禁：not ready、非 target 和已认领均拒绝', { concurrency: false }, async () => {
  const published = await publishAssigned({ task: { is_ready: false } });
  await assert.rejects(
    claimTask(published.post.id, { principal_id: assignee.id }),
    /not ready/,
  );
  await setReady(published.post.id, true);
  await assert.rejects(
    claimTask(published.post.id, { principal_id: otherAssignee.id }),
    /not an assignee target/,
  );
  await claimTask(published.post.id, { principal_id: assignee.id });
  await assert.rejects(
    claimTask(published.post.id, { principal_id: otherAssignee.id }),
    /already been claimed/,
  );
});

test('公开池：public 无 target 的 ready task 可见，认领后消失', { concurrency: false }, async () => {
  const published = await publishTask({
    account_id: account.id,
    author_principal_id: author.id,
    title: `public-${Date.now()}`,
    body: 'public offer',
    visibility: 'public',
    deliverable_spec: '{"items":["result"]}',
  });
  postIds.push(published.post.id);
  const before = await listTasks({ view: 'pool', account_id: account.id });
  assert.equal(before.items.some((item) => item.post_id === published.post.id), true);
  await claimTask(published.post.id, { principal_id: otherAssignee.id });
  const after = await listTasks({ view: 'pool', account_id: account.id });
  assert.equal(after.items.some((item) => item.post_id === published.post.id), false);
});

test('due 视图返回 post_target 指派但尚未认领的任务', { concurrency: false }, async () => {
  const published = await publishAssigned();
  const due = await listTasks({
    view: 'due',
    principal_id: assignee.id,
    account_id: account.id,
  });
  assert.equal(due.items.some((item) => item.post_id === published.post.id), true);
});

test('唯一入口和 verdict 前置状态：导出集合无旧的直接完成入口', { concurrency: false }, async () => {
  const exports = Object.keys(taskFlow);
  assert.equal(exports.includes('submitTask'), true);
  assert.equal(exports.includes('verdictTask'), true);
  assert.equal(exports.includes('approveTask'), false);
  assert.equal(exports.includes('rejectTask'), false);
  assert.equal(exports.includes('resolveTask'), false);

  const published = await publishAssigned();
  await claimTask(published.post.id, { principal_id: assignee.id });
  await assert.rejects(
    verdictTask(published.post.id, {
      operator_principal_id: author.id,
      decision: 'accept',
    }),
    /requires submitted or pending_confirm/,
  );
});

test('事务一致性：回滚后状态未变且同事务 event 不存在', { concurrency: false }, async () => {
  const published = await publishAssigned();
  const before = await getPool().query(
    'SELECT status, attempts FROM post_task WHERE post_id = ?',
    [published.post.id],
  );
  await assert.rejects(
    withTransaction(async (conn) => {
      await conn.query(
        `UPDATE post_task SET status = 'claimed', attempts = attempts + 1 WHERE post_id = ?`,
        [published.post.id],
      );
      await eventOutbox.recordEvent(conn, {
        account_id: account.id,
        actor_principal_id: author.id,
        action: 'task.rollback_probe',
        resource_type: 'post',
        resource_id: published.post.id,
      });
      throw new Error('intentional task-flow rollback');
    }),
    /intentional task-flow rollback/,
  );
  const after = await getPool().query(
    'SELECT status, attempts FROM post_task WHERE post_id = ?',
    [published.post.id],
  );
  assert.deepEqual([after[0].status, Number(after[0].attempts)], [
    before[0].status,
    Number(before[0].attempts),
  ]);
  const events = await getPool().query(
    `SELECT id FROM event WHERE action = 'task.rollback_probe' AND resource_id = ?`,
    [published.post.id],
  );
  assert.equal(events.length, 0);
});

test('reopen/reassign/cancel：落点和 attempts 清零', { concurrency: false }, async () => {
  const failed = await publishAssigned({ task: { max_attempts: 1 } });
  await claimTask(failed.post.id, { principal_id: assignee.id });
  await submitTask(failed.post.id, {
    principal_id: assignee.id,
    deliverables: [],
  });
  const reopened = await reopenTask(failed.post.id, {
    operator_principal_id: author.id,
    reason: '补充说明',
  });
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.assignee_principal_id, assignee.id);
  assert.equal(reopened.attempts, 0);

  const reassigned = await reassignTask(failed.post.id, {
    operator_principal_id: author.id,
    assignee_principal_id: otherAssignee.id,
  });
  assert.equal(reassigned.status, 'claimed');
  assert.equal(reassigned.assignee_principal_id, otherAssignee.id);
  assert.equal(reassigned.attempts, 0);

  const cancelled = await cancelTask(failed.post.id, {
    operator_principal_id: author.id,
    reason: '无需继续',
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.closed_at);
});

test.after(async () => {
  const pool = getPool();
  const allPostRows = await pool.query(
    'SELECT id FROM post WHERE account_id = ? ORDER BY id DESC',
    [account.id],
  );
  const allPostIds = allPostRows.map((row) => row.id);
  if (allPostIds.length > 0) {
    const placeholders = allPostIds.map(() => '?').join(',');
    await pool.query(`DELETE FROM deliverable WHERE post_id IN (${placeholders})`, allPostIds);
    await pool.query(`DELETE FROM post_verdict WHERE post_id IN (${placeholders})`, allPostIds);
    await pool.query(`DELETE FROM post_target WHERE post_id IN (${placeholders})`, allPostIds);
    await pool.query(`DELETE FROM post_task WHERE post_id IN (${placeholders})`, allPostIds);
    for (const postId of allPostIds) {
      await pool.query('DELETE FROM post WHERE id = ?', [postId]);
    }
  }
  if (attachmentIds.length > 0) {
    await pool.query(
      `DELETE FROM attachment WHERE id IN (${attachmentIds.map(() => '?').join(',')})`,
      attachmentIds,
    );
  }
  await pool.query('DELETE FROM event WHERE account_id = ?', [account.id]);
  await pool.query(
    `DELETE FROM principal WHERE id IN (${[author.id, assignee.id, otherAssignee.id].map(() => '?').join(',')})`,
    [author.id, assignee.id, otherAssignee.id],
  );
  await pool.query('DELETE FROM account WHERE id = ?', [account.id]);
  const pools = new Set([
    pool,
    poolModule.getPool(),
    eventOutbox.getPool(),
    posts.getPool(),
    resources.getPool(),
    taskFlow.getPool(),
  ].filter(Boolean));
  for (const currentPool of pools) await currentPool.end();
});
