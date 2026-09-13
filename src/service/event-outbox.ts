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
