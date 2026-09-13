import 'dotenv/config';
import { createPool, type Pool, type PoolConnection } from 'mariadb';
import { SCHEMA_STATEMENTS } from './schema.js';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool || pool.closed) {
    pool = createPool({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? 'root',
      password: process.env.DB_PASSWORD ?? '',
      database: process.env.DB_NAME ?? 'task_dispatch',
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
  for (const statement of SCHEMA_STATEMENTS) {
    const createIfMissing = statement.replace(
      /^CREATE TABLE\s+/i,
      'CREATE TABLE IF NOT EXISTS ',
    );
    await getPool().query(createIfMissing);
  }
}
