import type { PoolConnection } from 'mariadb';
import { newId } from '../id.js';
import { getPool, withTransaction } from '../db/pool.js';
import { badRequest, notFound } from '../util/errors.js';
import { normalizeReportedHomeFolder } from '../util/workdir.js';

export { getPool } from '../db/pool.js';

export const CONTROL_PENDING_LIMIT = 5;
export const CONTROL_PENDING_TTL_MS = 30_000;
export const LIST_DIR_LIMIT = 200;

type DbRow = Record<string, unknown>;

export type HostControlStatus = 'pending' | 'answered' | 'expired';
export type HostControlType = 'list_dir';

export interface HostControlRequest {
  id: string;
  host_principal_id: string;
  type: HostControlType;
  path: string;
  status: HostControlStatus;
  result: unknown | null;
  error: string | null;
  requested_at: string;
  answered_at: string | null;
}

export interface ListDirReportEntry {
  path: string;
  error?: string;
}

export interface ListDirResult {
  entries?: ListDirReportEntry[];
  error?: string;
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

function controlRequestFromRow(row: DbRow): HostControlRequest {
  const payload = JSON.parse(stringValue(row.payload) || '{}') as { path?: unknown };
  let result: unknown | null = null;
  let error: string | null = null;
  if (row.result !== null && row.result !== undefined) {
    const parsed = JSON.parse(stringValue(row.result)) as { error?: unknown; result?: unknown };
    error = typeof parsed.error === 'string' ? parsed.error : null;
    result = parsed.result ?? null;
  }
  return {
    id: stringValue(row.id),
    host_principal_id: stringValue(row.host_principal_id),
    type: stringValue(row.type) as HostControlType,
    path: stringValue(payload.path),
    status: stringValue(row.status) as HostControlStatus,
    result,
    error,
    requested_at: stringValue(row.requested_at),
    answered_at: nullableString(row.answered_at),
  };
}

function parseListDirPayload(value: unknown): { path: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stringValue(value));
  } catch {
    throw badRequest('payload must be a JSON object with a path');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('payload must be a JSON object with a path');
  }
  const path = (parsed as { path?: unknown }).path;
  if (typeof path !== 'string') throw badRequest('payload.path must be a string');
  return { path };
}

