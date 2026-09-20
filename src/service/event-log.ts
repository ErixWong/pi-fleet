import { getPool } from '../db/pool.js';

export { getPool };

export interface EventView {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  actor_principal_id: string | null;
  actor_name: string | null;
  actor_kind: string | null;
  account_id: string | null;
  summary: string;
  payload: unknown;
  retention: 'audit' | 'notify';
  occurred_at: string;
  published_at: string | null;
  attempts: number;
  last_error: string;
  resource_title: string | null;
  post_kind: string | null;
}

interface EventRow {
  [key: string]: unknown;
}

function rows(result: unknown): EventRow[] {
  return Array.isArray(result) ? result as EventRow[] : [];
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

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function eventFromRow(row: EventRow): EventView {
  const before = parseJson(row.before_state);
  const after = parseJson(row.after_state);
  const payload = parseJson(row.payload);
  return {
    id: stringValue(row.id),
    action: stringValue(row.action),
    resource_type: stringValue(row.resource_type),
    resource_id: nullableString(row.resource_id),
    actor_principal_id: nullableString(row.actor_principal_id),
    actor_name: nullableString(row.actor_name),
    actor_kind: nullableString(row.actor_kind),
    account_id: nullableString(row.account_id),
    summary: renderEventSummary({
      action: stringValue(row.action),
      resource_type: stringValue(row.resource_type),
      resource_id: nullableString(row.resource_id),
      before_state: before,
      after_state: after,
      payload,
    }),
    payload,
    retention: stringValue(row.retention) as EventView['retention'],
    occurred_at: stringValue(row.occurred_at),
    published_at: nullableString(row.published_at),
    attempts: numberValue(row.attempts),
    last_error: stringValue(row.last_error),
    resource_title: nullableString(row.resource_title),
    post_kind: nullableString(row.post_kind),
  };
}

export function renderEventSummary(event: {
  action: string;
  resource_type?: string;
  resource_id?: string | null;
  before_state?: unknown;
  after_state?: unknown;
  payload?: unknown;
}): string {
  const action = event.action.replaceAll('.', ' ');
  const resource = event.resource_id
    ? ` ${event.resource_type ?? 'resource'} ${event.resource_id}`
    : '';
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown>
    : null;
  if (payload?.reason && typeof payload.reason === 'string') {
    return `${action}${resource}: ${payload.reason}`.slice(0, 500);
  }
  if (payload?.decision && typeof payload.decision === 'string') {
    return `${action}${resource}: ${payload.decision}`.slice(0, 500);
  }
  const after = event.after_state && typeof event.after_state === 'object'
    ? event.after_state as Record<string, unknown>
    : null;
  if (after?.status && typeof after.status === 'string') {
    return `${action}${resource}: ${after.status}`.slice(0, 500);
  }
  return `${action}${resource}`.slice(0, 500);
}

export async function listEventLog(filter: {
  account_id?: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  actor_principal_id?: string;
  after?: string;
  limit?: number;
  order?: 'asc' | 'desc';
} = {}): Promise<{ items: EventView[]; total: number; next_after: string | null }> {
  const limit = Math.min(200, Math.max(1, Math.floor(filter.limit ?? 50) || 50));
  // 缺省 asc 保持事件日志管理面的 keyset 分页语义；desc 供“最近活动”类视图取最新 N 条
  const order = filter.order === 'desc' ? 'DESC' : 'ASC';
  const predicates: string[] = [];
  const params: unknown[] = [];
  if (filter.account_id) {
    predicates.push('e.account_id = ?');
    params.push(filter.account_id);
  }
  if (filter.action) {
    predicates.push('e.action = ?');
    params.push(filter.action);
  }
  if (filter.resource_type) {
    predicates.push('e.resource_type = ?');
    params.push(filter.resource_type);
  }
  if (filter.resource_id) {
    predicates.push('e.resource_id = ?');
    params.push(filter.resource_id);
  }
  if (filter.actor_principal_id) {
    predicates.push('e.actor_principal_id = ?');
    params.push(filter.actor_principal_id);
  }
  if (filter.after) {
    predicates.push(order === 'DESC' ? 'e.id < ?' : 'e.id > ?');
    params.push(filter.after);
  }
  const where = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : '';
  const pool = getPool();
  const countRows = await pool.query(
    `SELECT COUNT(*) AS total
       FROM event e
      ${where}`,
    params,
  );
  const result = await pool.query(
    `SELECT e.id, e.action, e.resource_type, e.resource_id,
            e.actor_principal_id, e.account_id, e.payload, e.before_state,
            e.after_state, e.retention, e.occurred_at, e.published_at,
            e.attempts, e.last_error,
            pr.name AS actor_name, pr.kind AS actor_kind,
            p.title AS resource_title, p.kind AS post_kind
       FROM event e
       LEFT JOIN principal pr ON pr.id = e.actor_principal_id
       LEFT JOIN post p ON e.resource_type = 'post' AND p.id = e.resource_id
      ${where}
      ORDER BY e.id ${order}
      LIMIT ?`,
    [...params, limit],
  );
  const items = rows(result).map(eventFromRow);
  return {
    items,
    total: numberValue(rows(countRows)[0]?.total),
    next_after: items.length > 0 ? items[items.length - 1].id : null,
  };
}
