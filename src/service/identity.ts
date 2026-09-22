import crypto, { scryptSync, timingSafeEqual } from 'node:crypto';
import type { PoolConnection } from 'mariadb';
import { newId } from '../id.js';
import { getPool, withTransaction } from '../db/pool.js';
import { AppError, badRequest, notFound } from '../util/errors.js';
import { normalizeReportedHomeFolder } from '../util/workdir.js';
import {
  invalidateAuthCacheKeyHash,
  invalidateAuthCachePrincipal,
  verifyApiKeyCached,
} from './auth-cache.js';
import { recordEvent } from './event-outbox.js';

export { getPool, initSchema } from '../db/pool.js';
export {
  authCacheSize,
  clearAuthCache,
  invalidateAuthCachePrincipal,
} from './auth-cache.js';

const PRINCIPAL_KINDS = new Set(['user', 'host', 'agent', 'service']);
export const SCOPES = new Set([
  'post:read',
  'post:write',
  'task:read',
  'task:write',
  'task:claim',
  'task:submit',
  'task:verdict',
  'attachment:read',
  'attachment:write',
  'device:execute',
  'key:manage',
  'host:manage',
  'moderate',
]);

type DbRow = Record<string, unknown>;

export type PrincipalKind = 'user' | 'host' | 'agent' | 'service';
export type Scope = (
  | 'post:read'
  | 'post:write'
  | 'task:read'
  | 'task:write'
  | 'task:claim'
  | 'task:submit'
  | 'task:verdict'
  | 'attachment:read'
  | 'attachment:write'
  | 'device:execute'
  | 'key:manage'
  | 'host:manage'
  | 'moderate'
);

export interface Account {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  created_at: string;
  deleted_at: string | null;
}

export interface Principal {
  id: string;
  account_id: string;
  kind: PrincipalKind;
  name: string;
  password_hash: string | null;
  host_principal_id: string | null;
  reputation_score: number;
  created_at: string;
  deleted_at: string | null;
}

export interface Device {
  principal_id: string;
  hostname: string;
  os: string;
  run_user: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export type HostStatus = 'active' | 'disabled';

export interface HostSummary {
  id: string;
  account_id: string;
  name: string;
  status: HostStatus;
  last_seen_at: string | null;
  created_at: string;
  folders: HostFolder[];
}

export interface HostFolder {
  path: string;
  last_seen_at: string;
}

export interface DeviceExecutor {
  principal_id: string;
  cli: string;
  enabled: boolean;
  selected: boolean;
  reported_at: string;
}

export interface ApiKey {
  id: string;
  principal_id: string;
  label: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface CreateAccountInput {
  name: string;
}

export interface CreatePrincipalInput {
  account_id: string;
  kind: PrincipalKind;
  name: string;
  host_principal_id?: string | null;
  password_hash?: string | null;
}

export interface CreateApiKeyInput {
  principal_id: string;
  scopes: string[];
  label?: string;
  expires_at?: string | null;
}

export interface RotateApiKeyOptions {
  key_id?: string;
  label?: string;
  scopes?: string[];
  grace_hours?: number;
}

export interface VerifiedApiKey {
  principal: Principal;
  scopes: Scope[];
  key_id: string;
}

export interface ApiKeyCreation {
  key: string;
  apiKey: ApiKey;
}

function nowString(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function rows(result: unknown): DbRow[] {
  return Array.isArray(result) ? (result as DbRow[]) : [];
}

function affectedRows(result: unknown): number {
  return Number((result as { affectedRows?: number }).affectedRows ?? 0);
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

/** Hash a password with the scrypt format understood by verifyPassword. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = scryptSync(password, salt, 64) as Buffer;
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** Validate the scrypt format used by migrated administrator passwords. */
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (
    scheme !== 'scrypt'
    || !saltHex
    || !hashHex
    || saltHex.length % 2 !== 0
    || hashHex.length % 2 !== 0
    || !/^[0-9a-f]+$/i.test(saltHex)
    || !/^[0-9a-f]+$/i.test(hashHex)
  ) {
    return false;
  }
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (salt.length === 0 || expected.length === 0) return false;
    const derived = scryptSync(password, salt, expected.length) as Buffer;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function validateScopes(scopes: string[]): string[] {
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string')) {
    throw badRequest('scopes must be an array of strings');
  }
  const unique = [...new Set(scopes)];
  const invalid = unique.find((scope) => !SCOPES.has(scope));
  if (invalid) throw badRequest(`Unknown scope: ${invalid}`);
  return unique;
}

function parseScopes(value: unknown): Scope[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stringValue(value));
  } catch (err) {
    throw new Error('Invalid scopes JSON in api_key', { cause: err });
  }
  if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== 'string')) {
    throw new Error('Invalid scopes JSON in api_key');
  }
  const scopes = parsed.filter((scope): scope is Scope => SCOPES.has(scope));
  if (scopes.length !== parsed.length) {
    throw new Error('Invalid scope in api_key');
  }
  return scopes;
}

