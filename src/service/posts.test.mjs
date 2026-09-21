import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

process.env.DB_NAME = 'erix';

const identity = await tsImport('./identity.ts', import.meta.url);
const poolModule = await tsImport('../db/pool.ts', import.meta.url);
const eventOutbox = await tsImport('./event-outbox.ts', import.meta.url);
const posts = await tsImport('./posts.ts', import.meta.url);
const resources = await tsImport('./resources.ts', import.meta.url);
const {
  createAccount,
  createPrincipal,
  getPool,
  initSchema,
} = identity;
const { withTransaction } = poolModule;
const {
  addTarget,
  createPost,
  deletePost,
  getDirectReplies,
  getPostDetail,
  getSummary,
  getThread,
  listPosts,
  markTargetRead,
  replyPost,
  saveSummary,
} = posts;
const { createDeliverable, softDeleteAttachment } = resources;

await initSchema();

const account = await createAccount({ name: `posts-test-${Date.now()}` });
const author = await createPrincipal({
  account_id: account.id,
  kind: 'agent',
  name: `posts-author-${Date.now()}`,
});
const recipientOne = await createPrincipal({
  account_id: account.id,
  kind: 'agent',
  name: `posts-recipient-one-${Date.now()}`,
});
const recipientTwo = await createPrincipal({
  account_id: account.id,
  kind: 'agent',
  name: `posts-recipient-two-${Date.now()}`,
});
const recipientThree = await createPrincipal({
  account_id: account.id,
  kind: 'agent',
  name: `posts-recipient-three-${Date.now()}`,
});
const host = await createPrincipal({
  account_id: account.id,
  kind: 'host',
  name: `posts-host-${Date.now()}`,
});

const postIds = [];
const attachmentIds = [];
const waitForIdOrder = () => new Promise((resolve) => setTimeout(resolve, 5));

test('四种 kind 建帖并正确写入扩展表', { concurrency: false }, async () => {
  const note = await createPost({
    account_id: account.id,
    kind: 'note',
    author_principal_id: author.id,
    body: 'a note',
    visibility: 'account',
  });
  const task = await createPost({
    account_id: account.id,
    kind: 'task',
    author_principal_id: author.id,
    title: 'a task',
    body: 'do the work',
    visibility: 'private',
    task: {
      deliverable_spec: '{"format":"text"}',
      workdir: '/tmp/project',
      executor: 'pi',
    },
    targets: [{ principal_id: recipientOne.id, role: 'assignee' }],
  });
  const channel = await createPost({
    account_id: account.id,
    kind: 'channel',
    author_principal_id: author.id,
    body: 'chat root',
    visibility: 'private',
    channel: {
      host_principal_id: host.id,
      workdir: '~/demo',
      run_user: 'pi-agent',
      name: 'demo channel',
    },
  });
  const verdict = await createPost({
    account_id: account.id,
    kind: 'verdict',
    author_principal_id: author.id,
    body: 'accepted',
    visibility: 'private',
    parent_id: task.id,
    verdict: {
      decision: 'accept',
      target_task_id: task.id,
      opinion: 'looks good',
      source: 'human',
    },
  });
  postIds.push(note.id, task.id, channel.id, verdict.id);

  const pool = getPool();
  const taskRows = await pool.query(
    'SELECT status, is_ready, deliverable_spec, workdir, executor FROM post_task WHERE post_id = ?',
    [task.id],
  );
  assert.equal(taskRows.length, 1);
  assert.deepEqual(
    [taskRows[0].status, Number(taskRows[0].is_ready), taskRows[0].deliverable_spec, taskRows[0].workdir, taskRows[0].executor],
    ['open', 1, '{"format":"text"}', '/tmp/project', 'pi'],
  );
  const channelRows = await pool.query(
    'SELECT host_principal_id, workdir, run_user, name, status FROM post_channel WHERE post_id = ?',
    [channel.id],
  );
  assert.deepEqual(
    [channelRows[0].host_principal_id, channelRows[0].workdir, channelRows[0].run_user, channelRows[0].name, channelRows[0].status],
    [host.id, '~/demo', 'pi-agent', 'demo channel', 'open'],
  );
  const verdictRows = await pool.query(
    'SELECT decision, target_task_id, opinion, source FROM post_verdict WHERE post_id = ?',
    [verdict.id],
  );
  assert.deepEqual(
    [verdictRows[0].decision, verdictRows[0].target_task_id, verdictRows[0].opinion, verdictRows[0].source],
    ['accept', task.id, 'looks good', 'human'],
  );
});

