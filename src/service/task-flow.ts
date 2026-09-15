import type { PoolConnection } from 'mariadb';
import { getPool, withTransaction } from '../db/pool.js';
import {
  createPost,
  getPostDetail,
  markTargetRead,
  replyPost,
  type Post,
  type PostTask,
  targetFromRow,
  type PostTarget,
  type PostVisibility,
  type TargetRole,
  type TaskStatus,
  type VerdictSource,
} from './posts.js';
import {
  createDeliverable,
  type Deliverable,
} from './resources.js';
import { recordEvent } from './event-outbox.js';
import { getPrincipal } from './identity.js';
import { badRequest, conflict, notFound, type AppError } from '../util/errors.js';

export type TaskTargetInput = string | {
  principal_id: string;
  role?: TargetRole;
};

export interface PublishTaskInput {
  account_id: string;
  author_principal_id: string;
  title?: string;
  body: string;
  visibility: PostVisibility;
  subtype?: string;
  deliverable_spec?: unknown;
  targets?: TaskTargetInput[];
  task?: {
    deliverable_spec?: unknown;
    is_ready?: boolean;
    workdir?: string | null;
    executor?: string | null;
    max_attempts?: number;
    pipeline_step_id?: string | null;
    parent_task_id?: string | null;
  };
}

