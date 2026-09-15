import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

process.env.DB_NAME = 'erix';

const identity = await tsImport('./identity.ts', import.meta.url);
const posts = await tsImport('./posts.ts', import.meta.url);
const resources = await tsImport('./resources.ts', import.meta.url);
const {
  createAccount,
  createPrincipal,
  getPool,
  initSchema,
} = identity;
const { createPost } = posts;
const {
  createAttachment,
  createDeliverable,
  getAttachment,
  getCurrentDeliverable,
  listAttachments,
  listDeliverables,
  markScanStatus,
  quotaUsage,
  softDeleteAttachment,
} = resources;

await initSchema();

const account = await createAccount({ name: `resources-test-${Date.now()}` });
const owner = await createPrincipal({
  account_id: account.id,
  kind: 'agent',
  name: `resources-owner-${Date.now()}`,
});
const testRun = crypto.randomBytes(8).toString('hex');
const attachmentPath = (name) => `${owner.id}/${testRun}/${name}`;
const postIds = [];
const attachmentIds = [];

test('附件按 owner+sha256 去重，配额只统计未删除附件', { concurrency: false }, async () => {
  const first = await createAttachment({
    account_id: account.id,
    owner_principal_id: owner.id,
    filename: 'one.txt',
    mime: 'text/plain',
    size_bytes: 10,
    sha256: 'b'.repeat(64),
    relative_path: attachmentPath('one.txt'),
  });
  attachmentIds.push(first.attachment.id);
  assert.equal(first.deduped, false);

  const duplicate = await createAttachment({
    account_id: account.id,
    owner_principal_id: owner.id,
    filename: 'renamed.txt',
    mime: 'text/plain',
    size_bytes: 999,
    sha256: 'b'.repeat(64),
    relative_path: attachmentPath('renamed.txt'),
  });
  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.attachment.id, first.attachment.id);

  const second = await createAttachment({
    account_id: account.id,
    owner_principal_id: owner.id,
    filename: 'two.txt',
    mime: 'text/plain',
    size_bytes: 7,
    sha256: 'c'.repeat(64),
    relative_path: attachmentPath('two.txt'),
  });
  attachmentIds.push(second.attachment.id);
  assert.deepEqual(await quotaUsage(owner.id), { bytes: 17, count: 2 });
  assert.equal((await listAttachments({ owner_principal_id: owner.id })).total, 2);

  const clean = await markScanStatus(first.attachment.id, 'clean');
  assert.equal(clean.scan_status, 'clean');
  await softDeleteAttachment(second.attachment.id);
  assert.deepEqual(await quotaUsage(owner.id), { bytes: 10, count: 1 });
  assert.equal((await listAttachments({ owner_principal_id: owner.id })).total, 1);
  assert.ok((await getAttachment(second.attachment.id)).deleted_at);
});

test('交付物连续三版，版本递增且任一时刻只有一个 current', { concurrency: false }, async () => {
  const post = await createPost({
    account_id: account.id,
    kind: 'task',
    author_principal_id: owner.id,
    title: 'deliverable task',
    body: 'submit versions',
    visibility: 'private',
    task: { deliverable_spec: '{"format":"file"}' },
  });
  postIds.push(post.id);

  const versions = [];
  for (let i = 0; i < 3; i += 1) {
    versions.push(await createDeliverable({
      post_id: post.id,
      name: 'result',
      note: `version ${i + 1}`,
    }));
    const currentRows = await getPool().query(
      'SELECT COUNT(*) AS count FROM deliverable WHERE post_id = ? AND name = ? AND current = 1',
      [post.id, 'result'],
    );
    assert.equal(Number(currentRows[0].count), 1);
  }
  assert.deepEqual(versions.map((item) => item.version), [1, 2, 3]);
  assert.deepEqual(versions.map((item) => item.current), [true, true, true]);
  assert.equal((await getCurrentDeliverable(post.id, 'result')).version, 3);
  assert.deepEqual(
    (await listDeliverables(post.id)).map((item) => [item.version, item.current]),
    [[1, false], [2, false], [3, true]],
  );
});

test.after(async () => {
  const pool = getPool();
  if (postIds.length > 0) {
    await pool.query(
      `DELETE FROM deliverable WHERE post_id IN (${postIds.map(() => '?').join(',')})`,
      postIds,
    );
    await pool.query(
      `DELETE FROM post_task WHERE post_id IN (${postIds.map(() => '?').join(',')})`,
      postIds,
    );
    await pool.query(
      `DELETE FROM post WHERE id IN (${postIds.map(() => '?').join(',')})`,
      postIds,
    );
  }
  if (attachmentIds.length > 0) {
    await pool.query(
      `DELETE FROM attachment WHERE id IN (${attachmentIds.map(() => '?').join(',')})`,
      attachmentIds,
    );
  }
  await pool.query('DELETE FROM event WHERE account_id = ?', [account.id]);
  await pool.query('DELETE FROM principal WHERE id = ?', [owner.id]);
  await pool.query('DELETE FROM account WHERE id = ?', [account.id]);
  const pools = new Set([pool, posts.getPool(), resources.getPool()]);
  for (const currentPool of pools) await currentPool.end();
});