test('三层线程按一条 root 查询返回，root_id 全部相同', { concurrency: false }, async () => {
  const root = await createPost({
    account_id: account.id,
    kind: 'note',
    author_principal_id: author.id,
    body: 'A',
    visibility: 'account',
  });
  postIds.push(root.id);
  await waitForIdOrder();
  const second = await replyPost({
    parent_id: root.id,
    author_principal_id: recipientOne.id,
    body: 'B',
  });
  postIds.push(second.id);
  await waitForIdOrder();
  const third = await replyPost({
    parent_id: second.id,
    author_principal_id: recipientTwo.id,
    body: 'C',
  });
  postIds.push(third.id);

  const thread = await getThread(root.id);
  assert.equal(thread.length, 3);
  assert.deepEqual(thread.map((post) => post.id), [root.id, second.id, third.id]);
  assert.equal(new Set(thread.map((post) => post.root_id)).size, 1);
  assert.equal(thread[0].root_id, root.id);
  assert.equal(thread[1].parent_id, root.id);
  assert.equal(thread[2].parent_id, second.id);
});

test('0/1/3 targets 可寻址，收件箱过滤和已读标记生效', { concurrency: false }, async () => {
  const none = await createPost({
    account_id: account.id,
    kind: 'message',
    author_principal_id: author.id,
    body: 'no target',
    visibility: 'public',
  });
  const one = await createPost({
    account_id: account.id,
    kind: 'message',
    author_principal_id: author.id,
    body: 'one target',
    visibility: 'private',
    targets: [{ principal_id: recipientOne.id, role: 'assignee' }],
  });
  const three = await createPost({
    account_id: account.id,
    kind: 'message',
    author_principal_id: author.id,
    body: 'three targets',
    visibility: 'private',
    targets: [
      { principal_id: recipientOne.id, role: 'assignee' },
      { principal_id: recipientTwo.id, role: 'mention' },
      { principal_id: recipientThree.id, role: 'watcher' },
    ],
  });
  postIds.push(none.id, one.id, three.id);

  assert.equal((await getPostDetail(none.id)).targets.length, 0);
  assert.equal((await getPostDetail(one.id)).targets.length, 1);
  assert.equal((await getPostDetail(three.id)).targets.length, 3);
  const inbox = await listPosts({
    account_id: account.id,
    target_principal_id: recipientTwo.id,
  });
  assert.equal(inbox.items.some((post) => post.id === three.id), true);
  assert.equal(inbox.items.some((post) => post.id === one.id), false);

  await markTargetRead(three.id, recipientTwo.id, 'mention');
  const detail = await getPostDetail(three.id);
  const target = detail.targets.find((item) => item.principal_id === recipientTwo.id);
  assert.ok(target);
  assert.ok(target.read_at);
});

test('软删保留行但线程和详情读取不返回已删 post', { concurrency: false }, async () => {
  const post = await createPost({
    account_id: account.id,
    kind: 'note',
    author_principal_id: author.id,
    body: 'to delete',
    visibility: 'private',
  });
  postIds.push(post.id);
  await deletePost(post.id);
  const rows = await getPool().query('SELECT deleted_at FROM post WHERE id = ?', [post.id]);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].deleted_at);
  const thread = await getThread(post.root_id);
  assert.equal(thread.some((item) => item.id === post.id), false);
  assert.equal(await getPostDetail(post.id), null);
});

