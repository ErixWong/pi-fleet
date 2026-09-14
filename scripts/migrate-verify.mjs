import 'dotenv/config';
import mariadb from 'mariadb';

const LEGACY_DB = 'task_dispatch';
const CONTENT_TABLES = [
  'conversations',
  'chat_messages',
  'tasks',
  'task_messages',
  'attachments',
  'deliverables',
  'events',
];
const MIGRATION_SOURCE = 'task_dispatch.content';
const ID_RULES = [
  ['post', 'pst'],
  ['attachment', 'att'],
  ['deliverable', 'dlv'],
  ['event', 'evt'],
];
const EVENT_MIGRATION_MARKER = `"migration":"${MIGRATION_SOURCE}"`;

function usageError(message) {
  throw new Error(
    `${message}\n用法: node scripts/migrate-verify.mjs --database erix --phase identity|content [--from task_dispatch] [--allow-empty]`,
  );
}

function parseArgs() {
  let database;
  let phase;
  let from = LEGACY_DB;
  let allowEmpty = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--allow-empty') {
      allowEmpty = true;
      continue;
    }
    if (args[i] === '--database' || args[i] === '--phase' || args[i] === '--from') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) usageError(`${args[i]} 缺少值`);
      if (args[i] === '--database') database = value;
      else if (args[i] === '--phase') phase = value;
      else from = value;
      i += 1;
    } else {
      usageError(`未知参数: ${args[i]}`);
    }
  }
  database ??= process.env.DB_NAME_NEW ?? 'erix';
  if (!['identity', 'content'].includes(phase)) {
    usageError('--phase 只支持 identity 或 content');
  }
  if (!/^[A-Za-z0-9_$]+$/.test(database)) {
    usageError('数据库名只允许字母、数字、下划线和美元符号');
  }
  if (!/^[A-Za-z0-9_$]+$/.test(from)) {
    usageError('源库名只允许字母、数字、下划线和美元符号');
  }
  if (database === from) usageError('源库和验证目标必须不同');
  if (database === LEGACY_DB) usageError('验证目标不能是老库 task_dispatch');
  return { database, phase, from, allowEmpty };
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

function rows(result) {
  return Array.isArray(result) ? result : [];
}

function count(row) {
  return Number(row?.count ?? 0);
}

function setDifference(left, right) {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((value) => !rightSet.has(value));
}

async function contentCounts(connection) {
  const result = {};
  for (const table of CONTENT_TABLES) {
    const countRows = await connection.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
    result[table] = count(countRows[0]);
  }
  return result;
}

function countsEqual(left, right) {
  return CONTENT_TABLES.every((table) => left[table] === right[table]);
}

async function assertConnectedDatabase(connection, expected, label) {
  const result = await connection.query('SELECT DATABASE() AS database_name');
  const actual = String(result[0]?.database_name ?? '');
  if (actual !== expected) {
    throw new Error(`${label}连接到 ${actual || '(空)'}，但要求 ${expected}`);
  }
}

async function assertSourceTables(connection, database, phase) {
  const tables = phase === 'identity'
    ? ['agents', 'admin']
    : ['agents', ...CONTENT_TABLES];
  for (const table of tables) {
    const rows = await connection.query(
      `SELECT COUNT(*) AS count
         FROM information_schema.tables
        WHERE table_schema = ? AND table_name = ?`,
      [database, table],
    );
    if (count(rows[0]) === 0) throw new Error(`源库 ${database} 缺少表 ${table}`);
  }
}

async function sourcePreflight(connection, database, phase, allowEmpty) {
  await assertConnectedDatabase(connection, database, '源库');
  await assertSourceTables(connection, database, phase);
  if (phase === 'identity') {
    const agents = await connection.query('SELECT COUNT(*) AS count FROM agents');
    const admin = await connection.query('SELECT COUNT(*) AS count FROM admin');
    console.log(`[verify] 源库校验通过 source=${database} agents=${count(agents[0])} admin=${count(admin[0])}`);
    if (count(agents[0]) === 0 && !allowEmpty) {
      throw new Error(`源库 ${database} agents 为空，拒绝验证；如确认这是有意的空源，请使用 --allow-empty`);
    }
    return;
  }
  const counts = await contentCounts(connection);
  console.log(`[verify] 源库校验通过 source=${database} counts=${JSON.stringify(counts)}`);
  if (
    counts.conversations === 0
    && counts.chat_messages === 0
    && counts.events === 0
    && !allowEmpty
  ) {
    throw new Error(
      `源库 ${database} 的 conversations/chat_messages/events 均为空，拒绝验证；如确认这是有意的空源，请使用 --allow-empty`,
    );
  }
}

async function verifyIdentity(source, target, check) {
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
}

