import crypto from 'node:crypto';
import dotenv from 'dotenv';
import mariadb from 'mariadb';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const { newId } = await tsImport('../src/id.ts', import.meta.url);

function usageError(message) {
  throw new Error(`${message}\n用法: node scripts/create-admin.mjs [--database <name>] [--username <name>] [--password <password>] [--account-name <name>]`);
}

function parseArgs() {
  let database = process.env.DB_NAME_NEW ?? 'erix';
  let username = process.env.ADMIN_USERNAME;
  let password = process.env.ADMIN_PASSWORD;
  let accountName = process.env.ADMIN_ACCOUNT_NAME ?? 'erix';
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--database') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) usageError('--database 缺少值');
      database = args[i + 1];
      i += 1;
    } else if (args[i] === '--username') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) usageError('--username 缺少值');
      username = args[i + 1];
      i += 1;
    } else if (args[i] === '--password') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) usageError('--password 缺少值');
      password = args[i + 1];
      i += 1;
    } else if (args[i] === '--account-name' || args[i] === '--account') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) usageError('--account-name 缺少值');
      accountName = args[i + 1];
      i += 1;
    } else {
      usageError(`未知参数: ${args[i]}`);
    }
  }
  if (!/^[A-Za-z0-9_$]+$/.test(database)) usageError('数据库名只允许字母、数字、下划线和美元符号');
  if (database === 'task_dispatch') usageError('不支持写入旧数据库，请使用 DB_NAME_NEW 或 --database 指定新库');
  if (!username) usageError('请提供 --username 或 ADMIN_USERNAME');
  if (!password) usageError('请提供 --password 或 ADMIN_PASSWORD');
  if (!accountName) usageError('账号名称不能为空');
  if (username.length > 128 || accountName.length > 128) {
    usageError('用户名和账号名称不能超过 128 个字符');
  }
  return { database, username, password, accountName };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function nowString() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

async function main() {
  const { database, username, password, accountName } = parseArgs();
  const connection = await mariadb.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: requiredEnv('DB_USER'),
    password: process.env.DB_PASSWORD ?? '',
    database,
    dateStrings: true,
  });
  const createdAt = nowString();
  try {
    await connection.beginTransaction();
    const accountRows = await connection.query(
      `SELECT id, status, deleted_at
         FROM account
        WHERE name = ?
        ORDER BY deleted_at IS NULL DESC, created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [accountName],
    );
    let accountId;
    if (accountRows.length === 0) {
      accountId = newId('acc');
      await connection.query(
        `INSERT INTO account (id, name, created_at) VALUES (?, ?, ?)`,
        [accountId, accountName, createdAt],
      );
    } else {
      accountId = String(accountRows[0].id);
      await connection.query(
        `UPDATE account
            SET status = 'active', deleted_at = NULL
          WHERE id = ?`,
        [accountId],
      );
    }

    const principalRows = await connection.query(
      `SELECT id
         FROM principal
        WHERE account_id = ? AND kind = 'user' AND name = ?
        ORDER BY deleted_at IS NULL DESC, created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [accountId, username],
    );
    const hash = passwordHash(password);
    let principalId;
    if (principalRows.length === 0) {
      principalId = newId('prn');
      await connection.query(
        `INSERT INTO principal
           (id, account_id, kind, name, password_hash, created_at)
         VALUES (?, ?, 'user', ?, ?, ?)`,
        [principalId, accountId, username, hash, createdAt],
      );
    } else {
      principalId = String(principalRows[0].id);
      await connection.query(
        `UPDATE principal
            SET password_hash = ?, deleted_at = NULL
          WHERE id = ?`,
        [hash, principalId],
      );
    }
    await connection.commit();
    console.log(`account id: ${accountId}`);
    console.log(`principal id: ${principalId}`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(`管理员创建失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
