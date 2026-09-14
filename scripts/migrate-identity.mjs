import 'dotenv/config';
import crypto from 'node:crypto';
import mariadb from 'mariadb';

const LEGACY_DB = 'task_dispatch';
const HOST_SCOPES = [
  'post:read',
  'post:write',
  'task:read',
  'task:write',
  'task:claim',
  'task:submit',
  'task:verdict',
  'attachment:read',
  'attachment:write',
  'device:execute',
  'key:manage',
];
const SAFE_CHARS = '23456789abcdefghjkmnpqrstuvwxyz';
const BASE = SAFE_CHARS.length;
let lastMs = 0;
let lastRandom = [];

function usageError(message) {
  throw new Error(
    `${message}\n用法: node scripts/migrate-identity.mjs --from task_dispatch --to erix [--account <account_id|name>] [--force --confirm-wipe-identity] [--allow-empty]`,
  );
}

function validDatabaseName(name) {
  return /^[A-Za-z0-9_$]+$/.test(name);
}

function parseArgs() {
  let from;
  let to;
  let force = false;
  let confirmWipeIdentity = false;
  let allowEmpty = false;
  let account;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--confirm-wipe-identity') {
      confirmWipeIdentity = true;
      continue;
    }
    if (arg === '--allow-empty') {
      allowEmpty = true;
      continue;
    }
    if (arg === '--account') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) usageError('--account 缺少值');
      account = value;
      i += 1;
      continue;
    }
    if (arg === '--from' || arg === '--to') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) usageError(`${arg} 缺少值`);
      if (arg === '--from') from = value;
      else to = value;
      i += 1;
      continue;
    }
    usageError(`未知参数: ${arg}`);
  }
  from ??= LEGACY_DB;
  to ??= process.env.DB_NAME_NEW ?? 'erix';
  if (!validDatabaseName(from) || !validDatabaseName(to)) {
    usageError('数据库名只允许字母、数字、下划线和美元符号');
  }
  if (from === to) usageError('源库和目标库必须不同');
  if (confirmWipeIdentity && !force) {
    usageError('--confirm-wipe-identity 必须与 --force 一起使用');
  }
  return { from, to, force, confirmWipeIdentity, allowEmpty, account };
}

function connectionOptions(database) {
  return {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database,
    dateStrings: true,
  };
}

function nowString() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function dateString(value) {
  if (!value) return nowString();
  if (value instanceof Date) {
    const pad = (number) => String(number).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }
  return String(value).replace('T', ' ').slice(0, 19);
}

function randomDigits(length) {
  return [...crypto.randomBytes(length)].map((byte) => byte % BASE);
}

function timestampPart(milliseconds) {
  let value = milliseconds;
  let output = '';
  for (let i = 0; i < 9; i += 1) {
    output = SAFE_CHARS[value % BASE] + output;
    value = Math.floor(value / BASE);
  }
  return output;
}