async function requirePrincipalInAccount(
  conn: PoolConnection,
  principalId: string,
  accountId: string,
  label: string,
): Promise<void> {
  if (!principalId) throw badRequest(`${label} is required`);
  const result = rows(await conn.query(
    `SELECT account_id
       FROM principal
      WHERE id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [principalId],
  ));
  if (!result[0]) throw notFound(`${label} not found: ${principalId}`);
  if (stringValue(result[0].account_id) !== accountId) {
    throw notFound(`${label} belongs to another account`);
  }
}

export interface SubmitDeliverableInput {
  name: string;
  attachment_id?: string | null;
  note?: string;
}

async function precheckDeliverablesWithConnection(
  conn: PoolConnection,
  deliverables: SubmitDeliverableInput[],
  accountId: string,
): Promise<PrecheckResult> {
  const issues: string[] = [];
  if (!Array.isArray(deliverables) || deliverables.length === 0) {
    return { ok: false, issues: ['at least one deliverable is required'] };
  }
  for (const [index, deliverable] of deliverables.entries()) {
    const name = typeof deliverable?.name === 'string' ? deliverable.name.trim() : '';
    if (!name) issues.push(`deliverables[${index}].name is required`);
    const attachmentId = deliverable?.attachment_id;
    if (!attachmentId) continue;
    const result = await conn.query(
      `SELECT account_id, deleted_at, scan_status
         FROM attachment
        WHERE id = ?
        LIMIT 1`,
      [attachmentId],
    );
    const attachment = rows(result)[0];
    if (!attachment) issues.push(`attachment ${attachmentId} does not exist`);
    else if (stringValue(attachment.account_id) !== accountId) {
      issues.push(`attachment ${attachmentId} belongs to another account`);
    } else if (attachment.deleted_at) {
      issues.push(`attachment ${attachmentId} is deleted`);
    } else if (attachment.scan_status === 'infected') {
      issues.push(`attachment ${attachmentId} is infected`);
    }
  }
  return { ok: issues.length === 0, issues };
}

export interface SubmitTaskInput {
  principal_id: string;
  deliverables: SubmitDeliverableInput[];
  message?: string;
  verifier?: TaskVerifier;
}

export interface TaskVerifierContext {
  task: PostTask;
  deliverables: Deliverable[];
}

export interface TaskVerifierResult {
  ok: boolean;
  reason?: string;
  source?: 'llm' | 'human';
}

export type TaskVerifier = (
  context: TaskVerifierContext,
) => Promise<TaskVerifierResult>;

export interface SubmitTaskOptions {
  verifier?: TaskVerifier;
}

export interface VerdictTaskInput {
  operator_principal_id: string;
  decision: 'accept' | 'reject';
  opinion?: string;
  source?: VerdictSource;
}

export interface ReopenTaskInput {
  operator_principal_id: string;
  reason?: string;
}

export interface ReassignTaskInput {
  operator_principal_id: string;
  assignee_principal_id: string | null;
}

export interface CancelTaskInput {
  operator_principal_id: string;
  reason?: string;
}

export type TaskListView = 'pool' | 'mine' | 'due';

export interface ListTasksFilter {
  view: TaskListView;
  principal_id?: string;
  account_id?: string;
  status?: TaskStatus | TaskStatus[];
  page?: number;
  page_size?: number;
}

export interface TaskListItem {
  post: Post;
  task: PostTask;
  targets?: PostTarget[];
  [key: string]: unknown;
}

export interface PrecheckResult {
  ok: boolean;
  issues: string[];
}

export interface SubmitTaskResult {
  ok: boolean;
  precheck: PrecheckResult;
  task: PostTask;
}

export interface VerdictTaskResult {
  task: PostTask;
  verdict: {
    post_id: string;
    decision: 'accept' | 'reject';
    opinion: string;
    target_task_id: string;
    attempt_no: number;
    source: VerdictSource;
  };
}

interface DbRow {
  [key: string]: unknown;
}

interface TaskRecord {
  post: Post;
  task: PostTask;
  author_account_id: string;
}

function rows(result: unknown): DbRow[] {
  return Array.isArray(result) ? (result as DbRow[]) : [];
}

function stringValue(value: unknown): string {
  return String(value ?? '');
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function numberValue(value: unknown): number {
  return Number(value ?? 0);
}

function booleanValue(value: unknown): boolean {
  return Number(value) === 1;
}

function nowString(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function postFromTaskRow(row: DbRow): Post {
  const author = row.author_id === null || row.author_id === undefined
    ? null
    : {
        id: stringValue(row.author_id),
        account_id: stringValue(row.author_account_id),
        kind: stringValue(row.author_kind),
        name: stringValue(row.author_name),
      };
  return {
    id: stringValue(row.post_id),
    account_id: stringValue(row.account_id),
    kind: stringValue(row.kind) as Post['kind'],
    subtype: stringValue(row.subtype),
    author_principal_id: stringValue(row.author_principal_id),
    author,
    title: stringValue(row.title),
    body: stringValue(row.body),
    visibility: stringValue(row.visibility) as PostVisibility,
    parent_id: nullableString(row.parent_id),
    root_id: stringValue(row.root_id),
    streaming: booleanValue(row.streaming),
    revision: numberValue(row.revision),
    reply_count: numberValue(row.reply_count),
    created_at: stringValue(row.created_at),
    edited_at: nullableString(row.edited_at),
    deleted_at: nullableString(row.deleted_at),
  };
}

function taskFromRow(row: DbRow): PostTask {
  return {
    post_id: stringValue(row.post_id),
    status: stringValue(row.status) as TaskStatus,
    assignee_principal_id: nullableString(row.assignee_principal_id),
    is_ready: booleanValue(row.is_ready),
    workdir: nullableString(row.workdir),
    executor: nullableString(row.executor),
    deliverable_spec: stringValue(row.deliverable_spec),
    attempts: numberValue(row.attempts),
    max_attempts: numberValue(row.max_attempts),
    pipeline_step_id: nullableString(row.pipeline_step_id),
    parent_task_id: nullableString(row.parent_task_id),
    claimed_at: nullableString(row.claimed_at),
    submitted_at: nullableString(row.submitted_at),
    closed_at: nullableString(row.closed_at),
  };
}

function taskSelect(): string {
  return `SELECT p.id AS post_id, p.account_id, p.kind, p.subtype,
                 p.author_principal_id, p.title, p.body, p.visibility,
                 p.parent_id, p.root_id, p.streaming, p.revision,
                 p.reply_count, p.created_at, p.edited_at, p.deleted_at,
                 pr.id AS author_id, pr.account_id AS author_account_id,
                 pr.kind AS author_kind, pr.name AS author_name,
                 t.status, t.assignee_principal_id, t.is_ready,
                 t.workdir, t.executor, t.deliverable_spec, t.attempts,
                 t.max_attempts, t.pipeline_step_id, t.parent_task_id,
                 t.claimed_at, t.submitted_at, t.closed_at
            FROM post p
            JOIN post_task t ON t.post_id = p.id
            LEFT JOIN principal pr ON pr.id = p.author_principal_id`;
}

async function taskRecord(
  conn: PoolConnection,
  taskId: string,
  lock: boolean,
): Promise<TaskRecord | null> {
  const result = await conn.query(
    `${taskSelect()}
      WHERE p.id = ? AND p.kind = 'task' AND p.deleted_at IS NULL
      LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [taskId],
  );
  const row = rows(result)[0];
  if (!row) return null;
  return {
    post: postFromTaskRow(row),
    task: taskFromRow(row),
    author_account_id: stringValue(row.account_id),
  };
}

async function getTaskRecord(taskId: string): Promise<TaskRecord | null> {
  const result = await getPool().query(
    `${taskSelect()}
      WHERE p.id = ? AND p.kind = 'task' AND p.deleted_at IS NULL
      LIMIT 1`,
    [taskId],
  );
  const row = rows(result)[0];
  if (!row) return null;
  return {
    post: postFromTaskRow(row),
    task: taskFromRow(row),
    author_account_id: stringValue(row.account_id),
  };
}

async function requirePrincipal(principalId: string, label: string): Promise<void> {
  if (!principalId) throw badRequest(`${label} is required`);
  const principal = await getPrincipal(principalId);
  if (!principal) throw notFound(`${label} not found: ${principalId}`);
}

async function requireTaskOperator(
  conn: PoolConnection,
  principalId: string,
  accountId: string,
): Promise<void> {
  if (!principalId) throw badRequest('operator_principal_id is required');
  const result = await conn.query(
    `SELECT id, account_id
       FROM principal
      WHERE id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [principalId],
  );
  const row = rows(result)[0];
  if (!row) throw notFound(`operator principal not found: ${principalId}`);
  if (stringValue(row.account_id) !== accountId) {
    throw notFound('operator principal belongs to another account');
  }
}

function taskState(task: PostTask): Record<string, unknown> {
  return {
    status: task.status,
    assignee_principal_id: task.assignee_principal_id,
    is_ready: task.is_ready,
    attempts: task.attempts,
    claimed_at: task.claimed_at,
    submitted_at: task.submitted_at,
    closed_at: task.closed_at,
  };
}

function taskNotFound(taskId: string): AppError {
  return notFound(`Task not found: ${taskId}`);
}

function normalizeTargets(targets: TaskTargetInput[] | undefined): Array<{
  principal_id: string;
  role: TargetRole;
}> {
  return (targets ?? []).map((target) =>
    typeof target === 'string'
      ? { principal_id: target, role: 'assignee' }
      : {
          principal_id: target.principal_id,
          role: target.role ?? 'assignee',
        });
}

export async function publishTask(
  input: PublishTaskInput,
): Promise<{ post: Post; task: PostTask }> {
  if (!input.account_id) throw badRequest('account_id is required');
  if (!input.author_principal_id) throw badRequest('author_principal_id is required');
  if (!input.body && input.body !== '') throw badRequest('body is required');
  const rawSpec = input.deliverable_spec ?? input.task?.deliverable_spec;
  const serializedSpec = typeof rawSpec === 'string'
    ? rawSpec.trim()
    : rawSpec === undefined || rawSpec === null
      ? ''
      : JSON.stringify(rawSpec) ?? '';
  if (serializedSpec === '') {
    throw badRequest('task deliverable_spec is required and cannot be empty');
  }
  const visibility = input.visibility ?? 'private';
  const targets = normalizeTargets(input.targets);
  const assigneeTargets = targets.filter((target) => target.role === 'assignee');
  if (visibility !== 'public' && assigneeTargets.length === 0) {
    throw badRequest('assigned task requires at least one assignee target; use public visibility for an open offer');
  }
  const author = await getPrincipal(input.author_principal_id);
  if (!author) throw notFound(`author principal not found: ${input.author_principal_id}`);
  if (author.account_id !== input.account_id) {
    throw notFound('author principal belongs to another account');
  }

  const post = await withTransaction((conn) =>
    createPost(conn, {
      account_id: input.account_id,
      kind: 'task',
      subtype: input.subtype,
      author_principal_id: input.author_principal_id,
      title: input.title,
      body: input.body,
      visibility,
      targets,
      task: {
        status: 'open',
        is_ready: input.task?.is_ready,
        workdir: input.task?.workdir,
        executor: input.task?.executor,
        deliverable_spec: serializedSpec,
        max_attempts: input.task?.max_attempts,
        pipeline_step_id: input.task?.pipeline_step_id,
        parent_task_id: input.task?.parent_task_id,
      },
    }),
  );
  const detail = await getPostDetail(post.id);
  if (!detail?.task) throw new Error(`Task extension was not created: ${post.id}`);
  return { post, task: detail.task };
}

export async function claimTask(
  taskId: string,
  input: { principal_id: string },
): Promise<PostTask> {
  await requirePrincipal(input.principal_id, 'principal_id');
  const result = await withTransaction(async (conn) => {
    const record = await taskRecord(conn, taskId, true);
    if (!record) throw taskNotFound(taskId);
    await requirePrincipalInAccount(
      conn,
      input.principal_id,
      record.author_account_id,
      'principal_id',
    );
    const { task, post } = record;
    if (task.assignee_principal_id !== null) {
      if (
        task.assignee_principal_id === input.principal_id
        && task.status === 'claimed'
        && task.claimed_at === null
      ) {
        return { task, hasAssigneeTarget: false };
      }
      throw conflict(`Task ${taskId} has already been claimed by another principal`);
    }
    if (task.status !== 'open') {
      throw conflict(`Task ${taskId} is ${task.status}; only open tasks can be claimed`);
    }
    if (!task.is_ready) {
      throw conflict(`Task ${taskId} is not ready and cannot be claimed`);
    }
    const targetRows = rows(await conn.query(
      `SELECT principal_id, role
         FROM post_target
        WHERE post_id = ?`,
      [taskId],
    ));
    const hasTargets = targetRows.length > 0;
    const isAssigneeTarget = targetRows.some(
      (target) =>
        stringValue(target.principal_id) === input.principal_id &&
        stringValue(target.role) === 'assignee',
    );
    if (hasTargets && !isAssigneeTarget) {
      throw notFound(`Principal ${input.principal_id} is not an assignee target for task ${taskId}`);
    }
    if (!hasTargets && post.visibility !== 'public') {
      throw conflict(`Task ${taskId} has no target and is not a public offer`);
    }
    const claimedAt = nowString();
    await conn.query(
      `UPDATE post_task
          SET status = 'claimed', assignee_principal_id = ?, claimed_at = ?
        WHERE post_id = ? AND assignee_principal_id IS NULL`,
      [input.principal_id, claimedAt, taskId],
    );
    const after = await taskRecord(conn, taskId, false);
    if (!after) throw taskNotFound(taskId);
    await recordEvent(conn, {
      account_id: record.author_account_id,
      actor_principal_id: input.principal_id,
      action: 'task.claimed',
      resource_type: 'post',
      resource_id: taskId,
      before_state: taskState(task),
      after_state: taskState(after.task),
    });
    return { task: after.task, hasAssigneeTarget: isAssigneeTarget };
  });
  if (result.hasAssigneeTarget) {
    await markTargetRead(taskId, input.principal_id, 'assignee');
  }
  return result.task;
}

export async function submitTask(
  taskId: string,
  input: SubmitTaskInput,
  options: SubmitTaskOptions = {},
): Promise<SubmitTaskResult> {
  await requirePrincipal(input.principal_id, 'principal_id');
  const result = await withTransaction(async (conn) => {
    const record = await taskRecord(conn, taskId, true);
    if (!record) throw taskNotFound(taskId);
    await requirePrincipalInAccount(
      conn,
      input.principal_id,
      record.author_account_id,
      'principal_id',
    );
    if (record.task.status !== 'claimed') {
      throw conflict(`Task ${taskId} is ${record.task.status}; only claimed tasks can be submitted`);
    }
    if (record.task.assignee_principal_id !== input.principal_id) {
      throw notFound(`Principal ${input.principal_id} is not the assignee of task ${taskId}`);
    }

    const precheck = await precheckDeliverablesWithConnection(
      conn,
      input.deliverables,
      record.author_account_id,
    );
    if (!precheck.ok) {
      const attempts = record.task.attempts + 1;
      const failed = attempts >= record.task.max_attempts;
      await conn.query(
        `UPDATE post_task
            SET attempts = ?, status = ?, closed_at = ?
          WHERE post_id = ?`,
        [attempts, failed ? 'failed' : 'claimed', failed ? nowString() : null, taskId],
      );
      const after = await taskRecord(conn, taskId, false);
      if (!after) throw taskNotFound(taskId);
      await recordEvent(conn, {
        account_id: record.author_account_id,
        actor_principal_id: input.principal_id,
        action: 'task.precheck_failed',
        resource_type: 'post',
        resource_id: taskId,
        before_state: taskState(record.task),
        after_state: taskState(after.task),
        payload: { issues: precheck.issues, attempts, max_attempts: record.task.max_attempts },
      });
      if (input.message?.trim()) {
        await replyPost(conn, {
          parent_id: taskId,
          author_principal_id: input.principal_id,
          body: input.message.trim(),
        });
      }
      return { ok: false, precheck, task: after.task };
    }

    const created: Deliverable[] = [];
    for (const deliverable of input.deliverables) {
      created.push(await createDeliverable(conn, {
        post_id: taskId,
        name: deliverable.name.trim(),
        attachment_id: deliverable.attachment_id ?? null,
        note: deliverable.note?.trim() ?? '',
      }));
    }

    let verifierResult: TaskVerifierResult | undefined;
    const verifier = options.verifier ?? input.verifier;
    if (verifier) {
      verifierResult = await verifier({
        task: record.task,
        deliverables: created,
      });
      if (!verifierResult.ok) {
        const reason = verifierResult.reason?.trim() || 'verifier rejected the submission';
        const attempts = record.task.attempts + 1;
        const failed = attempts >= record.task.max_attempts;
        await conn.query(
          `UPDATE post_task
              SET attempts = ?, status = ?, closed_at = ?
            WHERE post_id = ?`,
          [attempts, failed ? 'failed' : 'claimed', failed ? nowString() : null, taskId],
        );
        const after = await taskRecord(conn, taskId, false);
        if (!after) throw taskNotFound(taskId);
        await recordEvent(conn, {
          account_id: record.author_account_id,
          actor_principal_id: input.principal_id,
          action: 'task.precheck_failed',
          resource_type: 'post',
          resource_id: taskId,
          before_state: taskState(record.task),
          after_state: taskState(after.task),
          payload: {
            issues: [reason],
            attempts,
            max_attempts: record.task.max_attempts,
            verifier_source: verifierResult.source,
          },
        });
        if (input.message?.trim()) {
          await replyPost(conn, {
            parent_id: taskId,
            author_principal_id: input.principal_id,
            body: input.message.trim(),
          });
        }
        return {
          ok: false,
          precheck: { ok: false, issues: [reason] },
          task: after.task,
        };
      }
    }

    await conn.query(
      `UPDATE post_task
          SET status = 'submitted', submitted_at = ?
        WHERE post_id = ?`,
      [nowString(), taskId],
    );
    const after = await taskRecord(conn, taskId, false);
    if (!after) throw taskNotFound(taskId);
    await recordEvent(conn, {
      account_id: record.author_account_id,
      actor_principal_id: input.principal_id,
      action: 'task.submitted',
      resource_type: 'post',
      resource_id: taskId,
      before_state: taskState(record.task),
      after_state: taskState(after.task),
      payload: verifierResult?.source ? { verifier_source: verifierResult.source } : undefined,
    });
    if (input.message?.trim()) {
      await replyPost(conn, {
        parent_id: taskId,
        author_principal_id: input.principal_id,
        body: input.message.trim(),
      });
    }
    return { ok: true, precheck, task: after.task };
  });
  return result;
}

export async function verdictTask(
  taskId: string,
  input: VerdictTaskInput,
): Promise<VerdictTaskResult> {
  if (!['accept', 'reject'].includes(input.decision)) {
    throw badRequest(`Unknown verdict decision: ${input.decision}`);
  }
  return withTransaction(async (conn) => {
    const record = await taskRecord(conn, taskId, true);
    if (!record) throw taskNotFound(taskId);
    await requireTaskOperator(conn, input.operator_principal_id, record.author_account_id);
    if (!['pending_confirm', 'submitted'].includes(record.task.status)) {
      throw conflict(`Task ${taskId} is ${record.task.status}; verdict requires submitted or pending_confirm`);
    }
    const currentAttempts = record.task.attempts;
    const nextAttempts = input.decision === 'reject'
      ? currentAttempts + 1
      : currentAttempts;
    const failed = input.decision === 'reject' && nextAttempts >= record.task.max_attempts;
    const nextStatus: TaskStatus = input.decision === 'accept'
      ? 'done'
      : failed
        ? 'failed'
        : 'claimed';
    const now = nowString();
    const verdictPost = await createPost(conn, {
      account_id: record.author_account_id,
      kind: 'verdict',
      author_principal_id: input.operator_principal_id,
      body: input.opinion?.trim() || input.decision,
      visibility: record.post.visibility,
      parent_id: taskId,
      verdict: {
        decision: input.decision,
        target_task_id: taskId,
        opinion: input.opinion?.trim() ?? '',
        attempt_no: nextAttempts,
        source: input.source ?? 'human',
      },
    });
    await conn.query(
      `UPDATE post_task
          SET status = ?, attempts = ?, closed_at = ?
        WHERE post_id = ?`,
      [nextStatus, nextAttempts, input.decision === 'accept' || failed ? now : null, taskId],
    );
    const after = await taskRecord(conn, taskId, false);
    if (!after) throw taskNotFound(taskId);
    await recordEvent(conn, {
      account_id: record.author_account_id,
      actor_principal_id: input.operator_principal_id,
      action: 'task.verdict',
      resource_type: 'post',
      resource_id: taskId,
      before_state: taskState(record.task),
      after_state: taskState(after.task),
      payload: {
        decision: input.decision,
        opinion: input.opinion?.trim() ?? '',
        source: input.source ?? 'human',
        verdict_post_id: verdictPost.id,
      },
    });
    return {
      task: after.task,
      verdict: {
        post_id: verdictPost.id,
        decision: input.decision,
        opinion: input.opinion?.trim() ?? '',
        target_task_id: taskId,
        attempt_no: nextAttempts,
        source: input.source ?? 'human',
      },
    };
  });
}

export async function reopenTask(
  taskId: string,
  input: ReopenTaskInput,
): Promise<PostTask> {
  return withTransaction(async (conn) => {
    const record = await taskRecord(conn, taskId, true);
    if (!record) throw taskNotFound(taskId);
    await requireTaskOperator(conn, input.operator_principal_id, record.author_account_id);
    if (!['failed', 'done', 'cancelled', 'pending_confirm', 'claimed'].includes(record.task.status)) {
      throw conflict(`Task ${taskId} is ${record.task.status}; only failed, done, cancelled, pending_confirm, or claimed tasks can be reopened`);
    }
    const keepClaimed = record.task.status === 'claimed' && record.task.assignee_principal_id !== null;
    const privateAssigned = record.post.visibility !== 'public' && record.task.assignee_principal_id !== null;
    const nextAssignee = keepClaimed || privateAssigned ? record.task.assignee_principal_id : null;
    const nextStatus = keepClaimed ? 'claimed' : 'open';
    const now = nowString();
    await conn.query(
      `UPDATE post_task
          SET status = ?, assignee_principal_id = ?, attempts = 0,
              claimed_at = NULL, submitted_at = NULL, closed_at = NULL
        WHERE post_id = ?`,
      [nextStatus, nextAssignee, taskId],
    );
    const after = await taskRecord(conn, taskId, false);
    if (!after) throw taskNotFound(taskId);
    await recordEvent(conn, {
      account_id: record.author_account_id,
      actor_principal_id: input.operator_principal_id,
      action: 'task.reopened',
      resource_type: 'post',
      resource_id: taskId,
      before_state: taskState(record.task),
      after_state: taskState(after.task),
      payload: { reason: input.reason?.trim() ?? '', reopened_at: now },
    });
    return after.task;
  });
}

export async function reassignTask(
  taskId: string,
  input: ReassignTaskInput,
): Promise<PostTask> {
  if (input.assignee_principal_id !== null) {
    await requirePrincipal(input.assignee_principal_id, 'assignee_principal_id');
  }
  return withTransaction(async (conn) => {
    const record = await taskRecord(conn, taskId, true);
    if (!record) throw taskNotFound(taskId);
    await requireTaskOperator(conn, input.operator_principal_id, record.author_account_id);
    if (input.assignee_principal_id !== null) {
      await requirePrincipalInAccount(
        conn,
        input.assignee_principal_id,
        record.author_account_id,
        'assignee_principal_id',
      );
    }
    if (!['open', 'claimed', 'failed'].includes(record.task.status)) {
      throw conflict(`Task ${taskId} is ${record.task.status}; only open, claimed, or failed tasks can be reassigned`);
    }
    const assigned = input.assignee_principal_id !== null;
    const nextStatus: TaskStatus = assigned ? 'claimed' : 'open';
    await conn.query(
      `UPDATE post_task
          SET status = ?, assignee_principal_id = ?, attempts = 0,
              claimed_at = ?, submitted_at = NULL, closed_at = NULL
        WHERE post_id = ?`,
      [nextStatus, input.assignee_principal_id, assigned ? nowString() : null, taskId],
    );
    const after = await taskRecord(conn, taskId, false);
    if (!after) throw taskNotFound(taskId);
    await recordEvent(conn, {
      account_id: record.author_account_id,
      actor_principal_id: input.operator_principal_id,
      action: 'task.reassigned',
      resource_type: 'post',
      resource_id: taskId,
      before_state: taskState(record.task),
      after_state: taskState(after.task),
      payload: { assignee_principal_id: input.assignee_principal_id },
    });
    return after.task;
  });
}

export async function cancelTask(
  taskId: string,
  input: CancelTaskInput,
): Promise<PostTask> {
  return withTransaction(async (conn) => {
    const record = await taskRecord(conn, taskId, true);
    if (!record) throw taskNotFound(taskId);
    await requireTaskOperator(conn, input.operator_principal_id, record.author_account_id);
    if (record.task.status === 'cancelled') {
      throw conflict(`Task ${taskId} is already cancelled`);
    }
    if (record.task.status === 'done') {
      throw conflict(`Task ${taskId} is done; completed tasks cannot be cancelled`);
    }
    await conn.query(
      `UPDATE post_task SET status = 'cancelled', closed_at = ? WHERE post_id = ?`,
      [nowString(), taskId],
    );
    const after = await taskRecord(conn, taskId, false);
    if (!after) throw taskNotFound(taskId);
    await recordEvent(conn, {
      account_id: record.author_account_id,
      actor_principal_id: input.operator_principal_id,
      action: 'task.cancelled',
      resource_type: 'post',
      resource_id: taskId,
      before_state: taskState(record.task),
      after_state: taskState(after.task),
      payload: { reason: input.reason?.trim() ?? '' },
    });
    return after.task;
  });
}

export async function listTasks(
  filter: ListTasksFilter,
): Promise<{ items: TaskListItem[]; total: number }> {
  if (!['pool', 'mine', 'due'].includes(filter.view)) {
    throw badRequest(`Unknown task list view: ${filter.view}`);
  }
  if (filter.view !== 'pool' && !filter.principal_id) {
    throw badRequest(`${filter.view} view requires principal_id`);
  }
  const predicates = ['p.kind = \'task\'', 'p.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (filter.account_id) {
    predicates.push('p.account_id = ?');
    params.push(filter.account_id);
  }
  if (filter.view === 'pool') {
    predicates.push(`t.status = 'open'`);
    predicates.push('t.is_ready = 1');
    predicates.push(`p.visibility = 'public'`);
    predicates.push('t.assignee_principal_id IS NULL');
  } else if (filter.view === 'due') {
    predicates.push(`(
      t.assignee_principal_id = ?
      OR (
        t.assignee_principal_id IS NULL
        AND EXISTS (
          SELECT 1
            FROM post_target due_target
           WHERE due_target.post_id = p.id
             AND due_target.principal_id = ?
             AND due_target.role = 'assignee'
        )
      )
    )`);
    params.push(filter.principal_id, filter.principal_id);
    predicates.push(`t.status IN ('open', 'claimed')`);
    predicates.push('t.is_ready = 1');
  } else {
    predicates.push('t.assignee_principal_id = ?');
    params.push(filter.principal_id);
  }
  if (filter.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (statuses.length === 0) throw badRequest('status filter cannot be empty');
    predicates.push(`t.status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  const where = predicates.join(' AND ');
  const pool = getPool();
  const countResult = await pool.query(
    `SELECT COUNT(*) AS total ${taskSelect().replace(/^SELECT .*? FROM /s, 'FROM ')} WHERE ${where}`,
    params,
  );
  const total = numberValue(rows(countResult)[0]?.total);
  const page = Math.max(1, Math.floor(filter.page ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Math.floor(filter.page_size ?? 20) || 20));
  const result = await pool.query(
    `${taskSelect()} WHERE ${where} ORDER BY p.id ASC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  const items: TaskListItem[] = rows(result).map((row) => {
    const post = postFromTaskRow(row);
    const task = taskFromRow(row);
    return { ...post, ...task, post, task };
  });
  if (items.length > 0) {
    const taskIds = items.map((item) => item.post.id);
    const targetResult = await pool.query(
      `SELECT t.post_id, t.principal_id, t.role, t.read_at, t.created_at,
              p.account_id AS principal_account_id, p.kind AS principal_kind,
              p.name AS principal_name
         FROM post_target t
         LEFT JOIN principal p ON p.id = t.principal_id
        WHERE t.post_id IN (${taskIds.map(() => '?').join(', ')})
        ORDER BY t.created_at, t.principal_id, t.role`,
      taskIds,
    );
    const targetsByPost = new Map<string, PostTarget[]>();
    for (const row of rows(targetResult)) {
      const target = targetFromRow(row);
      const current = targetsByPost.get(target.post_id) ?? [];
      current.push(target);
      targetsByPost.set(target.post_id, current);
    }
    for (const item of items) {
      item.targets = targetsByPost.get(item.post.id) ?? [];
    }
  }
  return { items, total };
}

export async function setReady(taskId: string, ready: boolean): Promise<PostTask> {
  return withTransaction(async (conn) => {
    const record = await taskRecord(conn, taskId, true);
    if (!record) throw taskNotFound(taskId);
    await conn.query(
      `UPDATE post_task SET is_ready = ? WHERE post_id = ?`,
      [ready ? 1 : 0, taskId],
    );
    const after = await taskRecord(conn, taskId, false);
    if (!after) throw taskNotFound(taskId);
    await recordEvent(conn, {
      account_id: record.author_account_id,
      actor_principal_id: record.post.author_principal_id,
      action: 'task.ready_changed',
      resource_type: 'post',
      resource_id: taskId,
      before_state: taskState(record.task),
      after_state: taskState(after.task),
      payload: { ready },
    });
    return after.task;
  });
}

export { getPool };
