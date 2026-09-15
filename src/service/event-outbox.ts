import type { PoolConnection } from 'mariadb';
import { getPool, initSchema, withTransaction } from '../db/pool.js';
import { newId } from '../id.js';

export { getPool, initSchema, withTransaction };

export type EventRetention = 'audit' | 'notify';

export interface RecordEventInput {
  account_id?: string | null;
  actor_principal_id?: string | null;
  action: string;
  resource_type: string;
  resource_id?: string | null;
  before_state?: unknown;
  after_state?: unknown;
  payload?: unknown;
  retention?: EventRetention;
}

export type EventInput = RecordEventInput;

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

export async function recordEvent(
  conn: PoolConnection,
  input: RecordEventInput,
): Promise<string> {
  let accountId = input.account_id;
  if (accountId === undefined && input.actor_principal_id) {
    const result = await conn.query(
      'SELECT account_id FROM principal WHERE id = ?',
      [input.actor_principal_id],
    );
    accountId = nullableString(rows(result)[0]?.account_id);
  }

  const id = newId('evt');
  await conn.query(
    `INSERT INTO event
       (id, account_id, actor_principal_id, action, resource_type, resource_id,
        before_state, after_state, payload, retention, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      accountId ?? null,
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

export interface PublishPendingOptions {
  limit?: number;
  actionPrefix?: string;
  resourceType?: string;
  leaseMs?: number;
}

function escapeLikePrefix(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function visibilityFilter(options: PublishPendingOptions, now: string): {
  clauses: string[];
  params: unknown[];
} {
  const clauses = [
    'published_at IS NULL',
    '(next_attempt_at IS NULL OR next_attempt_at <= ?)',
  ];
  const params: unknown[] = [now];
  if (options.actionPrefix !== undefined) {
    clauses.push(`action LIKE ? ESCAPE '\\\\'`);
    params.push(`${escapeLikePrefix(options.actionPrefix)}%`);
  }
  if (options.resourceType !== undefined) {
    clauses.push('resource_type = ?');
    params.push(options.resourceType);
  }
  return { clauses, params };
}

function addMilliseconds(now: Date, milliseconds: number): string {
  const lease = new Date(now.getTime() + milliseconds);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${lease.getFullYear()}-${pad(lease.getMonth() + 1)}-${pad(lease.getDate())} ${pad(lease.getHours())}:${pad(lease.getMinutes())}:${pad(lease.getSeconds())}`;
}

export async function publishPending({
  limit = 100,
  actionPrefix,
  resourceType,
  leaseMs = 60_000,
}: PublishPendingOptions = {}): Promise<EventRecord[]> {
  const batchSize = Math.min(1000, Math.max(1, Math.floor(limit) || 100));
  const candidateSize = batchSize * 2;
  const leaseDuration = Math.min(24 * 60 * 60 * 1000, Math.max(1, Math.floor(leaseMs) || 60_000));
  return withTransaction(async (conn) => {
    const now = nowString();
    const leaseUntil = addMilliseconds(new Date(), leaseDuration);
    const options = { actionPrefix, resourceType };
    const candidateFilter = visibilityFilter(options, now);
    const candidateResult = await conn.query(
      `SELECT id
         FROM event
        WHERE ${candidateFilter.clauses.join('\n          AND ')}
        ORDER BY id
        LIMIT ?`,
      [...candidateFilter.params, candidateSize],
    );

    const candidateIds = rows(candidateResult)
      .map((row) => stringValue(row.id))
      .filter((id) => id.length > 0);
    if (candidateIds.length === 0) return [];

    const placeholders = candidateIds.map(() => '?').join(', ');
    const lockedFilter = visibilityFilter(options, now);
    const lockedResult = await conn.query(
      `SELECT id, account_id, actor_principal_id, action, resource_type,
              resource_id, before_state, after_state, payload, retention,
              occurred_at, published_at, attempts, next_attempt_at, last_error
         FROM event IGNORE INDEX (idx_evt_outbox)
        WHERE id IN (${placeholders})
          AND ${lockedFilter.clauses.join('\n          AND ')}
        LIMIT ? FOR UPDATE SKIP LOCKED`,
      [...candidateIds, ...lockedFilter.params, batchSize],
    );
    const lockedById = new Map(
      rows(lockedResult).map((row) => [stringValue(row.id), row]),
    );
    const pending = candidateIds
      .map((id) => lockedById.get(id))
      .filter((row): row is Record<string, unknown> => row !== undefined);
    if (pending.length === 0) return [];

    const lockedPlaceholders = pending.map(() => '?').join(', ');
    const claimed = await conn.query(
      `UPDATE event
          SET next_attempt_at = ?, attempts = attempts + 1
        WHERE id IN (${lockedPlaceholders})
          AND ${visibilityFilter(options, now).clauses.join('\n          AND ')}`,
      [leaseUntil, ...pending.map((row) => row.id), ...visibilityFilter(options, now).params],
    );
    const claimedCount = Number((claimed as { affectedRows?: number }).affectedRows ?? 0);
    if (claimedCount === 0) return [];
    for (const row of pending) {
      row.next_attempt_at = leaseUntil;
      row.attempts = numberValue(row.attempts) + 1;
    }
    return pending.map((row) => {
      const event = eventFromRow(row);
      // Keep the historical return shape non-null while the database row remains
      // unpublished until the worker confirms delivery.
      event.published_at = leaseUntil;
      return event;
    });
  });
}

export interface EventLease {
  attempts: number;
  next_attempt_at: string;
}

export async function markPublished(id: string, lease?: EventLease): Promise<void> {
  const predicates = lease
    ? 'published_at IS NULL AND attempts = ? AND next_attempt_at = ?'
    : 'published_at IS NULL';
  const params = lease
    ? [nowString(), id, lease.attempts, lease.next_attempt_at]
    : [nowString(), id];
  const result = await getPool().query(
    `UPDATE event
        SET published_at = ?,
            next_attempt_at = NULL,
            last_error = ''
      WHERE id = ? AND ${predicates}`,
    params,
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
  lease?: EventLease,
): Promise<void> {
  const predicates = lease
    ? 'id = ? AND published_at IS NULL AND attempts = ? AND next_attempt_at = ?'
    : 'id = ?';
  const params = lease
    ? [error.slice(0, 500), nextAttemptAt, id, lease.attempts, lease.next_attempt_at]
    : [error.slice(0, 500), nextAttemptAt, id];
  const result = await getPool().query(
    `UPDATE event
        SET published_at = NULL,
            attempts = attempts${lease ? '' : ' + 1'},
            last_error = ?,
            next_attempt_at = ?
      WHERE ${predicates}`,
    params,
  );
  if (Number((result as { affectedRows?: number }).affectedRows ?? 0) === 0) {
    const existing = await getPool().query('SELECT id FROM event WHERE id = ?', [id]);
    if (rows(existing).length === 0) throw new Error(`Event not found: ${id}`);
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
