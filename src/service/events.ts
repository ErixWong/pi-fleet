import type { PoolConnection } from 'mariadb';
import { query as legacyQuery } from '../db.js';
import { getPool, withTransaction } from '../db/pool.js';
import { newId } from '../id.js';

export { getPool, initSchema, withTransaction } from '../db/pool.js';

export type EventRetention = 'audit' | 'notify';

export interface EventInput {
  actor_principal_id?: string | null;
  action: string;
  resource_type: string;
  resource_id?: string | null;
  before_state?: unknown;
  after_state?: unknown;
  payload?: unknown;
  retention?: EventRetention;
}

export interface EventRecord {
  id: string;
  account_id: string | null;
  actor_principal_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_state: string | null;
  after_state: string | null;
  payload: string | null;
  retention: EventRetention;
  occurred_at: string;
  published_at: string | null;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string;
}

function nowString(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function serialize(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function rows(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
}

function numberValue(value: unknown): number {
  return Number(value ?? 0);
}

function stringValue(value: unknown): string {
  return String(value ?? '');
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function eventFromRow(row: Record<string, unknown>): EventRecord {
  return {
    id: stringValue(row.id),
    account_id: nullableString(row.account_id),
    actor_principal_id: nullableString(row.actor_principal_id),
    action: stringValue(row.action),
    resource_type: stringValue(row.resource_type),
    resource_id: nullableString(row.resource_id),
    before_state: nullableString(row.before_state),
    after_state: nullableString(row.after_state),
    payload: nullableString(row.payload),
    retention: stringValue(row.retention) as EventRetention,
    occurred_at: stringValue(row.occurred_at),
    published_at: nullableString(row.published_at),
    attempts: numberValue(row.attempts),
    next_attempt_at: nullableString(row.next_attempt_at),
    last_error: stringValue(row.last_error),
  };
}

/**
 * The new event API deliberately takes a transaction connection. It cannot
 * silently acquire another connection because that would break atomicity.
 */
export async function recordEvent(
  conn: PoolConnection,
  input: EventInput,
): Promise<string>;

/**
 * Compatibility overload for the pre-rebuild activity stream. New code must
 * use the connection-first overload above.
 */
export async function recordEvent(
  type: string,
  input: RecordEventInput,
  executor?: EventExecutor,
): Promise<void>;

export async function recordEvent(
  first: PoolConnection | string,
  second: EventInput | RecordEventInput,
  executor: EventExecutor = defaultExecutor,
): Promise<string | void> {
  if (typeof first === 'string') {
    await recordLegacyEvent(first, second as RecordEventInput, executor);
    return;
  }

  const input = second as EventInput;
  const id = newId('evt');
  await first.query(
    `INSERT INTO event
       (id, actor_principal_id, action, resource_type, resource_id,
        before_state, after_state, payload, retention, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.actor_principal_id ?? null,
      input.action,
      input.resource_type,
      input.resource_id ?? null,
      serialize(input.before_state),
      serialize(input.after_state),
      serialize(input.payload),
      input.retention ?? 'audit',
      nowString(),
    ],
  );
  return id;
}

export async function publishPending({
  limit = 100,
}: {
  limit?: number;
} = {}): Promise<EventRecord[]> {
  const batchSize = Math.min(1000, Math.max(1, Math.floor(limit) || 100));
  return withTransaction(async (conn) => {
    const now = nowString();
    const result = await conn.query(
      `SELECT id, account_id, actor_principal_id, action, resource_type,
              resource_id, before_state, after_state, payload, retention,
              occurred_at, published_at, attempts, next_attempt_at, last_error
         FROM event
        WHERE published_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY id
        LIMIT ? FOR UPDATE SKIP LOCKED`,
      [now, batchSize],
    );
    const pending = rows(result);
    for (const row of pending) {
      await conn.query(
        `UPDATE event SET published_at = ? WHERE id = ? AND published_at IS NULL`,
        [now, row.id],
      );
      row.published_at = now;
    }
    return pending.map(eventFromRow);
  });
}

export async function markPublished(id: string): Promise<void> {
  const result = await getPool().query(
    `UPDATE event
        SET published_at = COALESCE(published_at, ?),
            next_attempt_at = NULL,
            last_error = ''
      WHERE id = ?`,
    [nowString(), id],
  );
  if (Number((result as { affectedRows?: number }).affectedRows ?? 0) === 0) {
    const existing = await getPool().query('SELECT id FROM event WHERE id = ?', [id]);
    if (rows(existing).length === 0) throw new Error(`Event not found: ${id}`);
  }
}

export async function markFailed(
  id: string,
  error: string,
  nextAttemptAt: string | null,
): Promise<void> {
  const result = await getPool().query(
    `UPDATE event
        SET published_at = NULL,
            attempts = attempts + 1,
            last_error = ?,
            next_attempt_at = ?
      WHERE id = ?`,
    [error.slice(0, 500), nextAttemptAt, id],
  );
  if (Number((result as { affectedRows?: number }).affectedRows ?? 0) === 0) {
    throw new Error(`Event not found: ${id}`);
  }
}

export async function pruneNotified({
  olderThanDays,
}: {
  olderThanDays: number;
}): Promise<number> {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    throw new Error('olderThanDays must be a non-negative finite number');
  }
  const cutoff = new Date(Date.now() - olderThanDays * 86400_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  const cutoffString = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())} ${pad(cutoff.getHours())}:${pad(cutoff.getMinutes())}:${pad(cutoff.getSeconds())}`;
  const result = await getPool().query(
    `DELETE FROM event
      WHERE retention = 'notify'
        AND published_at IS NOT NULL
        AND occurred_at < ?`,
    [cutoffString],
  );
  return Number((result as { affectedRows?: number }).affectedRows ?? 0);
}

// Legacy activity-stream API retained so the old routes continue to typecheck
// while the rebuilt event API is adopted by later batches.
export type EventActor = 'agent' | 'admin' | 'system';

export interface RecordEventInput {
  actor: EventActor;
  ref_task?: string | number | null;
  ref_plan?: string | number | null;
  summary: string;
}

export interface EventFilter {
  type?: string;
  refTask?: string;
  refPlan?: string;
}

export interface EventView {
  id: string;
  type: string;
  actor: EventActor;
  ref_task: string | null;
  ref_plan: string | null;
  summary: string;
  created_at: string;
  agent_name: string | null;
  task_id: string | null;
  task_title: string | null;
  task_summary: string | null;
  plan_id: string | null;
  plan_name: string | null;
}

type EventExecutor = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
};

const defaultExecutor: EventExecutor = { query: legacyQuery };

async function recordLegacyEvent(
  type: string,
  input: RecordEventInput,
  executor: EventExecutor,
): Promise<void> {
  const refTask = await resolveReference(executor, input.ref_task, 'task');
  const refPlan = await resolveReference(executor, input.ref_plan, 'plan');
  await executor.query(
    `INSERT INTO events (type, actor, ref_task, ref_plan, summary) VALUES (?, ?, ?, ?, ?)`,
    [type.slice(0, 64), input.actor, refTask, refPlan, input.summary.slice(0, 500)],
  );
}

async function resolveReference(
  executor: EventExecutor,
  value: string | number | null | undefined,
  kind: 'task' | 'plan',
): Promise<string | number | null> {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) return Number(value);
  const table = kind === 'task' ? 'tasks' : 'plans';
  const column = kind === 'task' ? 'task_id' : 'plan_id';
  const result = await executor.query(
    `SELECT id FROM ${table} WHERE ${column} = ? LIMIT 1`,
    [String(value)],
  );
  const resultRows = result as Array<Record<string, unknown>>;
  return resultRows.length > 0 ? Number(resultRows[0].id) : null;
}

/** Paginated activity stream retained for the legacy management UI. */
export async function listEvents(
  page = 1,
  pageSize = 20,
  filter: EventFilter = {},
): Promise<{ items: EventView[]; total: number; page: number; page_size: number }> {
  const pageNum = Math.max(1, Math.floor(page) || 1);
  const size = Math.min(200, Math.max(1, Math.floor(pageSize) || 20));
  const params: unknown[] = [];
  const where: string[] = ['1=1'];
  if (filter.type?.trim()) {
    where.push('e.type = ?');
    params.push(filter.type.trim().slice(0, 64));
  }
  if (filter.refTask?.trim()) {
    if (/^\d+$/.test(filter.refTask.trim())) {
      where.push('e.ref_task = ?');
      params.push(Number(filter.refTask));
    } else {
      where.push('t.task_id = ?');
      params.push(filter.refTask.trim());
    }
  }
  if (filter.refPlan?.trim()) {
    if (/^\d+$/.test(filter.refPlan.trim())) {
      where.push('e.ref_plan = ?');
      params.push(Number(filter.refPlan));
    } else {
      where.push('p.plan_id = ?');
      params.push(filter.refPlan.trim());
    }
  }
  const joins = `
    FROM events e
    LEFT JOIN tasks t ON t.id = e.ref_task
    LEFT JOIN plans p ON p.id = e.ref_plan
    LEFT JOIN agents ta ON ta.id = t.assignee_id
    LEFT JOIN agents tc ON tc.id = t.creator_id`;
  const predicate = ` WHERE ${where.join(' AND ')}`;
  const totalRows = (await legacyQuery(
    `SELECT COUNT(*) AS c ${joins}${predicate}`,
    params,
  )) as Array<Record<string, unknown>>;
  const total = Number(totalRows[0]?.c ?? 0);
  const result = (await legacyQuery(
    `SELECT e.id, e.type, e.actor, e.ref_task, e.ref_plan, e.summary, e.created_at,
            COALESCE(ta.name, tc.name) AS agent_name,
            t.task_id, t.title AS task_title, LEFT(t.instruction, 240) AS task_summary,
            p.plan_id, p.name AS plan_name
       ${joins}${predicate}
      ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`,
    [...params, size, (pageNum - 1) * size],
  )) as Array<Record<string, unknown>>;
  const items = result.map((row) => ({
    id: String(row.id),
    type: String(row.type),
    actor: String(row.actor) as EventActor,
    ref_task: row.ref_task === null || row.ref_task === undefined ? null : String(row.ref_task),
    ref_plan: row.ref_plan === null || row.ref_plan === undefined ? null : String(row.ref_plan),
    summary: String(row.summary ?? ''),
    created_at: String(row.created_at),
    agent_name: (row.agent_name as string | null) ?? null,
    task_id: (row.task_id as string | null) ?? null,
    task_title: (row.task_title as string | null) ?? null,
    task_summary: (row.task_summary as string | null) ?? null,
    plan_id: (row.plan_id as string | null) ?? null,
    plan_name: (row.plan_name as string | null) ?? null,
  }));
  return { items, total, page: pageNum, page_size: size };
}
