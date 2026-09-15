import type { PoolConnection } from 'mariadb';
import { getPool, withTransaction } from '../db/pool.js';
import { getSettingInt } from './new-settings.js';
import { recordEvent } from './event-outbox.js';

const DEFAULT_CLAIM_TIMEOUT_HOURS = 2;
const DEFAULT_PENDING_CONFIRM_TIMEOUT_DAYS = 7;
const DEFAULT_BATCH_SIZE = 100;

interface DbRow {
  [key: string]: unknown;
}

export interface LifecycleOptions {
  claim_timeout_hours?: number;
  pending_confirm_timeout_days?: number;
  claimTimeoutHours?: number;
  pendingConfirmTimeoutDays?: number;
  batch?: number;
  /** Used by tests and keeps all cutoff values computed by Node. */
  now?: Date;
}

export interface LifecycleResult {
  reclaimed: number;
  autoConfirmed: number;
}

export interface LifecycleWorkerOptions extends LifecycleOptions {
  intervalMs?: number;
}

function rows(result: unknown): DbRow[] {
  return Array.isArray(result) ? result as DbRow[] : [];
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

function dateString(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function cutoffString(now: Date, milliseconds: number): string {
  return dateString(new Date(now.getTime() - milliseconds));
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Math.min(1000, Math.max(1, Math.floor(positiveNumber(value, fallback))));
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function taskState(row: DbRow): Record<string, unknown> {
  return {
    status: stringValue(row.status),
    assignee_principal_id: nullableString(row.assignee_principal_id),
    claimed_at: nullableString(row.claimed_at),
    submitted_at: nullableString(row.submitted_at),
    closed_at: nullableString(row.closed_at),
  };
}

interface LifecycleTaskRow extends DbRow {
  post_id: string;
  account_id: string;
}

async function staleTaskRows(
  conn: PoolConnection,
  status: 'claimed' | 'pending_confirm',
  activityColumn: 'claimed_at' | 'submitted_at',
  boundary: string,
  batchSize: number,
): Promise<LifecycleTaskRow[]> {
  // The first read is deliberately unordered: the status index supplies the
  // bounded candidate scan without an ORDER BY/filesort. The second read
  // locks only primary-key candidates and lets concurrent workers skip locks.
  const candidates = rows(await conn.query(
    `SELECT post_id
       FROM post_task
      WHERE status = ?
        AND ${activityColumn} IS NOT NULL
        AND ${activityColumn} < ?
      LIMIT ?`,
    [status, boundary, batchSize],
  ));
  const candidateIds = candidates
    .map((row) => stringValue(row.post_id))
    .filter((id) => id.length > 0);
  if (candidateIds.length === 0) return [];

  const locked = rows(await conn.query(
    `SELECT pt.post_id, pt.status, pt.assignee_principal_id,
            pt.claimed_at, pt.submitted_at, pt.closed_at,
            p.account_id
       FROM post_task pt
       JOIN post p ON p.id = pt.post_id
      WHERE pt.post_id IN (${placeholders(candidateIds.length)})
        AND pt.status = ?
        AND pt.${activityColumn} IS NOT NULL
        AND pt.${activityColumn} < ?
      LIMIT ? FOR UPDATE SKIP LOCKED`,
    [...candidateIds, status, boundary, batchSize],
  ));
  return locked.map((row) => ({
    ...row,
    post_id: stringValue(row.post_id),
    account_id: stringValue(row.account_id),
  }));
}

async function reclaimBatch(
  boundary: string,
  batchSize: number,
  timeoutHours: number,
  now: string,
): Promise<number> {
  return withTransaction(async (conn) => {
    const stale = await staleTaskRows(conn, 'claimed', 'claimed_at', boundary, batchSize);
    if (stale.length === 0) return 0;
    const ids = stale.map((row) => row.post_id);
    await conn.query(
      `UPDATE post_task
          SET status = 'open',
              assignee_principal_id = NULL,
              claimed_at = NULL
        WHERE post_id IN (${placeholders(ids.length)})
          AND status = 'claimed'
          AND claimed_at IS NOT NULL
          AND claimed_at < ?`,
      [...ids, boundary],
    );
    for (const row of stale) {
      await recordEvent(conn, {
        account_id: row.account_id,
        action: 'task.reclaimed',
        resource_type: 'post',
        resource_id: row.post_id,
        before_state: taskState(row),
        after_state: {
          ...taskState(row),
          status: 'open',
          assignee_principal_id: null,
          claimed_at: null,
        },
        payload: {
          activity_field: 'claimed_at',
          timeout_hours: timeoutHours,
          reclaimed_at: now,
        },
      });
    }
    return stale.length;
  });
}

async function autoConfirmBatch(
  boundary: string,
  batchSize: number,
  timeoutDays: number,
  now: string,
): Promise<number> {
  return withTransaction(async (conn) => {
    const stale = await staleTaskRows(
      conn,
      'pending_confirm',
      'submitted_at',
      boundary,
      batchSize,
    );
    if (stale.length === 0) return 0;
    const ids = stale.map((row) => row.post_id);
    await conn.query(
      `UPDATE post_task
          SET status = 'done',
              closed_at = ?
        WHERE post_id IN (${placeholders(ids.length)})
          AND status = 'pending_confirm'
          AND submitted_at IS NOT NULL
          AND submitted_at < ?`,
      [now, ...ids, boundary],
    );
    for (const row of stale) {
      await recordEvent(conn, {
        account_id: row.account_id,
        action: 'task.auto_confirmed',
        resource_type: 'post',
        resource_id: row.post_id,
        before_state: taskState(row),
        after_state: {
          ...taskState(row),
          status: 'done',
          closed_at: now,
        },
        payload: {
          activity_field: 'submitted_at',
          timeout_days: timeoutDays,
          confirmed_at: now,
        },
      });
    }
    return stale.length;
  });
}

/**
 * Collect stale tasks from the new post/post_task surface.
 *
 * post_task has no last_activity_at column. For the claimed state the
 * lifecycle clock is claimed_at; for pending_confirm it is submitted_at.
 * Both boundaries are calculated in Node and passed to SQL as parameters.
 */
export async function runLifecycleCollection(
  options: LifecycleOptions = {},
): Promise<LifecycleResult> {
  const nowDate = options.now ?? new Date();
  const now = dateString(nowDate);
  const claimTimeoutHours = positiveNumber(
    options.claim_timeout_hours ?? options.claimTimeoutHours,
    getSettingInt('claim_timeout_hours', DEFAULT_CLAIM_TIMEOUT_HOURS),
  );
  const pendingConfirmTimeoutDays = positiveNumber(
    options.pending_confirm_timeout_days ?? options.pendingConfirmTimeoutDays,
    getSettingInt('pending_confirm_timeout_days', DEFAULT_PENDING_CONFIRM_TIMEOUT_DAYS),
  );
  const batchSize = positiveInteger(options.batch, DEFAULT_BATCH_SIZE);
  const claimBoundary = cutoffString(nowDate, claimTimeoutHours * 60 * 60 * 1000);
  const pendingConfirmBoundary = cutoffString(nowDate, pendingConfirmTimeoutDays * 24 * 60 * 60 * 1000);

  let reclaimed = 0;
  let autoConfirmed = 0;
  while (true) {
    const count = await reclaimBatch(
      claimBoundary,
      batchSize,
      claimTimeoutHours,
      now,
    );
    reclaimed += count;
    if (count === 0 || count < batchSize) break;
  }
  while (true) {
    const count = await autoConfirmBatch(
      pendingConfirmBoundary,
      batchSize,
      pendingConfirmTimeoutDays,
      now,
    );
    autoConfirmed += count;
    if (count === 0 || count < batchSize) break;
  }
  return { reclaimed, autoConfirmed };
}

/** Alias used by callers that treat lifecycle collection as a worker tick. */
export const runLifecycleOnce = runLifecycleCollection;
export const collectLifecycle = runLifecycleCollection;
export const runLifecycle = runLifecycleCollection;

export function startLifecycleWorker(
  options: LifecycleWorkerOptions = {},
): () => void {
  const intervalMs = Math.max(100, Math.floor(options.intervalMs ?? 60_000) || 60_000);
  let stopped = false;
  let running = false;
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await runLifecycleCollection(options);
      if (result.reclaimed + result.autoConfirmed > 0) {
        console.log(
          `[lifecycle] reclaimed=${result.reclaimed} auto_confirmed=${result.autoConfirmed}`,
        );
      }
    } catch (error) {
      console.error('[lifecycle] worker failed:', error);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export const getLifecyclePool = getPool;