test('getPostDetail 返回结构化上下文，recent 限制为 5 条并计算 more', { concurrency: false }, async () => {
  const task = await createPost({
    account_id: account.id,
    kind: 'task',
    author_principal_id: author.id,
    title: 'detail task',
    body: 'detail body',
    visibility: 'account',
    task: { deliverable_spec: '{"format":"json"}' },
    targets: [{ principal_id: recipientOne.id, role: 'assignee' }],
  });
  postIds.push(task.id);
  const attachment = await resources.createAttachment({
    account_id: account.id,
    owner_principal_id: author.id,
    filename: 'detail.json',
    mime: 'application/json',
    size_bytes: 10,
    sha256: 'a'.repeat(64),
    relative_path: `${author.id}/detail.json`,
  });
  attachmentIds.push(attachment.attachment.id);
  await createDeliverable({
    post_id: task.id,
    name: 'result',
    attachment_id: attachment.attachment.id,
  });
  const verdict = await createPost({
    account_id: account.id,
    kind: 'verdict',
    author_principal_id: author.id,
    body: 'accepted detail',
    visibility: 'account',
    parent_id: task.id,
    verdict: { decision: 'accept', target_task_id: task.id },
  });
  postIds.push(verdict.id);
  for (let i = 0; i < 5; i += 1) {
    const reply = await replyPost({
      parent_id: task.id,
      author_principal_id: recipientOne.id,
      body: `detail reply ${i}`,
    });
    postIds.push(reply.id);
  }
  const revision = await saveSummary(task.id, {
    summary: 'short summary',
    up_to_post_id: task.id,
    model: 'test-model',
    tokens_in: 10,
    tokens_out: 4,
  });
  assert.equal(revision, 1);
  const detail = await getPostDetail(task.id);
  assert.ok(detail);
  assert.equal(detail.post.id, task.id);
  assert.equal(detail.targets.length, 1);
  assert.equal(detail.task.deliverable_spec, '{"format":"json"}');
  assert.equal(detail.verdicts.length, 1);
  assert.equal(detail.deliverables.length, 1);
  assert.equal(detail.summary.summary, 'short summary');
  assert.equal(detail.summary.stale, true);
  assert.equal(detail.summary.pending, 6);
  assert.equal(detail.recent.length, 5);
  assert.equal(detail.more.count, 2);
  assert.match(detail.more.hint, /post\(list, root_id=/);

  const deletedReply = await replyPost({
    parent_id: task.id,
    author_principal_id: recipientOne.id,
    body: 'soft-deleted detail reply',
  });
  postIds.push(deletedReply.id);
  await deletePost(deletedReply.id);
  const afterDelete = await getPostDetail(task.id);
  assert.equal(afterDelete.recent.some((item) => item.id === deletedReply.id), false);
  assert.equal(afterDelete.more.count, 2);
  assert.equal(afterDelete.post.reply_count, 5);
  assert.equal((await getDirectReplies(task.id)).some((item) => item.id === deletedReply.id), false);
  assert.equal(afterDelete.summary.pending, 6);
  await softDeleteAttachment(attachment.attachment.id);
  const afterAttachmentDelete = await getPostDetail(task.id);
  assert.equal(afterAttachmentDelete.deliverables[0].attachment, null);
});

test('创建写入和事件同事务，回滚后两者都不存在', { concurrency: false }, async () => {
  let rolledBackPostId;
  await assert.rejects(
    withTransaction(async (conn) => {
      const post = await createPost(conn, {
        account_id: account.id,
        kind: 'note',
        author_principal_id: author.id,
        body: 'rollback',
        visibility: 'private',
      });
      rolledBackPostId = post.id;
      throw new Error('intentional post rollback');
    }),
    /intentional post rollback/,
  );
  const postRows = await getPool().query('SELECT id FROM post WHERE id = ?', [rolledBackPostId]);
  const eventRows = await getPool().query(
    'SELECT id FROM event WHERE resource_type = ? AND resource_id = ?',
    ['post', rolledBackPostId],
  );
  assert.equal(postRows.length, 0);
  assert.equal(eventRows.length, 0);
});

test('summary 读写返回 revision/stale/pending', { concurrency: false }, async () => {
  const root = await createPost({
    account_id: account.id,
    kind: 'note',
    author_principal_id: author.id,
    body: 'summary root',
    visibility: 'private',
  });
  postIds.push(root.id);
  assert.equal(await getSummary(root.id), null);
  const revision = await saveSummary(root.id, {
    summary: 'root summary',
    up_to_post_id: root.id,
    model: 'test-model',
    tokens_in: 1,
    tokens_out: 1,
  });
  assert.equal(revision, 1);
  const summary = await getSummary(root.id);
  assert.deepEqual(summary, {
    summary: 'root summary',
    up_to_post_id: root.id,
    revision: 1,
    stale: false,
    pending: 0,
  });
  await addTarget(root.id, recipientOne.id, 'watcher');
  const updated = await getSummary(root.id);
  assert.equal(updated.stale, false);
});

test.after(async () => {
  const pool = getPool();
  if (postIds.length > 0) {
    await pool.query(
      `DELETE FROM post_summary WHERE root_id IN (${postIds.map(() => '?').join(',')})`,
      postIds,
    );
    await pool.query(
      `DELETE FROM deliverable WHERE post_id IN (${postIds.map(() => '?').join(',')})`,
      postIds,
    );
    await pool.query(
      `DELETE FROM post_verdict WHERE post_id IN (${postIds.map(() => '?').join(',')})`,
      postIds,
    );
    await pool.query(
      `DELETE FROM post_task WHERE post_id IN (${postIds.map(() => '?').join(',')})`,
      postIds,
    );
    await pool.query(
      `DELETE FROM post_channel WHERE post_id IN (${postIds.map(() => '?').join(',')})`,
      postIds,
    );
    await pool.query(
      `DELETE FROM post_target WHERE post_id IN (${postIds.map(() => '?').join(',')})`,
      postIds,
    );
    for (const postId of [...postIds].reverse()) {
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
  await pool.query('DELETE FROM device WHERE principal_id = ?', [host.id]);
  await pool.query(
    `DELETE FROM principal WHERE id IN (${[author.id, recipientOne.id, recipientTwo.id, recipientThree.id, host.id].map(() => '?').join(',')})`,
    [author.id, recipientOne.id, recipientTwo.id, recipientThree.id, host.id],
  );
  await pool.query('DELETE FROM account WHERE id = ?', [account.id]);
  const pools = new Set([
    pool,
    poolModule.getPool(),
    eventOutbox.getPool(),
    posts.getPool(),
    resources.getPool(),
  ]);
  for (const currentPool of pools) await currentPool.end();
});
