import dotenv from 'dotenv';
import mariadb from 'mariadb';
import { tsImport } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const { SCHEMA_STATEMENTS, SCHEMA_TABLE_NAMES } = await tsImport(
  '../src/db/schema.ts',
  import.meta.url,
);

function usageError(message) {
  throw new Error(`${message}\n用法: node scripts/db-rebuild.mjs [--database <name>] [--force]`);
}

function parseArgs() {
  let database = process.env.DB_NAME;
  let force = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--force') {
      force = true;
    } else if (args[i] === '--database') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) usageError('--database 缺少值');
      database = args[i + 1];
      i += 1;
    } else {
      usageError(`未知参数: ${args[i]}`);
    }
  }
  if (!database) usageError('缺少 DB_NAME 或 --database');
  if (!/^[A-Za-z0-9_$]+$/.test(database)) {
    usageError('数据库名只允许字母、数字、下划线和美元符号');
  }
  if (database === 'task_dispatch' && !force) {
    usageError('默认拒绝重建 task_dispatch；如确需操作必须显式传入 --force');
  }
  return { database, force };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function quoteIdentifier(identifier) {
  return `\`${identifier.replaceAll('`', '``')}\``;
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function readWarnings(connection) {
  const rows = await connection.query('SHOW WARNINGS');
  return rows
    .filter((row) => row.Level !== 'Note' && row.level !== 'Note')
    .map((row) => `${row.Level ?? row.level} ${row.Code ?? row.code}: ${row.Message ?? row.message}`);
}

async function databaseExists(connection, database) {
  const rows = await connection.query(
    `SELECT SCHEMA_NAME AS schema_name
       FROM information_schema.schemata
      WHERE schema_name = ?`,
    [database],
  );
  return rows.length > 0;
}

async function main() {
  const { database, force } = parseArgs();
  const connectionOptions = {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: requiredEnv('DB_USER'),
    password: process.env.DB_PASSWORD ?? '',
  };
  let connection;
  const warnings = [];
  try {
    connection = await mariadb.createConnection(connectionOptions);
    const db = quoteIdentifier(database);
    try {
      await connection.query(`CREATE DATABASE IF NOT EXISTS ${db}`);
      warnings.push(...(await readWarnings(connection)));
    } catch (error) {
      if (error?.code !== 'ER_DBACCESS_DENIED_ERROR' || !(await databaseExists(connection, database))) {
        throw error;
      }
      warnings.push(`无法创建数据库 ${database}，但目标库已存在，继续重建`);
    }
    await connection.query(`USE ${db}`);
    await connection.query('SET FOREIGN_KEY_CHECKS=0');
    try {
      const existing = await connection.query(
        `SELECT TABLE_NAME AS table_name
           FROM information_schema.tables
          WHERE table_schema = DATABASE()
            AND table_name IN (${SCHEMA_TABLE_NAMES.map(() => '?').join(', ')})`,
        SCHEMA_TABLE_NAMES,
      );
      const existingTables = new Set(existing.map((row) => row.table_name));
      for (const tableName of [...SCHEMA_TABLE_NAMES].reverse()) {
        if (existingTables.has(tableName)) {
          await connection.query(`DROP TABLE ${quoteIdentifier(tableName)}`);
        }
      }
    } finally {
      await connection.query('SET FOREIGN_KEY_CHECKS=1');
    }

    for (const statement of SCHEMA_STATEMENTS) {
      await connection.query(statement);
      warnings.push(...(await readWarnings(connection)));
    }

    const tableRows = await connection.query(
      `SELECT TABLE_NAME AS table_name
         FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name IN (${SCHEMA_TABLE_NAMES.map(() => '?').join(', ')})`,
      SCHEMA_TABLE_NAMES,
    );
    const indexRows = await connection.query(
      `SELECT TABLE_NAME AS table_name, COUNT(DISTINCT INDEX_NAME) AS index_count
         FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name IN (${SCHEMA_TABLE_NAMES.map(() => '?').join(', ')})
        GROUP BY TABLE_NAME
        ORDER BY TABLE_NAME`,
      SCHEMA_TABLE_NAMES,
    );
    const indexCounts = new Map(indexRows.map((row) => [row.table_name, row.index_count]));
    console.log(`数据库: ${database}${force ? ' (--force)' : ''}`);
    console.log(`表数量: ${tableRows.length}/${SCHEMA_TABLE_NAMES.length}`);
    for (const tableName of SCHEMA_TABLE_NAMES) {
      console.log(`  ${tableName}: ${indexCounts.get(tableName) ?? 0} 个索引`);
    }
    if (warnings.length > 0) {
      console.log(`告警: ${warnings.length}`);
      for (const warning of warnings) console.log(`  ${warning}`);
    } else {
      console.log('告警: 无');
    }
    console.log('失败: 无');
  } finally {
    if (connection) await connection.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(`失败: ${toErrorMessage(error)}`);
  process.exitCode = 1;
}
