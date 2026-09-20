import assert from 'node:assert/strict';
import test from 'node:test';
import { mock } from 'node:test';

const publishTaskCalls = [];
mock.module('../service/task-flow.ts', {
  namedExports: {
    publishTask: async (input) => {
      publishTaskCalls.push(input);
      return { post: { id: 'pst_mock_task' }, task: { status: 'open' } };
    },
  },
});

const { applyRecentOptions, presentPostDetail, registerPostTools } = await import('./post-tools.ts');
const { principalContext } = await import('../auth-principal.ts');

const handlers = {};
registerPostTools({
  tool: (name, _description, _schema, handler) => {
    handlers[name] = handler;
  },
});

function callPost(args) {
  return principalContext.run({
    principal: { id: 'prn_coord', kind: 'agent', name: 'coordinator' },
    scopes: ['task:write', 'post:write', 'post:read'],
    key_id: 'key_mock',
    account_id: 'acc_mock',
  }, () => handlers.post(args));
}

const author = {
  id: 'prn_author',
  account_id: 'acc_secret',
  kind: 'agent',
  name: 'author',
};

function post(overrides = {}) {
  return {
    id: 'pst_root',
    account_id: 'acc_secret',
    kind: 'task',
    subtype: '',
    author_principal_id: author.id,
    author,
    title: 'title',
    body: 'body',
    visibility: 'private',
    parent_id: null,
    root_id: 'pst_root',
    streaming: true,
    revision: 0,
    reply_count: 7,
    created_at: '2026-09-13 00:00:00',
    edited_at: null,
    deleted_at: null,
    ...overrides,
  };
}

test('detail projection keeps nine legacy keys plus tree keys and strips internal fields', () => {
  const detail = presentPostDetail({
    post: post(),
    targets: [{
      post_id: 'pst_root',
      principal_id: 'prn_target',
      principal: { id: 'prn_target', account_id: 'acc_secret', kind: 'host', name: 'target' },
      role: 'assignee',
      read_at: null,
      created_at: '2026-09-13 00:00:00',
    }],
    task: {
      post_id: 'pst_root',
      status: 'open',
      assignee_principal_id: null,
      is_ready: true,
      workdir: null,
      executor: null,
      deliverable_spec: '{}',
      attempts: 0,
      max_attempts: 3,
      pipeline_step_id: null,
      parent_task_id: 'pst_parent',
      claimed_at: null,
      submitted_at: null,
      closed_at: null,
    },
    parent: { id: 'pst_parent', title: 'parent task' },
    children: [{
      post_id: 'pst_child',
      title: 'child task',
      status: 'done',
      attempts: 1,
      max_attempts: 3,
      assignee: { id: 'prn_host', kind: 'host', name: 'worker' },
      latest_verdict: {
        post_id: 'pst_verdict',
        decision: 'accept',
        opinion: 'ok',
        attempt_no: 1,
      },
    }],
    channel: {
      post_id: 'pst_root',
      host_principal_id: 'prn_host',
      workdir: null,
      run_user: null,
      name: 'wrong extension',
      status: 'open',
    },
    verdicts: [],
    deliverables: [{
      name: 'result',
      version: 1,
      current: true,
      note: '',
      attachment: {
        id: 'att_1',
        account_id: 'acc_secret',
        owner_principal_id: 'prn_author',
        filename: 'result.txt',
        mime: 'text/plain',
        size_bytes: 1,
        sha256: 'a'.repeat(64),
        relative_path: 'secret/result.txt',
        scan_status: 'skipped',
        deleted_at: null,
      },
    }],
    summary: null,
    recent: [post({ id: 'pst_reply', body: 'x'.repeat(501) })],
    more: { count: 1, hint: 'post(list)' },
  });

  assert.deepEqual(
    Object.keys(detail).sort(),
    ['channel', 'children', 'deliverables', 'more', 'parent', 'post', 'recent', 'summary', 'targets', 'task', 'verdicts'].sort(),
  );
  assert.equal(detail.task.parent_task_id, 'pst_parent');
  assert.equal(detail.parent.id, 'pst_parent');
  assert.equal(detail.children.length, 1);
  assert.equal(detail.children[0].assignee.name, 'worker');
  assert.equal(detail.children[0].latest_verdict.decision, 'accept');
  assert.equal('account_id' in detail.children[0].assignee, false);
  const serialized = JSON.stringify(detail);
  for (const key of ['deleted_at', 'account_id', 'streaming', 'relative_path', 'owner_principal_id']) {
    assert.equal(serialized.includes(`"${key}"`), false, `unexpected key: ${key}`);
  }
  assert.equal(detail.recent.length, 1);
  assert.equal(detail.recent[0].body.length, 500);
  assert.equal(detail.recent[0].body.endsWith('…'), true);
  assert.deepEqual(detail.recent[0].author, { id: 'prn_author', kind: 'agent', name: 'author' });
  assert.equal(detail.task !== null && detail.channel === null, true);
});

