import type { PoolConnection } from 'mariadb';
import { getPool, withTransaction } from '../db/pool.js';
import { newId } from '../id.js';
import { badRequest, notFound } from '../util/errors.js';
import { recordEvent } from './event-outbox.js';

export type PostKind = 'note' | 'task' | 'message' | 'verdict' | 'channel';
export type PostVisibility = 'private' | 'account' | 'public';
export type TargetRole = 'assignee' | 'mention' | 'watcher';
export type TaskStatus =
  | 'pending_audit'
  | 'rejected'
  | 'open'
  | 'claimed'
  | 'submitted'
  | 'pending_confirm'
  | 'done'
  | 'failed'
  | 'cancelled';
export type VerdictDecision = 'accept' | 'reject';
export type VerdictSource = 'llm' | 'human';

export interface TaskExtensionInput {
  status?: TaskStatus;
  assignee_principal_id?: string | null;
  is_ready?: boolean;
  workdir?: string | null;
  executor?: string | null;
  deliverable_spec: string;
  attempts?: number;
  max_attempts?: number;
  pipeline_step_id?: string | null;
  parent_task_id?: string | null;
  claimed_at?: string | null;
  submitted_at?: string | null;
  closed_at?: string | null;
}

export interface ChannelExtensionInput {
  host_principal_id: string;
  workdir?: string | null;
  run_user?: string | null;
  name?: string;
  status?: 'open' | 'archived';
}

export interface VerdictExtensionInput {
  decision: VerdictDecision;
  target_task_id: string;
  opinion?: string;
  attempt_no?: number;
  source?: VerdictSource;
}

export interface PostExtras {
  task?: TaskExtensionInput;
  channel?: ChannelExtensionInput;
  verdict?: VerdictExtensionInput;
  [key: string]: unknown;
}

export interface CreatePostInput {
  account_id: string;
  kind: PostKind;
  subtype?: string;
  author_principal_id: string;
  title?: string;
  body: string;
  visibility: PostVisibility;
  parent_id?: string | null;
  targets?: Array<{ principal_id: string; role: TargetRole }>;
  task?: TaskExtensionInput;
  channel?: ChannelExtensionInput;
  verdict?: VerdictExtensionInput;
  extras?: PostExtras;
}

export interface PrincipalSummary {
  id: string;
  account_id: string;
  kind: string;
  name: string;
}

