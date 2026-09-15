import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { applyRecentOptions, presentPostDetail } = await tsImport('./post-tools.ts', import.meta.url);

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

test('detail projection has exactly nine keys and strips internal fields', () => {
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
    ['channel', 'deliverables', 'more', 'post', 'recent', 'summary', 'targets', 'task', 'verdicts'].sort(),
  );
  const serialized = JSON.stringify(detail);
  for (const key of ['deleted_at', 'account_id', 'streaming', 'relative_path', 'owner_principal_id']) {
    assert.equal(serialized.includes(`"${key}"`), false, `unexpected key: ${key}`);
  }
  assert.equal(detail.recent.length, 1);
  assert.equal(detail.recent[0].body.length, 500);
  assert.equal(detail.recent[0].body.endsWith('…'), true);
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
  });

  assert.equal(detail.recent.length <= 5, true);
  assert.equal(detail.task, null);
  assert.notEqual(detail.channel, null);
});