function accountFromRow(row: DbRow): Account {
  return {
    id: stringValue(row.id),
    name: stringValue(row.name),
    status: stringValue(row.status) as Account['status'],
    created_at: stringValue(row.created_at),
    deleted_at: nullableString(row.deleted_at),
  };
}

function principalFromRow(row: DbRow): Principal {
  return {
    id: stringValue(row.id),
    account_id: stringValue(row.account_id),
    kind: stringValue(row.kind) as PrincipalKind,
    name: stringValue(row.name),
    password_hash: nullableString(row.password_hash),
    host_principal_id: nullableString(row.host_principal_id),
    reputation_score: numberValue(row.reputation_score),
    created_at: stringValue(row.created_at),
    deleted_at: nullableString(row.deleted_at),
  };
}

function deviceFromRow(row: DbRow): Device {
  return {
    principal_id: stringValue(row.principal_id),
    hostname: stringValue(row.hostname),
    os: stringValue(row.os),
    run_user: nullableString(row.run_user),
    last_seen_at: nullableString(row.last_seen_at),
    created_at: stringValue(row.created_at),
  };
}

function hostFromRow(row: DbRow): HostSummary {
  return {
    id: stringValue(row.id),
    account_id: stringValue(row.account_id),
    name: stringValue(row.name),
    status: row.deleted_at === null || row.deleted_at === undefined ? 'active' : 'disabled',
    last_seen_at: nullableString(row.last_seen_at),
    created_at: stringValue(row.created_at),
    folders: [],
  };
}

function hostFolderFromRow(row: DbRow): HostFolder {
  return {
    path: stringValue(row.path),
    last_seen_at: stringValue(row.last_seen_at),
  };
}

function executorFromRow(row: DbRow): DeviceExecutor {
  return {
    principal_id: stringValue(row.principal_id),
    cli: stringValue(row.cli),
    enabled: booleanValue(row.enabled),
    selected: booleanValue(row.selected),
    reported_at: stringValue(row.reported_at),
  };
}

function apiKeyFromRow(row: DbRow): ApiKey {
  return {
    id: stringValue(row.id),
    principal_id: stringValue(row.principal_id),
    label: stringValue(row.label),
    scopes: parseScopes(row.scopes),
    created_at: stringValue(row.created_at),
    last_used_at: nullableString(row.last_used_at),
    expires_at: nullableString(row.expires_at),
    revoked_at: nullableString(row.revoked_at),
  };
}

