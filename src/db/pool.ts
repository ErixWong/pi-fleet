import 'dotenv/config';
import { createPool, type Pool, type PoolConnection } from 'mariadb';
import { config } from '../config.js';
import { SCHEMA_STATEMENTS } from './schema.js';

let pool: Pool | null = null;

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
  if (config.dbNew.database === LEGACY_DB) {
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
