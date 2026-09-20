import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { presentTaskListItem } = await tsImport('./task-tools.ts', import.meta.url);

test('task list item is a public post with one structured task extension', () => {
  const item = presentTaskListItem({
    post: {
      id: 'pst_task',
      account_id: 'acc_secret',
      kind: 'task',
      subtype: '',
      author_principal_id: 'prn_author',
      author: {
        id: 'prn_author',
        account_id: 'acc_secret',
        kind: 'user',
        name: 'author',
      },
      title: 'task',
      body: 'body',
      visibility: 'public',
      parent_id: null,
      root_id: 'pst_task',
      streaming: false,
      revision: 0,
      reply_count: 0,
      created_at: '2026-09-13 00:00:00',
      edited_at: null,
      deleted_at: null,
    },
    task: {
      post_id: 'pst_task',
      status: 'open',
      assignee_principal_id: null,
      is_ready: true,
      workdir: null,
      executor: 'pi',
      deliverable_spec: '{}',
      attempts: 0,
      max_attempts: 3,
      pipeline_step_id: null,
      parent_task_id: 'pst_parent',
      claimed_at: null,
      submitted_at: null,
      closed_at: null,
    },
    children_rollup: { total: 2, done: 1, failed: 0, active: 1 },
    parent: { id: 'pst_parent', title: 'parent task' },
  });

  assert.equal(item.id, 'pst_task');
  assert.equal(item.task.status, 'open');
  assert.equal(item.task.executor, 'pi');
  assert.equal(item.task.parent_task_id, 'pst_parent');
  assert.equal(item.parent.title, 'parent task');
  assert.deepEqual(item.children_rollup, { total: 2, done: 1, failed: 0, active: 1 });
  assert.equal('account_id' in item, false);
  assert.equal('streaming' in item, false);
  assert.equal('post' in item, false);
});

test('task list item defaults tree fields to null', () => {
  const item = presentTaskListItem({
    post: {
      id: 'pst_plain',
      account_id: 'acc_secret',
      kind: 'task',
      subtype: '',
      author_principal_id: 'prn_author',
      author: null,
      title: 'plain',
      body: 'body',
      visibility: 'public',
      parent_id: null,
      root_id: 'pst_plain',
      streaming: false,
      revision: 0,
      reply_count: 0,
      created_at: '2026-09-13 00:00:00',
      edited_at: null,
      deleted_at: null,
    },
    task: {
      post_id: 'pst_plain',
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
  });

  assert.equal(item.parent, null);
  assert.equal(item.children_rollup, null);
  assert.equal(item.task.parent_task_id, null);
});
