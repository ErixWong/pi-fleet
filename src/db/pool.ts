import 'dotenv/config';
import { createPool, type Pool, type PoolConnection } from 'mariadb';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { SCHEMA_STATEMENTS, SCHEMA_TABLE_NAMES } from './schema.js';

let pool: Pool | null = null;
let newDbAvailable = false;

/** 老模型库名（新模型禁止建表到这里） */
const LEGACY_DB = 'task_dispatch';

export function getPool(): Pool {
  if (!pool || pool.closed) {
    pool = createPool({
      host: config.dbNew.host,
      port: config.dbNew.port,
      user: config.dbNew.user,
      password: config.dbNew.password,
      database: config.dbNew.database,
      connectionLimit: 5,
      dateStrings: true,
    });
  }

  return pool;
}

export function isNewDbAvailable(): boolean {
  return newDbAvailable;
}

export function markNewDbUnavailable(): void {
  newDbAvailable = false;
}

/** Keep legacy routes usable while making unavailable new-model routes explicit. */
export const requireNewDb: RequestHandler = (_req, res, next) => {
  if (!newDbAvailable) {
    res.status(503).json({
      error: 'new database unavailable',
      message: `新库 "${config.dbNew.database}" 当前不可用；请检查 DB_NAME_NEW/数据库连接`,
    });
    return;
  }
  next();
};

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

export async function initSchema(): Promise<{ created: string[] }> {
  newDbAvailable = false;
  if (config.dbNew.database === LEGACY_DB) {
    throw new Error(
      `拒绝把新模型 schema 建进老库 "${LEGACY_DB}"：请用 DB_NAME_NEW 指定新库（如 erix）`,
    );
  }
  const existingResult = await getPool().query(
    `SELECT TABLE_NAME AS table_name
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name IN (${SCHEMA_TABLE_NAMES.map(() => '?').join(', ')})`,
    SCHEMA_TABLE_NAMES,
  );
  const existing = new Set(
    (existingResult as Array<{ table_name?: unknown }>).map((row) => String(row.table_name)),
  );
  for (const statement of SCHEMA_STATEMENTS) {
    const createIfMissing = statement.replace(
      /^CREATE TABLE\s+/i,
      'CREATE TABLE IF NOT EXISTS ',
    );
    await getPool().query(createIfMissing);
  }
  const afterResult = await getPool().query(
    `SELECT TABLE_NAME AS table_name
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name IN (${SCHEMA_TABLE_NAMES.map(() => '?').join(', ')})`,
    SCHEMA_TABLE_NAMES,
  );
  const after = new Set(
    (afterResult as Array<{ table_name?: unknown }>).map((row) => String(row.table_name)),
  );
  const created = SCHEMA_TABLE_NAMES.filter((tableName) => !existing.has(tableName) && after.has(tableName));
  newDbAvailable = true;
  return { created };
}