async function requireHostWithConnection(
  conn: PoolConnection,
  principalId: string,
): Promise<void> {
  const result = await conn.query(
    `SELECT kind FROM principal WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [principalId],
  );
  const row = rows(result)[0];
  if (!row) throw notFound(`Principal not found: ${principalId}`);
  if (row.kind !== 'host') throw badRequest(`Principal is not a host: ${principalId}`);
}

/** pending 超 TTL 的 requested_at  cutoff（本地时间字符串）。 */
function staleCutoffString(): string {
  const cutoff = new Date(Date.now() - CONTROL_PENDING_TTL_MS);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())} ${pad(cutoff.getHours())}:${pad(cutoff.getMinutes())}:${pad(cutoff.getSeconds())}`;
}

/** 把 pending 超过 TTL 的请求标记为 expired（惰性清理，读取/发起时顺带执行）。 */
async function expireStalePending(conn: PoolConnection): Promise<void> {
  await conn.query(
    `UPDATE host_control_request
        SET status = 'expired', answered_at = ?
      WHERE status = 'pending' AND requested_at < ?`,
    [nowString(), staleCutoffString()],
  );
}

function validateListDirPath(path: string): string {
  const folder = normalizeReportedHomeFolder(path);
  if (!folder) {
    throw badRequest('path must be under /home/ and must not escape');
  }
  return folder;
}

/**
 * 平台发起 list_dir 控制请求：同 host+path pending 去重、每 host pending 上限
 * CONTROL_PENDING_LIMIT、超 TTL 的 pending 惰性置 expired。
 */
export async function createListDirRequest(
  accountId: string,
  hostId: string,
  path: string,
): Promise<HostControlRequest> {
  const folder = validateListDirPath(path);
  return withTransaction(async (conn) => {
    const hostResult = await conn.query(
      `SELECT id FROM principal
        WHERE id = ? AND account_id = ? AND kind = 'host' AND deleted_at IS NULL
        LIMIT 1`,
      [hostId, accountId],
    );
    if (rows(hostResult).length === 0) throw notFound('host not found');

    await expireStalePending(conn);

    const duplicate = await conn.query(
      `SELECT id FROM host_control_request
        WHERE host_principal_id = ? AND type = 'list_dir' AND status = 'pending'
          AND payload = ?
        LIMIT 1`,
      [hostId, JSON.stringify({ path: folder })],
    );
    const duplicateRow = rows(duplicate)[0];
    if (duplicateRow) return getControlRequestWithConnection(conn, stringValue(duplicateRow.id));

    const pendingCount = rows(await conn.query(
      `SELECT id FROM host_control_request
        WHERE host_principal_id = ? AND status = 'pending'`,
      [hostId],
    )).length;
    if (pendingCount >= CONTROL_PENDING_LIMIT) {
      throw badRequest('该主机待响应的控制请求已达上限，请稍后重试');
    }

    const id = newId('hcr');
    const requestedAt = nowString();
    await conn.query(
      `INSERT INTO host_control_request
         (id, host_principal_id, type, payload, status, requested_at)
       VALUES (?, ?, 'list_dir', ?, 'pending', ?)`,
      [id, hostId, JSON.stringify({ path: folder }), requestedAt],
    );
    return getControlRequestWithConnection(conn, id);
  });
}

async function getControlRequestWithConnection(
  conn: PoolConnection,
  id: string,
): Promise<HostControlRequest> {
  const result = await conn.query(
    `SELECT id, host_principal_id, type, payload, status, result, requested_at, answered_at
       FROM host_control_request
      WHERE id = ?`,
    [id],
  );
  const row = rows(result)[0];
  if (!row) throw notFound(`Control request not found: ${id}`);
  return controlRequestFromRow(row);
}

export async function getControlRequest(id: string): Promise<HostControlRequest> {
  // 读路径同样惰性过期，保证 UI/daemon 任何角度看到的 pending 都不超 TTL。
  await getPool().query(
    `UPDATE host_control_request
        SET status = 'expired', answered_at = ?
      WHERE status = 'pending' AND requested_at < ?`,
    [nowString(), staleCutoffString()],
  );
  const result = await getPool().query(
    `SELECT id, host_principal_id, type, payload, status, result, requested_at, answered_at
       FROM host_control_request
      WHERE id = ?`,
    [id],
  );
  const row = rows(result)[0];
  if (!row) throw notFound(`Control request not found: ${id}`);
  return controlRequestFromRow(row);
}

/** daemon 短轮询捎带：取走本主机的 pending 控制请求并惰性过期超时请求。 */
export async function listPendingControlRequests(
  principalId: string,
): Promise<HostControlRequest[]> {
  return withTransaction(async (conn) => {
    await requireHostWithConnection(conn, principalId);
    await expireStalePending(conn);
    const result = await conn.query(
      `SELECT id, host_principal_id, type, payload, status, result, requested_at, answered_at
         FROM host_control_request
        WHERE host_principal_id = ? AND status = 'pending'
        ORDER BY requested_at ASC, id ASC
        LIMIT ?`,
      [principalId, CONTROL_PENDING_LIMIT],
    );
    return rows(result).map(controlRequestFromRow);
  });
}

/**
 * daemon 回传 list_dir 结果：仅当请求仍 pending 时生效（竞态幂等），
 * 结果 upsert 进 host_folder（与心跳深扫底图同表）。每个上报 path 都要过
 * /home/ 下规范化校验。
 */
export async function answerListDirRequest(
  principalId: string,
  requestId: string,
  report: { entries?: readonly unknown[]; error?: unknown },
): Promise<HostControlRequest> {
  return withTransaction(async (conn) => {
    const requestResult = await conn.query(
      `SELECT id, host_principal_id, type, status
         FROM host_control_request
        WHERE id = ?
        LIMIT 1
        FOR UPDATE`,
      [requestId],
    );
    const requestRow = rows(requestResult)[0];
    if (!requestRow) throw notFound('Control request not found');
    if (stringValue(requestRow.host_principal_id) !== principalId) {
      throw notFound('Control request not found');
    }
    if (stringValue(requestRow.status) !== 'pending') {
      return controlRequestFromRow(rows(await conn.query(
        `SELECT id, host_principal_id, type, payload, status, result, requested_at, answered_at
           FROM host_control_request WHERE id = ?`,
        [requestId],
      ))[0]);
    }
    if (stringValue(requestRow.type) !== 'list_dir') {
      throw badRequest('Control request type mismatch');
    }

    const answeredAt = nowString();
    let resultPayload: { error?: string; result?: unknown };
    let foldersToUpsert: string[] = [];
    const entries: ListDirReportEntry[] = [];
    if (typeof report.error === 'string' && report.error) {
      resultPayload = { error: report.error.slice(0, 500) };
    } else if (report.entries !== undefined && !Array.isArray(report.entries)) {
      throw badRequest('entries must be an array');
    } else {
      const seen = new Set<string>();
      for (const value of report.entries ?? []) {
        const raw = value && typeof value === 'object'
          ? (value as { path?: unknown }).path
          : value;
        const folder = normalizeReportedHomeFolder(raw);
        if (!folder) {
          entries.push({ path: String(raw ?? ''), error: 'invalid path' });
          continue;
        }
        if (seen.has(folder)) continue;
        seen.add(folder);
        foldersToUpsert.push(folder);
        entries.push({ path: folder });
      }
      foldersToUpsert = foldersToUpsert.slice(0, LIST_DIR_LIMIT);
      resultPayload = { result: { entries, truncated: entries.length > LIST_DIR_LIMIT } };
    }

    await conn.query(
      `UPDATE host_control_request
          SET status = 'answered', result = ?, answered_at = ?
        WHERE id = ? AND status = 'pending'`,
      [JSON.stringify(resultPayload), answeredAt, requestId],
    );
    for (const folder of foldersToUpsert) {
      await conn.query(
        `INSERT INTO host_folder (host_principal_id, path, last_seen_at)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at)`,
        [principalId, folder, answeredAt],
      );
    }
    return getControlRequestWithConnection(conn, requestId);
  });
}
