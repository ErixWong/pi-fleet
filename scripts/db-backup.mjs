import dotenv from 'dotenv';
import mariadb from 'mariadb';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

function usageError(message) {
  throw new Error(`${message}\n用法: node scripts/db-backup.mjs [--database <name>] [--out <path>]`);
}

function parseArgs() {
  let database = process.env.DB_NAME_NEW ?? process.env.DB_NAME ?? 'erix';
  let output = null;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--database') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) usageError('--database 缺少值');
      database = args[i + 1];
      i += 1;
    } else if (args[i] === '--out') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) usageError('--out 缺少值');
      output = args[i + 1];
      i += 1;
    } else {
      usageError(`未知参数: ${args[i]}`);
    }
  }
  if (!/^[A-Za-z0-9_$]+$/.test(database)) {
    usageError('数据库名只允许字母、数字、下划线和美元符号');
  }
  const timestamp = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = [
    timestamp.getFullYear(),
    pad(timestamp.getMonth() + 1),
    pad(timestamp.getDate()),
  ].join('') + `-${pad(timestamp.getHours())}${pad(timestamp.getMinutes())}${pad(timestamp.getSeconds())}`;
  const defaultOutput = path.join(os.homedir(), 'backups', `${database}-${stamp}.sql`);
  const resolvedOutput = output?.startsWith('~/')
    ? path.join(os.homedir(), output.slice(2))
    : path.resolve(output ?? defaultOutput);
  return { database, output: resolvedOutput };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function quoteIdentifier(identifier) {
  return `\`${String(identifier).replaceAll('`', '``')}\``;
}

function escapeString(value) {
  return String(value).replace(/[\0\b\t\n\r\x1a\\']/g, (character) => ({
    '\0': '\\0',
    '\b': '\\b',
    '\t': '\\t',
    '\n': '\\n',
    '\r': '\\r',
    '\x1a': '\\Z',
    '\\': '\\\\',
    "'": "\\'",
  }[character]));
}

function stringLiteral(value) {
  return `'${escapeString(value)}'`;
}

function isNumericType(type) {
  return /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real)/i.test(type);
}

function sqlLiteral(value, type) {
  if (value === null || value === undefined) return 'NULL';
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (isNumericType(type) && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(String(value))) {
    return String(value);
  }
  return stringLiteral(value);
}

async function main() {
  const { database, output } = parseArgs();
  const connection = await mariadb.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: requiredEnv('DB_USER'),
    password: process.env.DB_PASSWORD ?? '',
    database,
    bigNumberStrings: true,
    dateStrings: true,
  });
  try {
    const tables = await connection.query(
      `SELECT TABLE_NAME AS table_name
         FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_type = 'BASE TABLE'
        ORDER BY TABLE_NAME`,
    );
    const chunks = [
      `-- Backup of ${quoteIdentifier(database)} generated at ${new Date().toISOString()}\n`,
      'SET NAMES utf8mb4;\n',
      'SET FOREIGN_KEY_CHECKS=0;\n',
      `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(database)};\n`,
      `USE ${quoteIdentifier(database)};\n\n`,
    ];

    for (const tableRow of tables) {
      const tableName = String(tableRow.table_name);
      const table = quoteIdentifier(tableName);
      const createRows = await connection.query(`SHOW CREATE TABLE ${table}`);
      const createSql = createRows[0]?.['Create Table'] ?? createRows[0]?.['Create View'];
      if (typeof createSql !== 'string') throw new Error(`无法读取 ${tableName} 的 CREATE 语句`);
      chunks.push(`DROP TABLE IF EXISTS ${table};\n${createSql};\n`);

      const columns = (await connection.query(`SHOW COLUMNS FROM ${table}`))
        .filter((column) => !/generated/i.test(String(column.Extra ?? column.extra ?? '')));
      const columnNames = columns.map((column) => String(column.Field ?? column.field));
      if (columnNames.length === 0) continue;
      const rows = await connection.query(`SELECT * FROM ${table}`);
      const columnTypes = columns.map((column) => String(column.Type ?? column.type ?? ''));
      const columnList = columnNames.map(quoteIdentifier).join(', ');
      for (const row of rows) {
        const values = columnNames.map((columnName, index) => (
          sqlLiteral(row[columnName], columnTypes[index])
        ));
        chunks.push(
          `INSERT INTO ${table} (${columnList}) VALUES (${values.join(', ')});\n`,
        );
      }
      chunks.push('\n');
    }
    chunks.push('SET FOREIGN_KEY_CHECKS=1;\n');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, chunks.join(''), 'utf8');
    const information = await stat(output);
    console.log(`备份文件: ${output}`);
    console.log(`表数量: ${tables.length}`);
    console.log(`文件大小: ${information.size} bytes`);
  } finally {
    await connection.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(`备份失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
