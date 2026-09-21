import { createHash } from 'node:crypto';
import { getPool } from '../db/pool.js';

export { getPool } from '../db/pool.js';

export const AUTH_CACHE_TTL_MS = 45_000;

type DbRow = Record<string, unknown>;

export type PrincipalKind = 'user' | 'host' | 'agent' | 'service';
export type Scope = string;

export interface CachedPrincipal {
  id: string;
  account_id: string;
  kind: PrincipalKind;
  name: string;
  host_principal_id: string | null;
  reputation_score: number;
  created_at: string;
}

export interface CachedApiKey {
  key_id: string;
  principal: CachedPrincipal;
  scopes: Scope[];
}

interface CacheEntry {
  value: CachedApiKey | null;
  expiresAt: number;
}

function nowString(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function hashSecret(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

const cache = new Map<string, CacheEntry>();

export function authCacheSize(): number {
  return cache.size;
}

export function invalidateAuthCacheKeyHash(keyHash: string): void {
  cache.delete(keyHash);
}

export function invalidateAuthCachePrincipal(principalId: string): void {
  for (const [keyHash, entry] of cache) {
    if (entry.value?.principal.id === principalId) cache.delete(keyHash);
  }
}

export function clearAuthCache(): void {
  cache.clear();
}

function parseScopes(value: unknown): Scope[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value ?? ''));
  } catch (err) {
    throw new Error('Invalid scopes JSON in api_key', { cause: err });
  }
  if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== 'string')) {
    throw new Error('Invalid scopes JSON in api_key');
  }
  return parsed as Scope[];
}

function cachedFromRow(row: DbRow): CachedApiKey {
  return {
    key_id: String(row.key_id ?? ''),
    principal: {
      id: String(row.principal_id ?? ''),
      account_id: String(row.account_id ?? ''),
      kind: String(row.kind ?? '') as PrincipalKind,
      name: String(row.name ?? ''),
      host_principal_id: row.host_principal_id === null || row.host_principal_id === undefined
        ? null
        : String(row.host_principal_id),
      reputation_score: Number(row.reputation_score ?? 0),
      created_at: String(row.created_at ?? ''),
    },
    scopes: parseScopes(row.scopes),
  };
}

/**
 * 带进程内缓存的 api_key 校验（TTL 默认 45s，revoke/删除/轮换时主动失效，
 * 保证 revoke 即时生效）。负结果（无效/撤销 key）同样缓存，TTL 减半。
 */
export async function verifyApiKeyCached(key: string): Promise<CachedApiKey | null> {
  const keyHash = hashSecret(key);
  const now = Date.now();
  const hit = cache.get(keyHash);
  if (hit && hit.expiresAt > now) return hit.value;

  const value = await lookupApiKey(keyHash);
  cache.set(keyHash, {
    value,
    expiresAt: now + (value ? AUTH_CACHE_TTL_MS : Math.floor(AUTH_CACHE_TTL_MS / 2)),
  });
  return value;
}

async function lookupApiKey(keyHash: string): Promise<CachedApiKey | null> {
  const now = nowString();
  const result = await getPool().query(
    `SELECT k.id AS key_id, k.principal_id, k.scopes,
            p.account_id, p.kind, p.name, p.host_principal_id,
            p.reputation_score, p.created_at
       FROM api_key k
       JOIN principal p ON p.id = k.principal_id
       JOIN account a ON a.id = p.account_id
      WHERE k.key_hash = ?
        AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > ?)
        AND p.deleted_at IS NULL
        AND a.status = 'active'
        AND a.deleted_at IS NULL
      LIMIT 1`,
    [keyHash, now],
  );
  const row = (Array.isArray(result) ? result : [])[0] as DbRow | undefined;
  if (!row) return null;
  await getPool().query(
    `UPDATE api_key SET last_used_at = ? WHERE id = ?`,
    [now, String(row.key_id)],
  );
  return cachedFromRow(row);
}