async function getPrincipalWithConnection(
  conn: PoolConnection,
  id: string,
): Promise<Principal | null> {
  const result = await conn.query(
    `SELECT id, account_id, kind, name, password_hash, host_principal_id,
            reputation_score, created_at, deleted_at
       FROM principal
      WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  const row = rows(result)[0];
  return row ? principalFromRow(row) : null;
}

async function requireHostPrincipal(
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

async function getDeviceByPrincipalId(principalId: string): Promise<Device | null> {
  const result = await getPool().query(
    `SELECT principal_id, hostname, os, run_user, last_seen_at, created_at
       FROM device
      WHERE principal_id = ?`,
    [principalId],
  );
  const row = rows(result)[0];
  return row ? deviceFromRow(row) : null;
}

export async function createAccount({ name }: CreateAccountInput): Promise<Account> {
  const id = newId('acc');
  const createdAt = nowString();
  await getPool().query(
    `INSERT INTO account (id, name, created_at) VALUES (?, ?, ?)`,
    [id, name, createdAt],
  );
  return {
    id,
    name,
    status: 'active',
    created_at: createdAt,
    deleted_at: null,
  };
}

export async function getAccount(id: string): Promise<Account | null> {
  const result = await getPool().query(
    `SELECT id, name, status, created_at, deleted_at
       FROM account
      WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  const row = rows(result)[0];
  return row ? accountFromRow(row) : null;
}

export async function listAccounts({
  page = 1,
  page_size = 20,
}: {
  page?: number;
  page_size?: number;
} = {}): Promise<{ items: Account[]; total: number; page: number; page_size: number }> {
  const currentPage = Math.max(1, Math.floor(page) || 1);
  const pageSize = Math.min(200, Math.max(1, Math.floor(page_size) || 20));
  const where = `FROM account WHERE deleted_at IS NULL`;
  const [countResult, itemResult] = await Promise.all([
    getPool().query(`SELECT COUNT(*) AS total ${where}`),
    getPool().query(
      `SELECT id, name, status, created_at, deleted_at
         ${where}
        ORDER BY id
        LIMIT ? OFFSET ?`,
      [pageSize, (currentPage - 1) * pageSize],
    ),
  ]);
  return {
    items: rows(itemResult).map(accountFromRow),
    total: numberValue(rows(countResult)[0]?.total),
    page: currentPage,
    page_size: pageSize,
  };
}

export async function createPrincipal(input: CreatePrincipalInput): Promise<Principal> {
  if (!PRINCIPAL_KINDS.has(input.kind)) {
    throw badRequest(`Unknown principal kind: ${input.kind}`);
  }
  if (input.kind !== 'agent' && input.host_principal_id) {
    throw badRequest('host_principal_id is only valid for agent principals');
  }
  const id = newId('prn');
  const createdAt = nowString();
  await withTransaction(async (conn) => {
    if (input.host_principal_id) {
      await requireHostPrincipal(conn, input.host_principal_id);
    }
    await conn.query(
      `INSERT INTO principal
         (id, account_id, kind, name, password_hash, host_principal_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.account_id,
        input.kind,
        input.name,
        input.password_hash ?? null,
        input.host_principal_id ?? null,
        createdAt,
      ],
    );
    if (input.kind === 'host') {
      await conn.query(
        `INSERT INTO device (principal_id, created_at) VALUES (?, ?)`,
        [id, createdAt],
      );
    }
  });
  const principal = await getPrincipal(id);
  if (!principal) throw new Error(`Principal was not created: ${id}`);
  return principal;
}

export async function getPrincipal(id: string): Promise<Principal | null> {
  const result = await getPool().query(
    `SELECT id, account_id, kind, name, password_hash, host_principal_id,
            reputation_score, created_at, deleted_at
       FROM principal
      WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  const row = rows(result)[0];
  return row ? principalFromRow(row) : null;
}

async function hostQuery(
  accountId: string,
  hostId?: string,
  includeDeleted = false,
): Promise<HostSummary[]> {
  const predicates = [`p.account_id = ?`, `p.kind = 'host'`];
  const params: unknown[] = [accountId];
  if (!includeDeleted) predicates.push('p.deleted_at IS NULL');
  if (hostId !== undefined) {
    predicates.push('p.id = ?');
    params.push(hostId);
  }
  const result = await getPool().query(
    `SELECT p.id, p.account_id, p.name, p.deleted_at, p.created_at,
            d.last_seen_at
       FROM principal p
       LEFT JOIN device d ON d.principal_id = p.id
      WHERE ${predicates.join(' AND ')}
      ORDER BY p.created_at DESC, p.id DESC`,
    params,
  );
  const hosts = rows(result).map(hostFromRow);
  if (hosts.length === 0) return hosts;

  const folderPredicates = ['p.account_id = ?', `p.kind = 'host'`];
  const folderParams: unknown[] = [accountId];
  if (!includeDeleted) folderPredicates.push('p.deleted_at IS NULL');
  if (hostId !== undefined) {
    folderPredicates.push('p.id = ?');
    folderParams.push(hostId);
  }
  const folderResult = await getPool().query(
    `SELECT hf.host_principal_id, hf.path, hf.last_seen_at
       FROM host_folder hf
       JOIN principal p ON p.id = hf.host_principal_id
      WHERE ${folderPredicates.join(' AND ')}
      ORDER BY hf.host_principal_id, hf.path`,
    folderParams,
  );
  const foldersByHost = new Map<string, HostFolder[]>();
  for (const row of rows(folderResult)) {
    const principalId = stringValue(row.host_principal_id);
    const folders = foldersByHost.get(principalId) ?? [];
    folders.push(hostFolderFromRow(row));
    foldersByHost.set(principalId, folders);
  }
  return hosts.map((host) => ({
    ...host,
    folders: foldersByHost.get(host.id) ?? [],
  }));
}

export async function listHosts(accountId: string): Promise<HostSummary[]> {
  return hostQuery(accountId);
}

export async function getHost(
  accountId: string,
  hostId: string,
): Promise<HostSummary | null> {
  return (await hostQuery(accountId, hostId))[0] ?? null;
}

export async function upsertHostFolders(
  principalId: string,
  paths: readonly unknown[],
): Promise<HostFolder[]> {
  const normalized = [];
  const seen = new Set<string>();
  for (const value of paths) {
    const folder = normalizeReportedHomeFolder(value);
    if (!folder) {
      throw badRequest('每个主机目录都必须是 /home/ 下且规范化后不能逃逸');
    }
    if (!seen.has(folder)) {
      seen.add(folder);
      normalized.push(folder);
    }
  }
  const limited = normalized.slice(0, 200);
  const reportedAt = nowString();
  await withTransaction(async (conn) => {
    await requireHostPrincipal(conn, principalId);
    for (const folder of limited) {
      await conn.query(
        `INSERT INTO host_folder (host_principal_id, path, last_seen_at)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at)`,
        [principalId, folder, reportedAt],
      );
    }
  });

  const result = await getPool().query(
    `SELECT path, last_seen_at
       FROM host_folder
      WHERE host_principal_id = ?
      ORDER BY path`,
    [principalId],
  );
  return rows(result).map(hostFolderFromRow);
}

export async function updateHost(
  accountId: string,
  hostId: string,
  changes: { name?: string; status?: HostStatus },
): Promise<HostSummary | null> {
  const updatedAt = nowString();
  await withTransaction(async (conn) => {
    const result = await conn.query(
      `SELECT id
         FROM principal
        WHERE id = ? AND account_id = ? AND kind = 'host'
        LIMIT 1
        FOR UPDATE`,
      [hostId, accountId],
    );
    if (rows(result).length === 0) return;

    const assignments: string[] = [];
    const params: unknown[] = [];
    if (changes.name !== undefined) {
      assignments.push('name = ?');
      params.push(changes.name);
    }
    if (changes.status !== undefined) {
      assignments.push('deleted_at = ?');
      params.push(changes.status === 'disabled' ? updatedAt : null);
    }
    if (assignments.length === 0) return;
    params.push(hostId, accountId);
    await conn.query(
      `UPDATE principal
          SET ${assignments.join(', ')}
        WHERE id = ? AND account_id = ? AND kind = 'host'`,
      params,
    );
  });
  return (await hostQuery(accountId, hostId, changes.status === 'disabled'))[0] ?? null;
}

export async function deleteHost(
  accountId: string,
  hostId: string,
): Promise<boolean> {
  const deletedAt = nowString();
  return withTransaction(async (conn) => {
    const result = await conn.query(
      `SELECT id
         FROM principal
        WHERE id = ? AND account_id = ? AND kind = 'host'
        LIMIT 1
        FOR UPDATE`,
      [hostId, accountId],
    );
    if (rows(result).length === 0) return false;
    await conn.query(
      `UPDATE principal
          SET deleted_at = ?
        WHERE id = ? AND account_id = ? AND kind = 'host'`,
      [deletedAt, hostId, accountId],
    );
    await conn.query(
      `UPDATE api_key
          SET revoked_at = ?
        WHERE principal_id = ? AND revoked_at IS NULL`,
      [deletedAt, hostId],
    );
    invalidateAuthCachePrincipal(hostId);
    return true;
  });
}

export async function listPrincipals({
  account_id,
  kind,
  page = 1,
  page_size = 20,
}: {
  account_id: string;
  kind?: PrincipalKind;
  page?: number;
  page_size?: number;
}): Promise<{ items: Principal[]; total: number; page: number; page_size: number }> {
  if (kind && !PRINCIPAL_KINDS.has(kind)) throw badRequest(`Unknown principal kind: ${kind}`);
  const currentPage = Math.max(1, Math.floor(page) || 1);
  const pageSize = Math.min(200, Math.max(1, Math.floor(page_size) || 20));
  const params: unknown[] = [account_id];
  const predicates = ['account_id = ?', 'deleted_at IS NULL'];
  if (kind) {
    predicates.push('kind = ?');
    params.push(kind);
  }
  const where = `FROM principal WHERE ${predicates.join(' AND ')}`;
  const [countResult, itemResult] = await Promise.all([
    getPool().query(`SELECT COUNT(*) AS total ${where}`, params),
    getPool().query(
      `SELECT id, account_id, kind, name, password_hash, host_principal_id,
              reputation_score, created_at, deleted_at
         ${where}
        ORDER BY id
        LIMIT ? OFFSET ?`,
      [...params, pageSize, (currentPage - 1) * pageSize],
    ),
  ]);
  return {
    items: rows(itemResult).map(principalFromRow),
    total: numberValue(rows(countResult)[0]?.total),
    page: currentPage,
    page_size: pageSize,
  };
}

export async function registerDevice(
  input: {
    principal_id: string;
    hostname: string;
    os: string;
    run_user?: string | null;
  },
): Promise<Device> {
  const createdAt = nowString();
  await withTransaction(async (conn) => {
    await requireHostPrincipal(conn, input.principal_id);
    await conn.query(
      `INSERT INTO device (principal_id, hostname, os, run_user, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         hostname = VALUES(hostname),
         os = VALUES(os),
         run_user = VALUES(run_user)`,
      [
        input.principal_id,
        input.hostname,
        input.os,
        input.run_user ?? null,
        createdAt,
      ],
    );
  });
  const device = await getDeviceByPrincipalId(input.principal_id);
  if (!device) throw notFound(`Device was not registered: ${input.principal_id}`);
  return device;
}

export async function touchDevice(principalId: string): Promise<Device> {
  const touchedAt = nowString();
  await getPool().query(
    `UPDATE device SET last_seen_at = ? WHERE principal_id = ?`,
    [touchedAt, principalId],
  );
  const device = await getDeviceByPrincipalId(principalId);
  if (!device) throw notFound(`Device not found: ${principalId}`);
  return device;
}

export async function reportExecutors(
  input: {
    principal_id: string;
    clis: string[];
    selected?: string;
  },
): Promise<DeviceExecutor[]> {
  const clis = [...new Set(input.clis)];
  if (clis.some((cli) => !cli || cli.length > 32)) {
    throw badRequest('Each executor CLI must be 1-32 characters');
  }
  if (input.selected !== undefined && !clis.includes(input.selected)) {
    throw badRequest('selected executor must be included in clis');
  }
  const reportedAt = nowString();
  await withTransaction(async (conn) => {
    await requireHostPrincipal(conn, input.principal_id);
    await conn.query(
      `UPDATE device_executor
          SET enabled = 0, selected = 0, reported_at = ?
        WHERE principal_id = ?`,
      [reportedAt, input.principal_id],
    );
    for (const cli of clis) {
      await conn.query(
        `INSERT INTO device_executor
           (principal_id, cli, enabled, selected, reported_at)
         VALUES (?, ?, 1, ?, ?)
         ON DUPLICATE KEY UPDATE
           enabled = 1,
           selected = VALUES(selected),
           reported_at = VALUES(reported_at)`,
        [input.principal_id, cli, input.selected === cli ? 1 : 0, reportedAt],
      );
    }
  });
  const result = await getPool().query(
    `SELECT principal_id, cli, enabled, selected, reported_at
       FROM device_executor
      WHERE principal_id = ?
      ORDER BY cli`,
    [input.principal_id],
  );
  return rows(result).map(executorFromRow);
}

function createSecret(): string {
  return `pk_${crypto.randomBytes(32).toString('base64url')}`;
}

function hashSecret(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

async function insertApiKey(
  conn: PoolConnection,
  input: CreateApiKeyInput,
  createdAt: string,
): Promise<ApiKeyCreation> {
  const principal = await getPrincipalWithConnection(conn, input.principal_id);
  if (!principal) throw notFound(`Principal not found: ${input.principal_id}`);
  const scopes = validateScopes(input.scopes);
  const key = createSecret();
  const id = newId('key');
  await conn.query(
    `INSERT INTO api_key
       (id, principal_id, key_hash, label, scopes, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.principal_id,
      hashSecret(key),
      input.label ?? '',
      JSON.stringify(scopes),
      createdAt,
      input.expires_at ?? null,
    ],
  );
  const result = await conn.query(
    `SELECT id, principal_id, label, scopes, created_at, last_used_at,
            expires_at, revoked_at
       FROM api_key
      WHERE id = ?`,
    [id],
  );
  const row = rows(result)[0];
  if (!row) throw new Error(`API key was not created: ${id}`);
  await recordEvent(conn, {
    account_id: principal.account_id,
    actor_principal_id: principal.id,
    action: 'key.created',
    resource_type: 'key',
    resource_id: id,
    after_state: { principal_id: principal.id, scopes },
  });
  return { key, apiKey: apiKeyFromRow(row) };
}

export async function createApiKey(input: CreateApiKeyInput): Promise<ApiKeyCreation> {
  return withTransaction((conn) => insertApiKey(conn, input, nowString()));
}

export async function verifyApiKey(key: string): Promise<VerifiedApiKey | null> {
  const verified = await verifyApiKeyCached(key);
  if (!verified) return null;
  return {
    principal: {
      id: verified.principal.id,
      account_id: verified.principal.account_id,
      kind: verified.principal.kind,
      name: verified.principal.name,
      password_hash: null,
      host_principal_id: verified.principal.host_principal_id,
      reputation_score: verified.principal.reputation_score,
      created_at: verified.principal.created_at,
      deleted_at: null,
    },
    scopes: verified.scopes as Scope[],
    key_id: verified.key_id,
  };
}

export async function rotateApiKey(
  principalId: string,
  options: RotateApiKeyOptions = {},
): Promise<ApiKeyCreation> {
  const graceHours = options.grace_hours ?? 24;
  if (!Number.isFinite(graceHours) || graceHours < 0) {
    throw badRequest('grace_hours must be a non-negative finite number');
  }
  const issuedAt = nowString();
  const graceUntil = new Date(Date.now() + graceHours * 3600_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  const expiresAt = `${graceUntil.getFullYear()}-${pad(graceUntil.getMonth() + 1)}-${pad(graceUntil.getDate())} ${pad(graceUntil.getHours())}:${pad(graceUntil.getMinutes())}:${pad(graceUntil.getSeconds())}`;
  return withTransaction(async (conn) => {
    const principal = await getPrincipalWithConnection(conn, principalId);
    if (!principal) throw notFound(`Principal not found: ${principalId}`);
    const targetResult = await conn.query(
      `SELECT id, scopes
         FROM api_key
        WHERE id = COALESCE(?, id)
          AND principal_id = ?
          AND revoked_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [options.key_id ?? null, principalId],
    );
    const target = rows(targetResult)[0];
    if (options.key_id !== undefined && !target) {
      throw notFound(`API key not found or revoked: ${options.key_id}`);
    }
    let scopes = options.scopes;
    if (scopes === undefined) {
      scopes = target ? parseScopes(target.scopes) : [];
    }
    const creation = await insertApiKey(
      conn,
      {
        principal_id: principalId,
        scopes,
        label: options.label,
      },
      issuedAt,
    );
    if (target) {
      await conn.query(
        `UPDATE api_key
            SET expires_at = ?
          WHERE id = ? AND principal_id = ? AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)`,
        [expiresAt, target.id, principalId, issuedAt],
      );
      // 旧 key 进入 grace 期后随时可能过期，主动失效该主体全部缓存。
      invalidateAuthCachePrincipal(principalId);
    }
    return creation;
  });
}

export async function revokeApiKey(keyId: string): Promise<void> {
  await withTransaction(async (conn) => {
    const keyRows = rows(await conn.query(
      `SELECT k.id, k.principal_id, k.key_hash, k.revoked_at, p.account_id
         FROM api_key k
         JOIN principal p ON p.id = k.principal_id
        WHERE k.id = ?
        LIMIT 1
        FOR UPDATE`,
      [keyId],
    ));
    const key = keyRows[0];
    if (!key || key.revoked_at) throw notFound(`API key not found or already revoked: ${keyId}`);
    const revokedAt = nowString();
    const result = await conn.query(
      `UPDATE api_key SET revoked_at = ?
        WHERE id = ? AND revoked_at IS NULL`,
      [revokedAt, keyId],
    );
    if (affectedRows(result) === 0) throw notFound(`API key not found or already revoked: ${keyId}`);
    invalidateAuthCacheKeyHash(stringValue(key.key_hash));
    await recordEvent(conn, {
      account_id: stringValue(key.account_id),
      actor_principal_id: stringValue(key.principal_id),
      action: 'key.revoked',
      resource_type: 'key',
      resource_id: keyId,
      after_state: { revoked_at: revokedAt },
    });
  });
}

export async function listApiKeys(principalId: string): Promise<ApiKey[]> {
  const result = await getPool().query(
    `SELECT id, principal_id, label, scopes, created_at, last_used_at,
            expires_at, revoked_at
       FROM api_key
      WHERE principal_id = ?
      ORDER BY id`,
    [principalId],
  );
  return rows(result).map(apiKeyFromRow);
}

/**
 * Change a principal's password after verifying the old one.
 * All label='login' keys are revoked so other sessions are forced to re-login.
 */
export async function changePassword(
  principalId: string,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  if (typeof newPassword !== 'string' || newPassword.length === 0) {
    throw badRequest('new_password 必须是非空字符串');
  }
  if (newPassword.length > 128) {
    throw badRequest('new_password 不能超过 128 个字符');
  }
  await withTransaction(async (conn) => {
    const result = await conn.query(
      `SELECT id, account_id, password_hash
         FROM principal
        WHERE id = ? AND deleted_at IS NULL
        LIMIT 1
        FOR UPDATE`,
      [principalId],
    );
    const row = rows(result)[0];
    if (!row) throw notFound(`Principal not found: ${principalId}`);
    const passwordHash = nullableString(row.password_hash);
    if (!passwordHash || !verifyPassword(oldPassword, passwordHash)) {
      throw new AppError('旧密码不正确', 401);
    }
    const changedAt = nowString();
    await conn.query(
      `UPDATE principal SET password_hash = ? WHERE id = ?`,
      [hashPassword(newPassword), principalId],
    );
    await conn.query(
      `UPDATE api_key
          SET revoked_at = ?
        WHERE principal_id = ? AND label = 'login' AND revoked_at IS NULL`,
      [changedAt, principalId],
    );
    // 登录态全部吊销，主动失效该主体全部鉴权缓存。
    invalidateAuthCachePrincipal(principalId);
    await recordEvent(conn, {
      account_id: stringValue(row.account_id),
      actor_principal_id: principalId,
      action: 'password.changed',
      resource_type: 'principal',
      resource_id: principalId,
      after_state: { login_keys_revoked: true },
    });
  });
}

/** List the caller's own keys, login sessions and long-term keys together. */
export async function listPersonalApiKeys(principalId: string): Promise<ApiKey[]> {
  const result = await getPool().query(
    `SELECT id, principal_id, label, scopes, created_at, last_used_at,
            expires_at, revoked_at
       FROM api_key
      WHERE principal_id = ?
      ORDER BY created_at DESC, id DESC`,
    [principalId],
  );
  return rows(result).map(apiKeyFromRow);
}

/**
 * Issue a personal long-term key. Requested scopes must be a subset of the
 * union of scopes the caller still holds on their active (unrevoked,
 * unexpired) keys; anything else is hidden as not found.
 */
export async function createPersonalApiKey(
  principalId: string,
  input: {
    label?: string;
    scopes: string[];
    expires_at?: string | null;
  },
): Promise<ApiKeyCreation> {
  const scopes = validateScopes(input.scopes);
  if (scopes.length === 0) throw badRequest('scopes 不能为空');
  if (
    input.expires_at != null
    && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(input.expires_at)
  ) {
    throw badRequest('expires_at 必须是 YYYY-MM-DD HH:mm:ss 或 null');
  }
  return withTransaction(async (conn) => {
    const principal = await getPrincipalWithConnection(conn, principalId);
    if (!principal) throw notFound(`Principal not found: ${principalId}`);
    const activeKeys = rows(await conn.query(
      `SELECT scopes
         FROM api_key
        WHERE principal_id = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)`,
      [principalId, nowString()],
    ));
    const allowed = new Set<string>();
    for (const keyRow of activeKeys) {
      for (const scope of parseScopes(keyRow.scopes)) allowed.add(scope);
    }
    const elevated = scopes.find((scope) => !allowed.has(scope));
    if (elevated) throw notFound(`scope not held: ${elevated}`);
    return insertApiKey(
      conn,
      {
        principal_id: principalId,
        scopes,
        label: input.label,
        expires_at: input.expires_at ?? null,
      },
      nowString(),
    );
  });
}

/** Revoke one of the caller's own keys; other principals' keys stay hidden. */
export async function revokePersonalApiKey(
  principalId: string,
  keyId: string,
): Promise<void> {
  const apiKey = await getApiKey(keyId);
  if (!apiKey || apiKey.principal_id !== principalId) {
    throw notFound(`API key not found: ${keyId}`);
  }
  await revokeApiKey(keyId);
}

export async function getApiKey(keyId: string): Promise<ApiKey | null> {
  const result = await getPool().query(
    `SELECT id, principal_id, label, scopes, created_at, last_used_at,
            expires_at, revoked_at
       FROM api_key
      WHERE id = ?
      LIMIT 1`,
    [keyId],
  );
  const row = rows(result)[0];
  return row ? apiKeyFromRow(row) : null;
}

export function hasScope(
  scopes: readonly string[],
  required: string | readonly string[],
): boolean {
  if (typeof required === 'string') return scopes.includes(required);
  return required.every((scope) => scopes.includes(scope));
}
