import 'dotenv/config';
import { createPool, type Pool, type PoolConnection } from 'mariadb';
import { SCHEMA_STATEMENTS } from './schema.js';

let pool: Pool | null = null;

/** 老模型库名（新模型禁止建表到这里） */
const LEGACY_DB = 'task_dispatch';

/**
 * 新模型库名：DB_NAME_NEW 优先；否则用 DB_NAME（当其不是老库时，兼容既有单测的 DB_NAME=erix）；
 * 最后默认 erix。**绝不回落到老库 task_dispatch**——否则新 schema 会被建进老库。
 */
export function resolveNewDbName(): string {
  const explicit = process.env.DB_NAME_NEW;
  if (explicit) return explicit;
  const fromLegacyVar = process.env.DB_NAME;
  if (fromLegacyVar && fromLegacyVar !== LEGACY_DB) return fromLegacyVar;
  return 'erix';
}

export function getPool(): Pool {
  if (!pool || pool.closed) {
    pool = createPool({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? 'root',
      password: process.env.DB_PASSWORD ?? '',
      database: resolveNewDbName(),
      connectionLimit: 5,
      dateStrings: true,
    });
  }
  return pool;
}

export async function withTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    await conn.release();
  }
}

export async function initSchema(): Promise<void> {
  const target = resolveNewDbName();
  if (target === LEGACY_DB) {
    throw new Error(
      `拒绝把新模型 schema 建进老库 "${LEGACY_DB}"：请用 DB_NAME_NEW 指定新库（如 erix）`,
    );
  }
  for (const statement of SCHEMA_STATEMENTS) {
    const createIfMissing = statement.replace(
      /^CREATE TABLE\s+/i,
      'CREATE TABLE IF NOT EXISTS ',
    );
    await getPool().query(createIfMissing);
  }
}