function increment(digits) {
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    if (digits[i] < BASE - 1) {
      digits[i] += 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

function newId(prefix) {
  const milliseconds = Date.now();
  if (milliseconds <= lastMs && lastRandom.length === 7 && increment(lastRandom)) {
    // Keep IDs unique when several rows are migrated in one millisecond.
  } else {
    lastMs = milliseconds;
    lastRandom = randomDigits(7);
  }
  const random = lastRandom.map((digit) => SAFE_CHARS[digit]).join('');
  return `${prefix}_${timestampPart(lastMs)}${random}`;
}

async function tableColumns(connection, database, table) {
  const rows = await connection.query(
    `SELECT COLUMN_NAME AS column_name
       FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ?`,
    [database, table],
  );
  return new Set(rows.map((row) => String(row.column_name)));
}

async function assertConnectedDatabase(connection, expected, label) {
  const result = await connection.query('SELECT DATABASE() AS database_name');
  const actual = String(result[0]?.database_name ?? '');
  if (actual !== expected) {
    throw new Error(`${label}连接到 ${actual || '(空)'}，但要求 ${expected}`);
  }
}

async function assertSourceTables(connection, database) {
  for (const table of ['agents', 'admin']) {
    const columns = await tableColumns(connection, database, table);
    if (columns.size === 0) throw new Error(`源库 ${database} 缺少表 ${table}`);
  }
}

async function sourceRows(connection, database) {
  const columns = await tableColumns(connection, database, 'agents');
  const required = ['id', 'agent_id', 'name', 'key_hash'];
  for (const column of required) {
    if (!columns.has(column)) throw new Error(`老库 agents 缺少列 ${column}`);
  }
  const optional = ['hostname', 'os', 'run_user', 'agent_cli', 'status', 'last_seen_at', 'created_at'];
  const selected = [...required, ...optional.filter((column) => columns.has(column))];
  return connection.query(
    `SELECT ${selected.join(', ')} FROM agents ORDER BY id`,
  );
}

async function sourceAdminRows(connection, database) {
  const columns = await tableColumns(connection, database, 'admin');
  if (!columns.has('password_hash')) return [];
  const id = columns.has('id') ? 'id' : 'NULL AS id';
  return connection.query(`SELECT ${id}, password_hash FROM admin ORDER BY id`);
}

async function sourceCounts(connection, database) {
  const agentRows = await connection.query(
    `SELECT COUNT(*) AS count FROM \`${database}\`.agents`,
  );
  const adminRows = await connection.query(
    `SELECT COUNT(*) AS count FROM \`${database}\`.admin`,
  );
  return {
    agents: Number(agentRows[0]?.count ?? 0),
    admin: Number(adminRows[0]?.count ?? 0),
  };
}

async function targetIdentityCounts(connection) {
  const result = {};
  for (const table of ['account', 'principal', 'device', 'device_executor', 'api_key']) {
    const rows = await connection.query(`SELECT COUNT(*) AS count FROM ${table}`);
    result[table] = Number(rows[0]?.count ?? 0);
  }
  return result;
}

async function clearTarget(connection) {
  // 目标库只清身份五张表，按外键依赖顺序删除。
  const deleted = {};
  // principal.host_principal_id 是自引用 FK，必须先断开再删除 principal。
  await connection.query('UPDATE principal SET host_principal_id = NULL');
  for (const table of ['api_key', 'device_executor', 'device', 'principal', 'account']) {
    const result = await connection.query(`DELETE FROM ${table}`);
    deleted[table] = Number(result.affectedRows ?? 0);
  }
  return deleted;
}

async function findOrCreateAccount(connection, selector) {
  const existing = selector === undefined
    ? await connection.query(
      `SELECT id, name FROM account
        WHERE status = 'active' AND deleted_at IS NULL
        ORDER BY id`,
    )
    : await connection.query(
      `SELECT id, name FROM account
        WHERE status = 'active' AND deleted_at IS NULL
          AND (id = ? OR name = ?)
        ORDER BY id`,
      [selector, selector],
    );
  if (existing.length > 1) {
    throw new Error(
      selector === undefined
        ? `目标库存在多个 active account，必须显式指定 --account；候选=${existing.map((row) => `${row.id}:${row.name}`).join(',')}`
        : `--account=${selector} 匹配多个 active account，拒绝猜测`,
    );
  }
  if (existing.length > 0) {
    console.log(`[migrate] account 已存在，复用 name=${existing[0].name} id=${existing[0].id}`);
    return String(existing[0].id);
  }
  if (selector !== undefined) {
    throw new Error(`目标库找不到唯一 active account: ${selector}`);
  }
  const name = process.env.PM_ACCOUNT_NAME ?? 'default';
  const id = newId('acc');
  await connection.query(
    `INSERT INTO account (id, name, created_at) VALUES (?, ?, ?)`,
    [id, name, nowString()],
  );
  console.log(`[migrate] account 创建 name=${name} id=${id}`);
  return id;
}

async function migrateHost(connection, accountId, row) {
  const name = String(row.name ?? '');
  const existing = await connection.query(
    `SELECT id FROM principal
      WHERE account_id = ? AND name = ?
      ORDER BY id`,
    [accountId, name],
  );
  if (existing.length > 1) {
    throw new Error(`目标库 account=${accountId} 存在多个 host principal.name=${name}`);
  }
  if (existing.length > 0) {
    console.log(`[migrate] SKIP principal.name=${name}（已存在 id=${existing[0].id}）`);
    return false;
  }

  const principalId = newId('prn');
  const createdAt = dateString(row.created_at);
  const deletedAt = row.status === 'disabled' ? nowString() : null;
  await connection.query(
    `INSERT INTO principal
       (id, account_id, kind, name, password_hash, host_principal_id, created_at, deleted_at)
     VALUES (?, ?, 'host', ?, NULL, NULL, ?, ?)`,
    [principalId, accountId, name, createdAt, deletedAt],
  );
  await connection.query(
    `INSERT INTO device
       (principal_id, hostname, os, run_user, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      principalId,
      String(row.hostname ?? ''),
      String(row.os ?? ''),
      row.run_user === null || row.run_user === undefined ? null : String(row.run_user),
      row.last_seen_at ? dateString(row.last_seen_at) : null,
      createdAt,
    ],
  );

  const cli = row.agent_cli === null || row.agent_cli === undefined
    ? ''
    : String(row.agent_cli).trim();
  if (cli) {
    await connection.query(
      `INSERT INTO device_executor
         (principal_id, cli, enabled, selected, reported_at)
       VALUES (?, ?, 1, 1, ?)`,
      [principalId, cli, createdAt],
    );
  }

  const keyHash = String(row.key_hash ?? '');
  if (!keyHash) throw new Error(`agents.id=${row.id} 缺少 key_hash`);
  await connection.query(
    `INSERT INTO api_key
       (id, principal_id, key_hash, label, scopes, created_at)
     VALUES (?, ?, ?, 'migrated', ?, ?)`,
    [newId('key'), principalId, keyHash, JSON.stringify(HOST_SCOPES), createdAt],
  );
  console.log(`[migrate] host principal=${name} id=${principalId}`);
  return true;
}

async function migrateAdmin(connection, accountId, rows) {
  let created = 0;
  for (const row of rows) {
    const configuredName = process.env.PM_ADMIN_NAME ?? 'admin';
    const name = rows.length === 1 ? configuredName : `${configuredName}-${row.id}`;
    const existing = await connection.query(
      `SELECT id FROM principal
        WHERE account_id = ? AND name = ?
        ORDER BY id`,
      [accountId, name],
    );
    if (existing.length > 1) {
      throw new Error(`目标库 account=${accountId} 存在多个 user principal.name=${name}`);
    }
    if (existing.length > 0) {
      console.log(`[migrate] SKIP principal.name=${name}（已存在 id=${existing[0].id}）`);
      continue;
    }
    await connection.query(
      `INSERT INTO principal
         (id, account_id, kind, name, password_hash, host_principal_id, created_at)
       VALUES (?, ?, 'user', ?, ?, NULL, ?)`,
      [newId('prn'), accountId, name, String(row.password_hash), nowString()],
    );
    created += 1;
    console.log(`[migrate] user principal=${name}`);
  }
  return created;
}

async function main() {
  const { from, to, force, confirmWipeIdentity, allowEmpty, account } = parseArgs();
  const source = await mariadb.createConnection(connectionOptions(from));
  const target = await mariadb.createConnection(connectionOptions(to));
  let inTransaction = false;
  try {
    await assertConnectedDatabase(source, from, '源库');
    await assertSourceTables(source, from);
    const sourceBefore = await sourceCounts(source, from);
    console.log(`[migrate] 源库校验通过 source=${from} agents=${sourceBefore.agents} admin=${sourceBefore.admin}`);
    if (sourceBefore.agents === 0 && !allowEmpty) {
      throw new Error(`源库 ${from} agents 为空，拒绝迁移；如确认这是有意的空迁移，请使用 --allow-empty`);
    }
    const agents = await sourceRows(source, from);
    const admins = await sourceAdminRows(source, from);
    const targetBefore = await targetIdentityCounts(target);
    if (force && !confirmWipeIdentity) {
      throw new Error(
        `拒绝清空目标身份表 ${JSON.stringify(targetBefore)}：将删除全部账号/主体/设备/密钥，管理员与已接入主机的凭据会失效；必须同时传入 --force --confirm-wipe-identity`,
      );
    }
    if (force && confirmWipeIdentity) {
      console.log(`[migrate] 将删除目标身份行数 ${JSON.stringify(targetBefore)}`);
    }

    await target.beginTransaction();
    inTransaction = true;
    if (force && confirmWipeIdentity) {
      const deleted = await clearTarget(target);
      console.log(`[migrate] 已删除目标身份行数 ${JSON.stringify(deleted)}`);
    }

    const accountId = await findOrCreateAccount(
      target,
      account,
    );
    console.log(`[migrate] 使用目标 account=${accountId}${account ? `（--account ${account}）` : ''}`);
    let hostCount = 0;
    for (const agent of agents) {
      if (await migrateHost(target, accountId, agent)) hostCount += 1;
    }
    const userCount = await migrateAdmin(target, accountId, admins);
    const sourceAfter = await sourceCounts(source, from);
    if (
      sourceBefore.agents !== sourceAfter.agents
      || sourceBefore.admin !== sourceAfter.admin
    ) {
      throw new Error('老库行数在迁移期间发生变化，回滚目标库');
    }

    await target.commit();
    inTransaction = false;
    console.log(`[migrate] 完成 hosts=${hostCount} users=${userCount} source_readonly_rows=${sourceAfter.agents}/${sourceAfter.admin}`);
  } catch (error) {
    if (inTransaction) await target.rollback();
    throw error;
  } finally {
    await source.end();
    await target.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(`迁移失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