export interface Post {
  id: string;
  account_id: string;
  kind: PostKind;
  subtype: string;
  author_principal_id: string;
  author: PrincipalSummary | null;
  title: string;
  body: string;
  visibility: PostVisibility;
  parent_id: string | null;
  root_id: string;
  streaming: boolean;
  revision: number;
  reply_count: number;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

export interface PostTarget {
  post_id: string;
  principal_id: string;
  principal: PrincipalSummary | null;
  role: TargetRole;
  read_at: string | null;
  created_at: string;
}

export interface PostTask {
  post_id: string;
  status: TaskStatus;
  assignee_principal_id: string | null;
  is_ready: boolean;
  workdir: string | null;
  executor: string | null;
  deliverable_spec: string;
  attempts: number;
  max_attempts: number;
  pipeline_step_id: string | null;
  parent_task_id: string | null;
  claimed_at: string | null;
  submitted_at: string | null;
  closed_at: string | null;
}

export interface PostChannel {
  post_id: string;
  host_principal_id: string;
  workdir: string | null;
  run_user: string | null;
  name: string;
  status: 'open' | 'archived';
}

export interface PostVerdict {
  post_id: string;
  decision: VerdictDecision;
  opinion: string;
  target_task_id: string;
  attempt_no: number;
  source: VerdictSource;
}

export interface SummaryView {
  summary: string;
  up_to_post_id: string;
  revision: number;
  stale: boolean;
  pending: number;
}

export interface PostDetail {
  post: Post;
  targets: PostTarget[];
  task: PostTask | null;
  channel: PostChannel | null;
  verdicts: PostVerdict[];
  deliverables: Array<Record<string, unknown>>;
  summary: SummaryView | null;
  recent: Post[];
  more: {
    count: number;
    hint: string;
  };
}

export interface ListPostsFilter {
  account_id: string;
  principal_id?: string;
  kind?: PostKind;
  root_id?: string;
  parent_id?: string | null;
  author_principal_id?: string;
  visibility?: PostVisibility;
  target_principal_id?: string;
  page?: number;
  page_size?: number;
  after?: string;
  limit?: number;
}

export interface ListPostsResult {
  items: Post[];
  total: number;
}

export interface ReplyPostInput {
  parent_id: string;
  author_principal_id: string;
  body: string;
  subtype?: string;
  targets?: Array<{ principal_id: string; role: TargetRole }>;
}

interface DbRow {
  [key: string]: unknown;
}

function nowString(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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

function postSelect(): string {
  return `SELECT p.id, p.account_id, p.kind, p.subtype, p.author_principal_id,
                 p.title, p.body, p.visibility, p.parent_id, p.root_id,
                 p.streaming, p.revision, p.reply_count, p.created_at,
                 p.edited_at, p.deleted_at,
                 pr.id AS author_id, pr.account_id AS author_account_id,
                 pr.kind AS author_kind, pr.name AS author_name
            FROM post p
            LEFT JOIN principal pr ON pr.id = p.author_principal_id`;
}

function postFromRow(row: DbRow): Post {
  const author = row.author_id === undefined || row.author_id === null
    ? null
    : {
        id: stringValue(row.author_id),
        account_id: stringValue(row.author_account_id),
        kind: stringValue(row.author_kind),
        name: stringValue(row.author_name),
      };
  return {
    id: stringValue(row.id),
    account_id: stringValue(row.account_id),
    kind: stringValue(row.kind) as PostKind,
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

export function targetFromRow(row: DbRow): PostTarget {
  const principal = row.principal_id === null || row.principal_id === undefined
    ? null
    : {
        id: stringValue(row.principal_id),
        account_id: stringValue(row.principal_account_id),
        kind: stringValue(row.principal_kind),
        name: stringValue(row.principal_name),
      };
  return {
    post_id: stringValue(row.post_id),
    principal_id: stringValue(row.principal_id),
    principal,
    role: stringValue(row.role) as TargetRole,
    read_at: nullableString(row.read_at),
    created_at: stringValue(row.created_at),
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

function channelFromRow(row: DbRow): PostChannel {
  return {
    post_id: stringValue(row.post_id),
    host_principal_id: stringValue(row.host_principal_id),
    workdir: nullableString(row.workdir),
    run_user: nullableString(row.run_user),
    name: stringValue(row.name),
    status: stringValue(row.status) as PostChannel['status'],
  };
}

function verdictFromRow(row: DbRow): PostVerdict {
  return {
    post_id: stringValue(row.post_id),
    decision: stringValue(row.decision) as VerdictDecision,
    opinion: stringValue(row.opinion),
    target_task_id: stringValue(row.target_task_id),
    attempt_no: numberValue(row.attempt_no),
    source: stringValue(row.source) as VerdictSource,
  };
}

function normalizePage(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(value ?? fallback) || fallback);
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Math.min(200, Math.max(1, Math.floor(value ?? fallback) || fallback));
}

function validateCreateInput(input: CreatePostInput): void {
  if (!input.account_id) throw badRequest('account_id is required');
  if (!input.author_principal_id) throw badRequest('author_principal_id is required');
  if (!input.body && input.body !== '') throw badRequest('body is required');
  if (!['note', 'task', 'message', 'verdict', 'channel'].includes(input.kind)) {
    throw badRequest(`Unknown post kind: ${input.kind}`);
  }
  if (!['private', 'account', 'public'].includes(input.visibility)) {
    throw badRequest(`Unknown post visibility: ${input.visibility}`);
  }
  if (input.targets?.some((target) => !['assignee', 'mention', 'watcher'].includes(target.role))) {
    throw badRequest('Unknown post target role');
  }
}

function taskExtension(input: CreatePostInput): TaskExtensionInput | undefined {
  return input.task ?? input.extras?.task;
}

function channelExtension(input: CreatePostInput): ChannelExtensionInput | undefined {
  return input.channel ?? input.extras?.channel;
}

function verdictExtension(input: CreatePostInput): VerdictExtensionInput | undefined {
  return input.verdict ?? input.extras?.verdict;
}

function validateExtension(input: CreatePostInput): {
  task?: TaskExtensionInput;
  channel?: ChannelExtensionInput;
  verdict?: VerdictExtensionInput;
} {
  const task = taskExtension(input);
  const channel = channelExtension(input);
  const verdict = verdictExtension(input);
  if (input.kind === 'task') {
    if (!task || typeof task.deliverable_spec !== 'string' || task.deliverable_spec.trim() === '') {
      throw badRequest('task deliverable_spec is required');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(task.deliverable_spec);
    } catch {
      parsed = undefined;
    }
    if (
      parsed !== undefined
      && parsed !== null
      && typeof parsed === 'object'
      && ((Array.isArray(parsed) && parsed.length === 0)
        || (!Array.isArray(parsed) && Object.keys(parsed).length === 0))
    ) {
      throw badRequest('task deliverable_spec cannot be empty');
    }
  }
  if (input.kind === 'channel' && (!channel || !channel.host_principal_id)) {
    throw badRequest('channel host_principal_id is required');
  }
  if (input.kind === 'verdict') {
    if (!verdict || !verdict.target_task_id) throw badRequest('verdict target_task_id is required');
    if (!['accept', 'reject'].includes(verdict.decision)) {
      throw badRequest(`Unknown verdict decision: ${verdict.decision}`);
    }
  }
  return { task, channel, verdict };
}

async function getPostByIdWithConnection(
  conn: PoolConnection,
  id: string,
): Promise<Post | null> {
  const result = await conn.query(`${postSelect()} WHERE p.id = ? LIMIT 1`, [id]);
  const row = rows(result)[0];
  return row ? postFromRow(row) : null;
}

async function createPostWithConnection(
  conn: PoolConnection,
  input: CreatePostInput,
): Promise<Post> {
  validateCreateInput(input);
  const extension = validateExtension(input);
  const authorRows = rows(await conn.query(
    `SELECT account_id, kind
       FROM principal
      WHERE id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [input.author_principal_id],
  ));
  const author = authorRows[0];
  if (!author) throw notFound(`author principal not found: ${input.author_principal_id}`);
  if (stringValue(author.account_id) !== input.account_id) {
    throw notFound('author principal belongs to another account');
  }

  const targetIds = [...new Set((input.targets ?? []).map((target) => target.principal_id))];
  if (targetIds.length > 0) {
    const targetRows = rows(await conn.query(
      `SELECT id
         FROM principal
        WHERE account_id = ?
          AND deleted_at IS NULL
          AND id IN (${targetIds.map(() => '?').join(', ')})`,
      [input.account_id, ...targetIds],
    ));
    const validTargetIds = new Set(targetRows.map((row) => stringValue(row.id)));
    const invalidTarget = targetIds.find((principalId) => !validTargetIds.has(principalId));
    if (invalidTarget) {
      throw notFound(`target principal belongs to another account or does not exist: ${invalidTarget}`);
    }
  }

  const id = newId('pst');
  const createdAt = nowString();
  let rootId = id;

  if (input.parent_id) {
    const parentRows = rows(await conn.query(
      `SELECT account_id, root_id FROM post WHERE id = ? LIMIT 1 FOR UPDATE`,
      [input.parent_id],
    ));
    const parent = parentRows[0];
    if (!parent) throw notFound(`Parent post not found: ${input.parent_id}`);
    if (stringValue(parent.account_id) !== input.account_id) {
      throw notFound('parent post belongs to another account');
    }
    rootId = stringValue(parent.root_id);
    if (input.kind === 'message') {
      const channelRows = rows(await conn.query(
        `SELECT c.author_principal_id, ch.host_principal_id, ch.status,
                hp.deleted_at AS host_deleted_at
           FROM post c
           JOIN post_channel ch ON ch.post_id = c.id
           JOIN principal hp ON hp.id = ch.host_principal_id
          WHERE c.id = ? AND c.kind = 'channel'
          LIMIT 1`,
        [rootId],
      ));
      const channel = channelRows[0];
      if (
        channel
        && (
          channel.status !== 'open'
          || channel.host_deleted_at !== null && channel.host_deleted_at !== undefined
          || (
            stringValue(channel.author_principal_id) !== input.author_principal_id
            && stringValue(channel.host_principal_id) !== input.author_principal_id
          )
        )
      ) {
        throw notFound('channel not found');
      }
    }
  }

  await conn.query(
    `INSERT INTO post
       (id, account_id, kind, subtype, author_principal_id, title, body,
        visibility, parent_id, root_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.account_id,
      input.kind,
      input.subtype ?? '',
      input.author_principal_id,
      input.title ?? '',
      input.body,
      input.visibility,
      input.parent_id ?? null,
      rootId,
      createdAt,
    ],
  );

  if (input.kind === 'task') {
    const task = extension.task!;
    await conn.query(
      `INSERT INTO post_task
         (post_id, status, assignee_principal_id, is_ready, workdir, executor,
          deliverable_spec, attempts, max_attempts, pipeline_step_id, parent_task_id,
          claimed_at, submitted_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        task.status ?? 'open',
        task.assignee_principal_id ?? null,
        task.is_ready === false ? 0 : 1,
        task.workdir ?? null,
        task.executor ?? null,
        task.deliverable_spec,
        task.attempts ?? 0,
        task.max_attempts ?? 3,
        task.pipeline_step_id ?? null,
        task.parent_task_id ?? null,
        task.claimed_at ?? null,
        task.submitted_at ?? null,
        task.closed_at ?? null,
      ],
    );
  } else if (input.kind === 'channel') {
    const channel = extension.channel!;
    const hostRows = rows(await conn.query(
      `SELECT account_id
         FROM principal
        WHERE id = ? AND deleted_at IS NULL
        LIMIT 1`,
      [channel.host_principal_id],
    ));
    if (!hostRows[0]) throw notFound(`channel host principal not found: ${channel.host_principal_id}`);
    if (stringValue(hostRows[0].account_id) !== input.account_id) {
      throw notFound('channel host principal belongs to another account');
    }
    await conn.query(
      `INSERT INTO post_channel
         (post_id, host_principal_id, workdir, run_user, name, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        channel.host_principal_id,
        channel.workdir ?? null,
        channel.run_user ?? null,
        channel.name ?? '',
        channel.status ?? 'open',
      ],
    );
  } else if (input.kind === 'verdict') {
    const verdict = extension.verdict!;
    const targetTaskRows = rows(await conn.query(
      `SELECT p.account_id, p.kind
         FROM post p
        WHERE p.id = ? AND p.deleted_at IS NULL
        LIMIT 1`,
      [verdict.target_task_id],
    ));
    const targetTask = targetTaskRows[0];
    if (!targetTask || targetTask.kind !== 'task') {
      throw notFound(`verdict target task not found: ${verdict.target_task_id}`);
    }
    if (stringValue(targetTask.account_id) !== input.account_id) {
      throw notFound('verdict target task belongs to another account');
    }
    await conn.query(
      `INSERT INTO post_verdict
         (post_id, decision, opinion, target_task_id, attempt_no, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        verdict.decision,
        verdict.opinion ?? '',
        verdict.target_task_id,
        verdict.attempt_no ?? 0,
        verdict.source ?? 'human',
      ],
    );
  }

  for (const target of input.targets ?? []) {
    await conn.query(
      `INSERT INTO post_target (post_id, principal_id, role, created_at)
       VALUES (?, ?, ?, ?)`,
      [id, target.principal_id, target.role, createdAt],
    );
  }

  await recordEvent(conn, {
    account_id: input.account_id,
    actor_principal_id: input.author_principal_id,
    action: 'post.created',
    resource_type: 'post',
    resource_id: id,
    after_state: {
      kind: input.kind,
      subtype: input.subtype ?? '',
      parent_id: input.parent_id ?? null,
      root_id: rootId,
      extras: input.extras ?? null,
    },
  });
  if (input.kind === 'task') {
    await recordEvent(conn, {
      account_id: input.account_id,
      actor_principal_id: input.author_principal_id,
      action: 'task.created',
      resource_type: 'post',
      resource_id: id,
    });
  } else if (input.kind === 'channel') {
    await recordEvent(conn, {
      account_id: input.account_id,
      actor_principal_id: input.author_principal_id,
      action: 'channel.created',
      resource_type: 'post',
      resource_id: id,
    });
  } else if (input.kind === 'verdict') {
    await recordEvent(conn, {
      account_id: input.account_id,
      actor_principal_id: input.author_principal_id,
      action: 'verdict.created',
      resource_type: 'post',
      resource_id: id,
    });
  }

  const post = await getPostByIdWithConnection(conn, id);
  if (!post) throw new Error(`Post was not created: ${id}`);
  return post;
}

export function createPost(input: CreatePostInput): Promise<Post>;
export function createPost(conn: PoolConnection, input: CreatePostInput): Promise<Post>;
export async function createPost(
  connOrInput: PoolConnection | CreatePostInput,
  maybeInput?: CreatePostInput,
): Promise<Post> {
  if (maybeInput) return createPostWithConnection(connOrInput as PoolConnection, maybeInput);
  return withTransaction((conn) => createPostWithConnection(conn, connOrInput as CreatePostInput));
}

export async function getPostDetail(id: string): Promise<PostDetail | null> {
  const post = await getVisiblePostById(id);
  if (!post) return null;
  const pool = getPool();
  const [targetResult, taskResult, channelResult, verdictResult, deliverableResult, recentResult, countResult] =
    await Promise.all([
      pool.query(
        `SELECT t.post_id, t.principal_id, t.role, t.read_at, t.created_at,
                p.account_id AS principal_account_id, p.kind AS principal_kind,
                p.name AS principal_name
           FROM post_target t
           LEFT JOIN principal p ON p.id = t.principal_id
          WHERE t.post_id = ?
          ORDER BY t.created_at, t.principal_id, t.role`,
        [id],
      ),
      pool.query(`SELECT * FROM post_task WHERE post_id = ? LIMIT 1`, [id]),
      pool.query(`SELECT * FROM post_channel WHERE post_id = ? LIMIT 1`, [id]),
      pool.query(
        `SELECT v.post_id, v.decision, v.opinion, v.target_task_id, v.attempt_no, v.source
           FROM post_verdict v
           JOIN post verdict_post
             ON verdict_post.id = v.post_id
            AND verdict_post.deleted_at IS NULL
          WHERE v.target_task_id = ?
          ORDER BY v.post_id`,
        [id],
      ),
      pool.query(
        `SELECT d.id, d.post_id, d.name, d.version, d.attachment_id, d.note,
                d.current, d.created_at,
                a.id AS att_id, a.account_id AS att_account_id,
                a.owner_principal_id AS att_owner_principal_id,
                a.filename AS att_filename, a.mime AS att_mime,
                a.size_bytes AS att_size_bytes, a.sha256 AS att_sha256,
                a.relative_path AS att_relative_path, a.scan_status AS att_scan_status,
                a.created_at AS att_created_at, a.deleted_at AS att_deleted_at
           FROM deliverable d
           LEFT JOIN attachment a ON a.id = d.attachment_id AND a.deleted_at IS NULL
          WHERE d.post_id = ?
          ORDER BY d.name, d.version`,
        [id],
      ),
      pool.query(`${postSelect()} WHERE p.root_id = ? AND p.deleted_at IS NULL ORDER BY p.id DESC LIMIT 5`, [post.root_id]),
      pool.query(`SELECT COUNT(*) AS total FROM post WHERE root_id = ? AND deleted_at IS NULL`, [post.root_id]),
    ]);
  const recent = rows(recentResult).map(postFromRow).reverse();
  const total = numberValue(rows(countResult)[0]?.total);
  const [summary] = await Promise.all([getSummary(post.root_id)]);
  return {
    post,
    targets: rows(targetResult).map(targetFromRow),
    task: rows(taskResult)[0] ? taskFromRow(rows(taskResult)[0]) : null,
    channel: rows(channelResult)[0] ? channelFromRow(rows(channelResult)[0]) : null,
    verdicts: rows(verdictResult).map(verdictFromRow),
    deliverables: rows(deliverableResult).map(deliverableFromRow),
    summary,
    recent,
    more: {
      count: Math.max(0, total - recent.length),
      hint: `post(list, root_id='${post.root_id}', after='…')`,
    },
  };
}

function attachmentFromRow(row: DbRow): Record<string, unknown> | null {
  if (row.att_id === null || row.att_id === undefined) return null;
  return {
    id: stringValue(row.att_id),
    account_id: stringValue(row.att_account_id),
    owner_principal_id: stringValue(row.att_owner_principal_id),
    filename: stringValue(row.att_filename),
    mime: stringValue(row.att_mime),
    size_bytes: numberValue(row.att_size_bytes),
    sha256: stringValue(row.att_sha256),
    relative_path: stringValue(row.att_relative_path),
    scan_status: stringValue(row.att_scan_status),
    created_at: stringValue(row.att_created_at),
    deleted_at: nullableString(row.att_deleted_at),
  };
}

function deliverableFromRow(row: DbRow): Record<string, unknown> {
  return {
    id: stringValue(row.id),
    post_id: stringValue(row.post_id),
    name: stringValue(row.name),
    version: numberValue(row.version),
    attachment_id: nullableString(row.attachment_id),
    note: stringValue(row.note),
    current: booleanValue(row.current),
    created_at: stringValue(row.created_at),
    attachment: attachmentFromRow(row),
  };
}

async function getPostById(id: string): Promise<Post | null> {
  const result = await getPool().query(`${postSelect()} WHERE p.id = ? LIMIT 1`, [id]);
  const row = rows(result)[0];
  return row ? postFromRow(row) : null;
}

async function getVisiblePostById(id: string): Promise<Post | null> {
  const result = await getPool().query(
    `${postSelect()} WHERE p.id = ? AND p.deleted_at IS NULL LIMIT 1`,
    [id],
  );
  const row = rows(result)[0];
  return row ? postFromRow(row) : null;
}

async function queryPosts(sql: string, params: unknown[]): Promise<Post[]> {
  const result = await getPool().query(sql, params);
  return rows(result).map(postFromRow);
}

export async function listPosts(filter: ListPostsFilter): Promise<ListPostsResult> {
  if (!filter.account_id) throw badRequest('account_id is required');
  const predicates = ['p.account_id = ?', 'p.deleted_at IS NULL'];
  const params: unknown[] = [filter.account_id];
  if (filter.kind) {
    if (!['note', 'task', 'message', 'verdict', 'channel'].includes(filter.kind)) {
      throw badRequest(`Unknown post kind: ${filter.kind}`);
    }
    predicates.push('p.kind = ?');
    params.push(filter.kind);
  }
  if (filter.kind === 'channel' && filter.principal_id) {
    predicates.push(
      `(p.author_principal_id = ?
        OR EXISTS (
          SELECT 1 FROM post_channel visible_channel
           WHERE visible_channel.post_id = p.id
             AND visible_channel.host_principal_id = ?
             AND visible_channel.status = 'open'
        ))`,
    );
    params.push(filter.principal_id, filter.principal_id);
  }
  if (filter.root_id !== undefined) {
    predicates.push('p.root_id = ?');
    params.push(filter.root_id);
  }
  if (filter.parent_id !== undefined) {
    if (filter.parent_id === null) predicates.push('p.parent_id IS NULL');
    else {
      predicates.push('p.parent_id = ?');
      params.push(filter.parent_id);
    }
  }
  if (filter.author_principal_id) {
    predicates.push('p.author_principal_id = ?');
    params.push(filter.author_principal_id);
  }
  if (filter.visibility) {
    if (!['private', 'account', 'public'].includes(filter.visibility)) {
      throw badRequest(`Unknown post visibility: ${filter.visibility}`);
    }
    predicates.push('p.visibility = ?');
    params.push(filter.visibility);
  }
  if (filter.target_principal_id) {
    predicates.push(
      `EXISTS (
         SELECT 1 FROM post_target inbox_target
          WHERE inbox_target.post_id = p.id
            AND inbox_target.principal_id = ?
       )`,
    );
    params.push(filter.target_principal_id);
  }
  const where = predicates.join(' AND ');
  const countResult = await getPool().query(`SELECT COUNT(*) AS total FROM post p WHERE ${where}`, params);
  const total = numberValue(rows(countResult)[0]?.total);

  const itemParams = [...params];
  let pagination = '';
  if (filter.after !== undefined) {
    pagination = ' AND p.id < ? ORDER BY p.id DESC LIMIT ?';
    itemParams.push(filter.after, normalizeLimit(filter.limit, filter.page_size ?? 20));
  } else {
    const page = normalizePage(filter.page, 1);
    const pageSize = normalizeLimit(filter.page_size, 20);
    pagination = ' ORDER BY p.id DESC LIMIT ? OFFSET ?';
    itemParams.push(pageSize, (page - 1) * pageSize);
  }
  const items = await queryPosts(`${postSelect()} WHERE ${where}${pagination}`, itemParams);
  return { items, total };
}

export async function getThread(rootId: string): Promise<Post[]> {
  return queryPosts(`${postSelect()} WHERE p.root_id = ? AND p.deleted_at IS NULL ORDER BY p.id`, [rootId]);
}

export async function getDirectReplies(postId: string): Promise<Post[]> {
  return queryPosts(`${postSelect()} WHERE p.parent_id = ? AND p.deleted_at IS NULL ORDER BY p.id`, [postId]);
}

async function replyPostWithConnection(
  conn: PoolConnection,
  input: ReplyPostInput,
): Promise<Post> {
    const parentRows = rows(await conn.query(
      `SELECT id, account_id, root_id
         FROM post
        WHERE id = ?
        LIMIT 1
        FOR UPDATE`,
      [input.parent_id],
    ));
    const parent = parentRows[0];
    if (!parent) throw notFound(`Parent post not found: ${input.parent_id}`);
    const post = await createPostWithConnection(conn, {
      account_id: stringValue(parent.account_id),
      kind: 'message',
      subtype: input.subtype,
      author_principal_id: input.author_principal_id,
      body: input.body,
      visibility: 'private',
      parent_id: input.parent_id,
      targets: input.targets,
    });
    await conn.query(
      `UPDATE post SET reply_count = reply_count + 1 WHERE id = ?`,
      [input.parent_id],
    );
    await recordEvent(conn, {
      account_id: stringValue(parent.account_id),
      actor_principal_id: input.author_principal_id,
      action: 'post.replied',
      resource_type: 'post',
      resource_id: post.id,
      payload: { parent_id: input.parent_id },
    });
    return post;
}

export function replyPost(input: ReplyPostInput): Promise<Post>;
export function replyPost(conn: PoolConnection, input: ReplyPostInput): Promise<Post>;
export async function replyPost(
  connOrInput: PoolConnection | ReplyPostInput,
  maybeInput?: ReplyPostInput,
): Promise<Post> {
  if (maybeInput) {
    return replyPostWithConnection(connOrInput as PoolConnection, maybeInput);
  }
  return withTransaction((conn) => replyPostWithConnection(conn, connOrInput as ReplyPostInput));
}

export async function editPost(
  id: string,
  input: { title?: string; body?: string },
): Promise<Post> {
  return withTransaction(async (conn) => {
    const before = await getPostByIdWithConnection(conn, id);
    if (!before) throw notFound(`Post not found: ${id}`);
    if (before.deleted_at) throw notFound(`Post is deleted: ${id}`);
    if (input.title === undefined && input.body === undefined) {
      throw badRequest('title or body is required');
    }
    const nextTitle = input.title ?? before.title;
    const nextBody = input.body ?? before.body;
    const editedAt = nowString();
    await conn.query(
      `UPDATE post
          SET title = ?, body = ?, edited_at = ?, revision = revision + 1
        WHERE id = ? AND deleted_at IS NULL`,
      [nextTitle, nextBody, editedAt, id],
    );
    await recordEvent(conn, {
      account_id: before.account_id,
      actor_principal_id: before.author_principal_id,
      action: 'post.edited',
      resource_type: 'post',
      resource_id: id,
      before_state: { title: before.title, body: before.body, revision: before.revision },
      after_state: { title: nextTitle, body: nextBody, revision: before.revision + 1 },
    });
    const post = await getPostByIdWithConnection(conn, id);
    if (!post) throw new Error(`Post was not found after edit: ${id}`);
    return post;
  });
}

export async function deletePost(id: string): Promise<void> {
  await withTransaction(async (conn) => {
    const before = await getPostByIdWithConnection(conn, id);
    if (!before) throw notFound(`Post not found: ${id}`);
    if (!before.deleted_at) {
      const deletedAt = nowString();
      await conn.query(`UPDATE post SET deleted_at = ? WHERE id = ?`, [deletedAt, id]);
      if (before.parent_id) {
        await conn.query(
          `UPDATE post
              SET reply_count = GREATEST(reply_count - 1, 0)
            WHERE id = ?`,
          [before.parent_id],
        );
      }
      await recordEvent(conn, {
        account_id: before.account_id,
        actor_principal_id: before.author_principal_id,
        action: 'post.deleted',
        resource_type: 'post',
        resource_id: id,
        before_state: { deleted_at: null },
        after_state: { deleted_at: deletedAt },
      });
    }
  });
}

async function targetPostContext(
  conn: PoolConnection,
  postId: string,
): Promise<{ account_id: string; author_principal_id: string }> {
  const result = rows(await conn.query(
    `SELECT account_id, author_principal_id FROM post WHERE id = ? LIMIT 1`,
    [postId],
  ));
  const row = result[0];
  if (!row) throw notFound(`Post not found: ${postId}`);
  return {
    account_id: stringValue(row.account_id),
    author_principal_id: stringValue(row.author_principal_id),
  };
}

async function requireTargetAccount(
  conn: PoolConnection,
  principalId: string,
  accountId: string,
): Promise<void> {
  const result = rows(await conn.query(
    `SELECT account_id
       FROM principal
      WHERE id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [principalId],
  ));
  if (!result[0]) throw notFound(`target principal not found: ${principalId}`);
  if (stringValue(result[0].account_id) !== accountId) {
    throw notFound('target principal belongs to another account');
  }
}

export async function addTarget(
  postId: string,
  principalId: string,
  role: TargetRole,
): Promise<void> {
  if (!['assignee', 'mention', 'watcher'].includes(role)) throw badRequest(`Unknown target role: ${role}`);
  await withTransaction(async (conn) => {
    const context = await targetPostContext(conn, postId);
    await requireTargetAccount(conn, principalId, context.account_id);
    await conn.query(
      `INSERT INTO post_target (post_id, principal_id, role, created_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE read_at = read_at`,
      [postId, principalId, role, nowString()],
    );
    await recordEvent(conn, {
      account_id: context.account_id,
      actor_principal_id: principalId,
      action: 'post.target.added',
      resource_type: 'post',
      resource_id: postId,
      payload: { principal_id: principalId, role },
    });
  });
}

export async function removeTarget(
  postId: string,
  principalId: string,
  role: TargetRole,
): Promise<void> {
  if (!['assignee', 'mention', 'watcher'].includes(role)) throw badRequest(`Unknown target role: ${role}`);
  await withTransaction(async (conn) => {
    const context = await targetPostContext(conn, postId);
    await requireTargetAccount(conn, principalId, context.account_id);
    await conn.query(
      `DELETE FROM post_target WHERE post_id = ? AND principal_id = ? AND role = ?`,
      [postId, principalId, role],
    );
    await recordEvent(conn, {
      account_id: context.account_id,
      actor_principal_id: principalId,
      action: 'post.target.removed',
      resource_type: 'post',
      resource_id: postId,
      payload: { principal_id: principalId, role },
    });
  });
}

export async function markTargetRead(
  postId: string,
  principalId: string,
  role: TargetRole,
): Promise<void> {
  if (!['assignee', 'mention', 'watcher'].includes(role)) throw badRequest(`Unknown target role: ${role}`);
  await withTransaction(async (conn) => {
    const context = await targetPostContext(conn, postId);
    await conn.query(
      `UPDATE post_target SET read_at = ?
        WHERE post_id = ? AND principal_id = ? AND role = ?`,
      [nowString(), postId, principalId, role],
    );
    await recordEvent(conn, {
      account_id: context.account_id,
      actor_principal_id: principalId,
      action: 'post.target.read',
      resource_type: 'post',
      resource_id: postId,
      payload: { principal_id: principalId, role },
    });
  });
}

export async function getSummary(rootId: string): Promise<SummaryView | null> {
  const latestResult = await getPool().query(
    `SELECT summary, up_to_post_id, revision
       FROM post_summary
      WHERE root_id = ?
      ORDER BY revision DESC
      LIMIT 1`,
    [rootId],
  );
  const latest = rows(latestResult)[0];
  if (!latest) return null;
  const pendingResult = await getPool().query(
    `SELECT COUNT(*) AS pending
       FROM post
      WHERE root_id = ? AND id > ? AND deleted_at IS NULL`,
    [rootId, latest.up_to_post_id],
  );
  const pending = numberValue(rows(pendingResult)[0]?.pending);
  return {
    summary: stringValue(latest.summary),
    up_to_post_id: stringValue(latest.up_to_post_id),
    revision: numberValue(latest.revision),
    stale: pending > 0,
    pending,
  };
}

export async function saveSummary(
  rootId: string,
  input: {
    summary: string;
    up_to_post_id: string;
    model: string;
    tokens_in: number;
    tokens_out: number;
  },
): Promise<number> {
  return withTransaction(async (conn) => {
    const rootRows = rows(await conn.query(
      `SELECT account_id FROM post WHERE id = ? AND root_id = ? LIMIT 1 FOR UPDATE`,
      [rootId, rootId],
    ));
    if (rootRows.length === 0) throw notFound(`Root post not found: ${rootId}`);
    const coveredRows = rows(await conn.query(
      `SELECT id FROM post WHERE id = ? AND root_id = ? LIMIT 1`,
      [input.up_to_post_id, rootId],
    ));
    if (coveredRows.length === 0) {
      throw notFound(`Summary boundary is not in root thread: ${input.up_to_post_id}`);
    }
    const revisionResult = await conn.query(
      `SELECT COALESCE(MAX(revision), 0) AS revision
         FROM post_summary
        WHERE root_id = ?`,
      [rootId],
    );
    const revision = numberValue(rows(revisionResult)[0]?.revision) + 1;
    await conn.query(
      `INSERT INTO post_summary
         (root_id, revision, summary, up_to_post_id, model, tokens_in, tokens_out, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rootId,
        revision,
        input.summary,
        input.up_to_post_id,
        input.model,
        input.tokens_in,
        input.tokens_out,
        nowString(),
      ],
    );
    await recordEvent(conn, {
      account_id: stringValue(rootRows[0].account_id),
      action: 'post.summary.saved',
      resource_type: 'post',
      resource_id: rootId,
      payload: { revision, up_to_post_id: input.up_to_post_id, model: input.model },
    });
    return revision;
  });
}

export { getPool };
