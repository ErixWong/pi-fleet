import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '../id.js';
import { getPool, withTransaction } from '../db/pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function defaultRoot(): string {
  return path.resolve(here, '../../..', 'attachments');
}

const DEFAULTS: Record<string, string> = {
  attachments_root: defaultRoot(),
  quota_bytes: String(1024 * 1024 * 1024),
  max_attachment_bytes: String(50 * 1024 * 1024),
  clamd_host: '',
  clamd_port: '3310',
  llm_verifier_read_bytes: String(64 * 1024),
  llm_timeout_ms: String(60_000),
  agent_offline_after_min: '30',
};

let cache = new Map<string, string>();

function nowString(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function rows(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? result as Array<Record<string, unknown>> : [];
}

/** Load the new-model setting table into the process-local cache. */
export async function initNewSettings(): Promise<void> {
  const result = await getPool().query(
    `SELECT setting_key, value
       FROM setting`,
  );
  cache = new Map(
    rows(result).map((row) => [String(row.setting_key), String(row.value ?? '')]),
  );
}

/** Read a setting from the new-model cache, falling back to its built-in default. */
export function getSetting(key: string): string {
  return cache.get(key) ?? DEFAULTS[key] ?? '';
}

export function getSettingInt(key: string, fallback: number): number {
  const value = Number(getSetting(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Persist a new-model setting and refresh the cache only after the write commits. */
export async function setSetting(
  key: string,
  value: string,
  changedBy: string | null = null,
): Promise<void> {
  const oldValue = getSetting(key);
  if (oldValue === value) return;
  const updatedAt = nowString();
  await withTransaction(async (conn) => {
    await conn.query(
      `INSERT INTO setting
         (setting_key, value, updated_at, updated_by_principal_id)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         value = VALUES(value),
         updated_at = VALUES(updated_at),
         updated_by_principal_id = VALUES(updated_by_principal_id)`,
      [key, value, updatedAt, changedBy],
    );
    await conn.query(
      `INSERT INTO setting_history
         (id, setting_key, old_value, new_value, changed_by_principal_id, changed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId('seth'), key, oldValue, value, changedBy, updatedAt],
    );
  });
  cache.set(key, value);
}

/** Return configured values plus defaults, matching the legacy settings view semantics. */
export function listSettings(): Record<string, string> {
  const keys = new Set([...Object.keys(DEFAULTS), ...cache.keys()]);
  return Object.fromEntries([...keys].map((key) => [key, getSetting(key)]));
}
