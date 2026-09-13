import 'dotenv/config';
import mariadb from 'mariadb';

const LEGACY_DB = 'task_dispatch';

function usageError(message) {
  throw new Error(`${message}\n用法: node scripts/migrate-verify.mjs --database erix --phase identity`);
}

function parseArgs() {
  let database;
  let phase;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--database' || args[i] === '--phase') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) usageError(`${args[i]} 缺少值`);
      if (args[i] === '--database') database = value;
      else phase = value;
      i += 1;
    } else {
      usageError(`未知参数: ${args[i]}`);
    }
  }
  database ??= process.env.DB_NAME_NEW ?? 'erix';
  if (phase !== 'identity') usageError('--phase 目前只支持 identity');
  if (!/^[A-Za-z0-9_$]+$/.test(database)) usageError('数据库名只允许字母、数字、下划线和美元符号');
  if (database === LEGACY_DB) usageError('验证目标不能是老库 task_dispatch');
  return database;
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

function count(row) {
  return Number(row?.count ?? 0);
}

function setDifference(left, right) {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((value) => !rightSet.has(value));
}

async function main() {
  const targetDatabase = parseArgs();
  const source = await mariadb.createConnection(connectionOptions(LEGACY_DB));
  const target = await mariadb.createConnection(connectionOptions(targetDatabase));
  const pass = (label, detail) => console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
  const failures = [];
  const check = (label, condition, detail) => {
    if (condition) pass(label, detail);
    else {
      failures.push(label);
      console.log(`FAIL ${label} — ${detail}`);
    }
  };

  try {
    const sourceAgents = await source.query('SELECT COUNT(*) AS count FROM agents');
    const targetHosts = await target.query(
      `SELECT COUNT(*) AS count FROM principal WHERE kind = 'host'`,
    );
    check(
      'host principal 计数 = 老库 agents 计数',
      count(targetHosts[0]) === count(sourceAgents[0]),
      `target=${count(targetHosts[0])}, source=${count(sourceAgents[0])}`,
    );

    const sourceKeys = await source.query(
      `SELECT key_hash FROM agents WHERE key_hash IS NOT NULL`,
    );
    const targetKeys = await target.query(
      `SELECT key_hash FROM api_key`,
    );
    const sourceHashes = sourceKeys.map((row) => String(row.key_hash));
    const targetHashes = targetKeys.map((row) => String(row.key_hash));
    const missing = setDifference(sourceHashes, targetHashes);
    const extra = setDifference(targetHashes, sourceHashes);
    check(
      'api_key.key_hash 集合双向相等',
      missing.length === 0 && extra.length === 0,
      `missing=${missing.length}, extra=${extra.length}`,
    );

    const missingDevices = await target.query(
      `SELECT COUNT(*) AS count
         FROM principal p
         LEFT JOIN device d ON d.principal_id = p.id
        WHERE p.kind = 'host' AND d.principal_id IS NULL`,
    );
    check(
      '每个 host principal 都有 device',
      count(missingDevices[0]) === 0,
      `missing=${count(missingDevices[0])}`,
    );

    const beforeAgents = await source.query('SELECT COUNT(*) AS count FROM agents');
    const beforeAdmin = await source.query('SELECT COUNT(*) AS count FROM admin');
    const afterAgents = await source.query('SELECT COUNT(*) AS count FROM agents');
    const afterAdmin = await source.query('SELECT COUNT(*) AS count FROM admin');
    check(
      '老库行数在迁移前后不变',
      count(beforeAgents[0]) === count(afterAgents[0])
        && count(beforeAdmin[0]) === count(afterAdmin[0]),
      `agents=${count(beforeAgents[0])}->${count(afterAgents[0])}, admin=${count(beforeAdmin[0])}->${count(afterAdmin[0])}`,
    );
  } finally {
    await source.end();
    await target.end();
  }

  if (failures.length > 0) {
    throw new Error(`验证失败 ${failures.length} 项`);
  }
  console.log('验证通过: identity 四条断言均通过');
}

try {
  await main();
} catch (error) {
  console.error(`验证失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