test('recent 过滤后重新计算 more.count', () => {
  const detail = {
    recent: [{ id: 'one' }, { id: 'two' }, { id: 'three' }],
    more: { count: 4, hint: 'post(list)' },
  };
  applyRecentOptions(detail, { include_recent: false });
  assert.equal(detail.recent.length, 0);
  assert.equal(detail.more.count, 7);

  const limited = {
    recent: [{ id: 'one' }, { id: 'two' }, { id: 'three' }],
    more: { count: 4, hint: 'post(list)' },
  };
  applyRecentOptions(limited, { recent_limit: 1 });
  assert.equal(limited.recent.length, 1);
  assert.equal(limited.more.count, 6);
});

test('recent limit is bounded by the requested limit and kind controls extensions', () => {
  const detail = presentPostDetail({
    post: post({ kind: 'channel' }),
    targets: [],
    task: {
      post_id: 'pst_root',
      status: 'open',
      assignee_principal_id: null,
      is_ready: true,
      workdir: null,
      executor: null,
      deliverable_spec: '{}',
      attempts: 0,
      max_attempts: 3,
      pipeline_step_id: null,
      parent_task_id: null,
      claimed_at: null,
      submitted_at: null,
      closed_at: null,
    },
    channel: {
      post_id: 'pst_root',
      host_principal_id: 'prn_host',
      workdir: null,
      run_user: null,
      name: 'channel',
      status: 'open',
    },
    verdicts: [],
    deliverables: [],
    summary: null,
    recent: Array.from({ length: 5 }, (_, index) => post({ id: `pst_${index}`, kind: 'message' })),
    more: { count: 0, hint: '' },
    parent: null,
    children: [],
  });

  assert.equal(detail.recent.length <= 5, true);
  assert.equal(detail.task, null);
  assert.notEqual(detail.channel, null);
});

test('create(kind=task) 把 parent_task_id 透传给 publishTask（含 parent_id 回退）', async () => {
  publishTaskCalls.length = 0;

  const withParent = await callPost({
    action: 'create',
    kind: 'task',
    body: 'do the sub work',
    visibility: 'private',
    parent_task_id: 'pst_parent',
  });
  assert.equal(JSON.parse(withParent.content[0].text).ok, true);
  assert.equal(publishTaskCalls.length, 1);
  assert.equal(publishTaskCalls[0].task.parent_task_id, 'pst_parent');
  assert.equal(publishTaskCalls[0].account_id, 'acc_mock');

  await callPost({
    action: 'create',
    kind: 'task',
    body: 'fallback to parent_id',
    visibility: 'private',
    parent_id: 'pst_parent_fallback',
  });
  assert.equal(publishTaskCalls[1].task.parent_task_id, 'pst_parent_fallback');

  await callPost({
    action: 'create',
    kind: 'task',
    body: 'no parent',
    visibility: 'private',
  });
  assert.equal(publishTaskCalls[2].task.parent_task_id, null);
});
