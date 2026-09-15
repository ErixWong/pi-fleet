import 'dotenv/config';
import { createPool, type Pool, type PoolConnection } from 'mariadb';
import { config } from '../config.js';
import { SCHEMA_STATEMENTS, SCHEMA_TABLE_NAMES } from './schema.js';

let pool: Pool | null = null;
const UNSUPPORTED_DATABASE = 'task_dispatch';

export function getPool(): Pool {
  if (!pool || pool.closed) {
    if (config.db.database === UNSUPPORTED_DATABASE) {
      throw new Error(
        `不支持旧数据库 "${UNSUPPORTED_DATABASE}"；请通过 DB_NAME_NEW 指定新库`,
      );
    }
    pool = createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
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

export async function initSchema(): Promise<{ created: string[] }> {
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
  return { created };
}