async function verifyContent(source, target, check) {
  const rootOrphans = await target.query(
    `SELECT COUNT(*) AS count
       FROM post
      WHERE parent_id IS NULL AND root_id <> id`,
  );
  check(
    'A 根帖 parent_id=NULL 时 root_id 必须自指',
    count(rootOrphans[0]) === 0,
    `violations=${count(rootOrphans[0])}`,
  );

  const extensionOrphans = await target.query(
    `SELECT COUNT(*) AS count
       FROM post p
      WHERE (p.kind = 'task'
             AND NOT EXISTS (SELECT 1 FROM post_task x WHERE x.post_id = p.id))
         OR (p.kind = 'channel'
             AND NOT EXISTS (SELECT 1 FROM post_channel x WHERE x.post_id = p.id))
         OR (p.kind = 'verdict'
             AND NOT EXISTS (SELECT 1 FROM post_verdict x WHERE x.post_id = p.id))`,
  );
  check(
    'B task/channel/verdict 帖子都有扩展表行',
    count(extensionOrphans[0]) === 0,
    `violations=${count(extensionOrphans[0])}`,
  );

  const rootReferences = await target.query(
    `SELECT COUNT(*) AS count
       FROM post p
      WHERE NOT EXISTS (SELECT 1 FROM post p2 WHERE p2.id = p.root_id)`,
  );
  check(
    'C 所有 post.root_id 都指向存在的根帖',
    count(rootReferences[0]) === 0,
    `violations=${count(rootReferences[0])}`,
  );

  const sourceShaRows = await source.query(`SELECT DISTINCT sha256 FROM attachments`);
  const targetShaRows = await target.query(`SELECT DISTINCT sha256 FROM attachment`);
  const sourceSha = sourceShaRows.map((row) => String(row.sha256));
  const targetSha = targetShaRows.map((row) => String(row.sha256));
  const missingSha = setDifference(sourceSha, targetSha);
  const extraSha = setDifference(targetSha, sourceSha);
  check(
    'D attachment.sha256 集合双向相等',
    missingSha.length === 0 && extraSha.length === 0,
    `missing=${missingSha.length}, extra=${extraSha.length}`,
  );

  const currentDuplicates = await target.query(
    `SELECT post_id, name
       FROM deliverable
      WHERE current = 1
      GROUP BY post_id, name
     HAVING COUNT(*) > 1`,
  );
  check(
    'E 每个 (post_id,name) 至多一个 current deliverable',
    currentDuplicates.length === 0,
    `violations=${currentDuplicates.length}`,
  );

  let invalidIds = 0;
  const invalidDetails = [];
  for (const [table, prefix] of ID_RULES) {
    const idRows = await target.query(`SELECT id FROM \`${table}\``);
    const pattern = new RegExp(`^${prefix}_[23456789abcdefghjkmnpqrstuvwxyz]+$`);
    const invalid = idRows.filter((row) => {
      const id = String(row.id);
      return id.length > 32 || !pattern.test(id);
    });
    invalidIds += invalid.length;
    if (invalid.length > 0) invalidDetails.push(`${table}=${invalid.length}`);
  }
  check(
    'F 内容域 ID 长度和前缀格式正确',
    invalidIds === 0,
    invalidDetails.length === 0 ? 'invalid=0' : invalidDetails.join(', '),
  );

  const baselineRows = await target.query(
    `SELECT id, payload
       FROM event
      WHERE action = 'migration.baseline'`,
  );
  const baseline = baselineRows
    .map((row) => {
      try {
        return { id: row.id, payload: JSON.parse(String(row.payload)) };
      } catch {
        return null;
      }
    })
    .find((row) => row?.payload?.source === MIGRATION_SOURCE);
  const before = await contentCounts(source);
  const after = await contentCounts(source);
  check(
    'G 老库实时快照在验证前后不变（仅执行 SELECT 证明源库未写入）',
    countsEqual(before, after),
    `realtime_snapshot_before=${JSON.stringify(before)}, realtime_snapshot_after=${JSON.stringify(after)}, baseline=${JSON.stringify(baseline?.payload?.counts ?? null)}`,
  );

  const migratedEvents = await target.query(
    `SELECT COUNT(*) AS count
       FROM event
      WHERE action <> 'migration.baseline'
        AND payload LIKE ?`,
    [`%${EVENT_MIGRATION_MARKER}%`],
  );
  const baselineEventCount = Number(baseline?.payload?.counts?.events);
  check(
    'H event 迁移行数 = 迁移基线 events 条数',
    baseline !== undefined
      && Number.isInteger(baselineEventCount)
      && count(migratedEvents[0]) === baselineEventCount,
    `marker=payload.migration:"task_dispatch.content", target=${count(migratedEvents[0])}, baseline=${baselineEventCount}, baseline_event_id=${baseline?.id ?? 'missing'}`,
  );
}

async function main() {
  const { database, phase, from, allowEmpty } = parseArgs();
  const source = await mariadb.createConnection(connectionOptions(from));
  const target = await mariadb.createConnection(connectionOptions(database));
  const failures = [];
  const pass = (label, detail) => console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
  const check = (label, condition, detail) => {
    if (condition) pass(label, detail);
    else {
      failures.push(label);
      console.log(`FAIL ${label} — ${detail}`);
    }
  };

  try {
    await sourcePreflight(source, from, phase, allowEmpty);
    if (phase === 'identity') await verifyIdentity(source, target, check);
    else await verifyContent(source, target, check);
  } finally {
    await source.end();
    await target.end();
  }

  if (failures.length > 0) {
    throw new Error(`验证失败 ${failures.length} 项`);
  }
  console.log(`验证通过: ${phase} ${phase === 'content' ? 'A-H 八条' : '四条'}断言均通过`);
}

try {
  await main();
} catch (error) {
  console.error(`验证失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
