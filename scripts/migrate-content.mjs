import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { cp, mkdir, rm } from 'node:fs/promises';
import mariadb from 'mariadb';

const SAFE_CHARS = '23456789abcdefghjkmnpqrstuvwxyz';
const BASE = SAFE_CHARS.length;
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
const CLEAR_TABLES = [
  'deliverable',
  'post_verdict',
  'post_target',
  'post_task',
  'post_channel',
  'attachment',
  'event',
];
const TARGET_CONTENT_TABLES = [
  'post',
  'post_task',
  'post_channel',
  'post_verdict',
  'post_target',
  'attachment',
  'deliverable',
  'event',
  'post_summary',
  'tag',
  'post_tag',
];

let lastMs = 0;
let lastRandom = [];

function usageError(message) {
  throw new Error(
    `${message}\n用法: node scripts/migrate-content.mjs --from task_dispatch --to erix [--force --confirm-wipe-content] [--allow-empty]`,
  );
}

function validDatabaseName(name) {
  return /^[A-Za-z0-9_$]+$/.test(name);
}

function parseArgs() {
  let from;
  let to;
  let force = false;
  let confirmWipeContent = false;
  let allowEmpty = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--confirm-wipe-content') {
      confirmWipeContent = true;
      continue;
    }
    if (arg === '--allow-empty') {
      allowEmpty = true;
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
  if (confirmWipeContent && !force) {
    usageError('--confirm-wipe-content 必须与 --force 一起使用');
  }
  return { from, to, force, confirmWipeContent, allowEmpty };
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
    // Keep IDs unique when many rows are migrated in one millisecond.
  } else {
    lastMs = milliseconds;
    lastRandom = randomDigits(7);
  }
  const random = lastRandom.map((digit) => SAFE_CHARS[digit]).join('');
  return `${prefix}_${timestampPart(lastMs)}${random}`;
}

function rows(result) {
  return Array.isArray(result) ? result : [];
}

function stringValue(value) {
  return value === null || value === undefined ? '' : String(value);
}

function nullableString(value) {
  return value === null || value === undefined ? null : String(value);
}

function numberValue(value) {
  return Number(value ?? 0);
}

function dateString(value) {
  if (!value) return nowString();
  if (value instanceof Date) {
    const pad = (number) => String(number).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }
  return String(value).replace('T', ' ').slice(0, 19);
}

function nowString() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function idKey(value) {
  return value === null || value === undefined ? null : String(value);
}

function safeExtension(filename, relativePath) {
  const source = String(filename || relativePath || '');
  const basename = path.posix.basename(source);
  const match = /\.([A-Za-z0-9]{1,20})$/.exec(basename);
  return match ? match[1].toLowerCase() : '';
}

function dateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateString(value));
  if (!match) throw new Error(`无法从日期生成附件目录: ${String(value)}`);
  return match.slice(1);
}

function expandHome(value) {
  const text = String(value ?? '');
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

function resolveInside(root, relative) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const relativeToRoot = path.relative(resolvedRoot, resolved);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error(`附件路径越过根目录: ${relative}`);
  }
  return resolved;
}

function mapTaskStatus(status) {
  const mapping = {
    pending: 'pending_audit',
    pending_audit: 'pending_audit',
    rejected: 'rejected',
    active: 'open',
    open: 'open',
    claimed: 'claimed',
    running: 'claimed',
    submitted: 'submitted',
    pending_confirm: 'pending_confirm',
    done: 'done',
    resolved: 'done',
    failed: 'failed',
    cancelled: 'cancelled',
    blocked: 'claimed',
  };
  const mapped = mapping[String(status)];
  if (!mapped) throw new Error(`未知老任务状态: ${String(status)}`);
  return mapped;
}

function mapVisibility(value) {
  const visibility = value === null || value === undefined || value === '' ? 'private' : String(value);
  if (!['private', 'public'].includes(visibility)) {
    throw new Error(`未知老任务 visibility: ${visibility}`);
  }
  return visibility;
}

function mapChannelStatus(value) {
  const status = String(value ?? 'open');
  if (!['open', 'archived'].includes(status)) {
    throw new Error(`未知老会话 status: ${status}`);
  }
  return status;
}

function migrationTaskTitle(title, taskId) {
  return `${stringValue(title)} [${String(taskId)}]`;
}

function assertSourceColumns(columns, table, required) {
  for (const column of required) {
    if (!columns.has(column)) throw new Error(`老库 ${table} 缺少列 ${column}`);
  }
}

async function tableColumns(connection, database, table) {
  const result = await connection.query(
    `SELECT COLUMN_NAME AS column_name
       FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ?`,
    [database, table],
  );
  return new Set(rows(result).map((row) => String(row.column_name)));
}

async function assertConnectedDatabase(connection, expected, label) {
  const result = await connection.query('SELECT DATABASE() AS database_name');
  const actual = String(result[0]?.database_name ?? '');
  if (actual !== expected) {
    throw new Error(`${label}连接到 ${actual || '(空)'}，但要求 ${expected}`);
  }
}

async function assertSourceTables(connection, database) {
  for (const table of ['agents', ...CONTENT_TABLES]) {
    const columns = await tableColumns(connection, database, table);
    if (columns.size === 0) throw new Error(`老库缺少表 ${table}`);
  }
}

async function sourceCounts(connection) {
  const result = {};
  for (const table of CONTENT_TABLES) {
    const countRows = await connection.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
    result[table] = numberValue(countRows[0]?.count);
  }
  return result;
}

async function targetContentCounts(connection) {
  const result = {};
  for (const table of TARGET_CONTENT_TABLES) {
    const countRows = await connection.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
    result[table] = numberValue(countRows[0]?.count);
  }
  return result;
}

async function migrationBaseline(connection) {
  const baselineRows = await connection.query(
    `SELECT id, payload
       FROM event
      WHERE action = 'migration.baseline'`,
  );
  return baselineRows
    .map((row) => {
      try {
        const payload = JSON.parse(String(row.payload));
        return payload.source === MIGRATION_SOURCE ? { id: String(row.id), payload } : null;
      } catch {
        return null;
      }
    })
    .find((row) => row !== null) ?? null;
}

async function validateForceTarget(connection, force, confirmWipeContent) {
  const counts = await targetContentCounts(connection);
  if (counts.post_summary > 0 || counts.tag > 0 || counts.post_tag > 0) {
    throw new Error(
      `拒绝 --force：post_summary/tag/post_tag 非空，当前不属于可安全清理的迁移内容域 counts=${JSON.stringify({
        post_summary: counts.post_summary,
        tag: counts.tag,
        post_tag: counts.post_tag,
      })}`,
    );
  }
  if (!force) return counts;
  if (!confirmWipeContent) {
    throw new Error(
      `拒绝清空目标内容表 ${JSON.stringify(counts)}：将删除全部内容帖子、附件、交付物与事件；必须同时传入 --force --confirm-wipe-content`,
    );
  }
  const targetHasRows = Object.entries(counts)
    .filter(([table]) => !['post_summary', 'tag', 'post_tag'].includes(table))
    .some(([, count]) => count > 0);
  if (!targetHasRows) return counts;
  const baseline = await migrationBaseline(connection);
  const expected = baseline?.payload?.target_counts;
  if (!expected || typeof expected !== 'object') {
    throw new Error(
      '拒绝清空目标内容表：migration.baseline 缺少 target_counts，无法证明目标只含迁移数据',
    );
  }
  const differences = {};
  for (const table of TARGET_CONTENT_TABLES) {
    const expectedCount = Number(expected[table] ?? 0);
    if (counts[table] > expectedCount) {
      differences[table] = { current: counts[table], baseline: expectedCount };
    }
  }
  if (Object.keys(differences).length > 0) {
    throw new Error(
      `拒绝清空目标内容表：当前行数超出 migration.baseline，存在非迁移数据 differences=${JSON.stringify(differences)}`,
    );
  }
  console.log(`[migrate] 将删除目标内容行数 ${JSON.stringify(counts)}`);
  return counts;
}

function sameCounts(before, after) {
  return CONTENT_TABLES.every((table) => before[table] === after[table]);
}

async function sourceRowsFor(connection, database, table, required, sql) {
  const columns = await tableColumns(connection, database, table);
  assertSourceColumns(columns, table, required);
  return rows(await connection.query(sql));
}

async function loadSource(connection, database) {
  const conversations = await sourceRowsFor(
    connection,
    database,
    'conversations',
    ['id', 'conversation_id', 'agent_id', 'task_id', 'name', 'workdir', 'run_user', 'status', 'created_at'],
    `SELECT id, conversation_id, agent_id, task_id, name, workdir, run_user, status, created_at
       FROM conversations ORDER BY id`,
  );
  const chatMessages = await sourceRowsFor(
    connection,
    database,
    'chat_messages',
    ['id', 'conversation_id', 'sender_role', 'content', 'streaming', 'created_at'],
    `SELECT id, conversation_id, sender_role, content, streaming, created_at
       FROM chat_messages ORDER BY id`,
  );
  const tasks = await sourceRowsFor(
    connection,
    database,
    'tasks',
    [
      'id', 'task_id', 'title', 'instruction', 'visibility', 'creator_id', 'assignee_id',
      'status', 'deliver_attempts', 'max_attempts', 'workdir', 'deliverable_spec',
      'result', 'result_status', 'result_at', 'claimed_at', 'created_at',
    ],
    `SELECT id, task_id, title, instruction, visibility, creator_id, assignee_id,
            status, deliver_attempts, max_attempts, workdir, deliverable_spec,
            result, result_status, result_at, claimed_at, created_at
       FROM tasks ORDER BY id`,
  );
  const taskMessages = await sourceRowsFor(
    connection,
    database,
    'task_messages',
    ['id', 'task_id', 'sender_id', 'sender_role', 'type', 'content', 'created_at'],
    `SELECT id, task_id, sender_id, sender_role, type, content, created_at
       FROM task_messages ORDER BY id`,
  );
  const attachments = await sourceRowsFor(
    connection,
    database,
    'attachments',
    [
      'id', 'attachment_id', 'owner_agent_id', 'filename', 'mime', 'size_bytes',
      'sha256', 'scan_status', 'relative_path', 'created_at',
    ],
    `SELECT id, attachment_id, owner_agent_id, filename, mime, size_bytes,
            sha256, scan_status, relative_path, created_at
       FROM attachments ORDER BY id`,
  );
  const deliverables = await sourceRowsFor(
    connection,
    database,
    'deliverables',
    ['id', 'task_id', 'name', 'path', 'version', 'message', 'current', 'agent_id', 'attachment_id', 'created_at'],
    `SELECT id, task_id, name, path, version, message, current, agent_id, attachment_id, created_at
       FROM deliverables ORDER BY id`,
  );
  const events = await sourceRowsFor(
    connection,
    database,
    'events',
    ['id', 'type', 'actor', 'ref_task', 'ref_plan', 'summary', 'created_at'],
    `SELECT id, type, actor, ref_task, ref_plan, summary, created_at
       FROM events ORDER BY id`,
  );
  return {
    conversations,
    chatMessages,
    tasks,
    taskMessages,
    attachments,
    deliverables,
    events,
  };
}

async function legacyAttachmentRoot(connection, database) {
  const fallback = path.resolve('attachments');
  const columns = await tableColumns(connection, database, 'settings');
  if (!columns.has('k') || !columns.has('v')) return fallback;
  const result = await connection.query(
    `SELECT v FROM settings WHERE k = 'attachments_root' LIMIT 1`,
  );
  return path.resolve(expandHome(result[0]?.v || fallback));
}

async function targetAttachmentRoot(connection, database) {
  const fallback = path.resolve('attachments');
  const columns = await tableColumns(connection, database, 'setting');
  if (!columns.has('setting_key') || !columns.has('value')) return fallback;
  const result = await connection.query(
    `SELECT value FROM setting WHERE setting_key = 'attachments_root' LIMIT 1`,
  );
  return path.resolve(expandHome(result[0]?.value || fallback));
}

async function findAccount(connection) {
  const result = await connection.query(
    `SELECT id FROM account WHERE deleted_at IS NULL ORDER BY id LIMIT 1`,
  );
  if (result.length === 0) throw new Error('目标库缺少可用 account（请先运行身份迁移）');
  return String(result[0].id);
}

async function loadTargetIdentity(connection, sourceAgents) {
  const keyRows = await connection.query(
    `SELECT a.key_hash, p.id
       FROM api_key a
       JOIN principal p ON p.id = a.principal_id
      WHERE p.kind = 'host'`,
  );
  const hostByKey = new Map(keyRows.map((row) => [String(row.key_hash), String(row.id)]));
  const hostRows = await connection.query(
    `SELECT id, name FROM principal WHERE kind = 'host' ORDER BY id`,
  );
  const hostByName = new Map();
  for (const row of hostRows) {
    const name = String(row.name);
    if (hostByName.has(name)) throw new Error(`目标库 host principal.name 重复，无法幂等映射: ${name}`);
    hostByName.set(name, String(row.id));
  }
  const agentToPrincipal = new Map();
  for (const agent of sourceAgents) {
    const byKey = hostByKey.get(String(agent.key_hash));
    const byName = hostByName.get(String(agent.name));
    const principalId = byKey ?? byName;
    if (!principalId) {
      throw new Error(`无法映射老 agents.id=${String(agent.id)} agent_id=${String(agent.agent_id)}`);
    }
    agentToPrincipal.set(String(agent.id), principalId);
  }

  const configuredAdmin = process.env.PM_ADMIN_NAME ?? 'admin';
  const adminRows = await connection.query(
    `SELECT id FROM principal WHERE kind = 'user' AND name = ? ORDER BY id LIMIT 1`,
    [configuredAdmin],
  );
  const fallbackAdminRows = adminRows.length > 0
    ? adminRows
    : await connection.query(`SELECT id FROM principal WHERE kind = 'user' ORDER BY id LIMIT 1`);
  if (fallbackAdminRows.length === 0) throw new Error('目标库缺少 user principal（请先运行身份迁移）');

  return {
    agentToPrincipal,
    adminPrincipalId: String(fallbackAdminRows[0].id),
  };
}

async function ensurePlatformPrincipal(connection, accountId) {
  const existing = await connection.query(
    `SELECT id FROM principal WHERE kind = 'service' AND name = 'platform' ORDER BY id LIMIT 1`,
  );
  if (existing.length > 0) return String(existing[0].id);
  const id = newId('prn');
  await connection.query(
    `INSERT INTO principal
       (id, account_id, kind, name, password_hash, host_principal_id, created_at)
     VALUES (?, ?, 'service', 'platform', NULL, NULL, ?)`,
    [id, accountId, nowString()],
  );
  console.log(`[migrate] service principal platform=${id}`);
  return id;
}

async function clearContent(connection) {
  const deleted = {};
  for (const table of CLEAR_TABLES) {
    const result = await connection.query(`DELETE FROM ${table}`);
    deleted[table] = Number(result.affectedRows ?? 0);
  }
  // post.parent_id has a self-reference; remove children before roots.
  const children = await connection.query(`DELETE FROM post WHERE parent_id IS NOT NULL`);
  const roots = await connection.query(`DELETE FROM post`);
  deleted.post = Number(children.affectedRows ?? 0) + Number(roots.affectedRows ?? 0);
  console.log(`[migrate] 已删除目标内容行数 ${JSON.stringify(deleted)}（身份表未触碰）`);
  return deleted;
}

async function findOneBySubtype(connection, kind, subtype) {
  const result = await connection.query(
    `SELECT id FROM post WHERE kind = ? AND subtype = ? ORDER BY id`,
    [kind, subtype],
  );
  if (result.length > 1) throw new Error(`目标库存在重复迁移标记 kind=${kind} subtype=${subtype}`);
  return result.length === 0 ? null : String(result[0].id);
}

async function migrateConversations(connection, sourceRowsValue, identity, accountId) {
  const channelByConversation = new Map();
  let created = 0;
  for (const row of sourceRowsValue) {
    const hostPrincipalId = identity.agentToPrincipal.get(String(row.agent_id));
    if (!hostPrincipalId) {
      throw new Error(`会话 ${String(row.conversation_id)} 的 agent_id 无法映射`);
    }
    const channelStatus = mapChannelStatus(row.status);
    const subtype = `cv:${String(row.id)}`;
    let postId = await findOneBySubtype(connection, 'channel', subtype);
    if (!postId) {
      postId = newId('pst');
      await connection.query(
        `INSERT INTO post
           (id, account_id, kind, subtype, author_principal_id, title, body,
            visibility, parent_id, root_id, created_at)
         VALUES (?, ?, 'channel', ?, ?, ?, '', 'private', NULL, ?, ?)`,
        [
          postId,
          accountId,
          subtype,
          hostPrincipalId,
          stringValue(row.name),
          postId,
          dateString(row.created_at),
        ],
      );
      await connection.query(
        `INSERT INTO post_channel
           (post_id, host_principal_id, workdir, run_user, name, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          postId,
          hostPrincipalId,
          nullableString(row.workdir),
          nullableString(row.run_user),
          stringValue(row.name),
          channelStatus,
        ],
      );
      created += 1;
    } else {
      const extension = await connection.query(
        `SELECT post_id FROM post_channel WHERE post_id = ? LIMIT 1`,
        [postId],
      );
      if (extension.length === 0) throw new Error(`迁移会话根帖缺少 post_channel: ${postId}`);
    }
    channelByConversation.set(String(row.conversation_id), {
      postId,
      hostPrincipalId,
    });
  }
  return { channelByConversation, created };
}

function messageAuthor(row, hostPrincipalId, identity, platformPrincipalId) {
  const role = String(row.sender_role);
  if (role === 'admin') return identity.adminPrincipalId;
  if (role === 'agent') return hostPrincipalId;
  if (role === 'platform' || role === 'system') return platformPrincipalId;
  throw new Error(`未知 chat_messages.sender_role: ${role}`);
}

async function migrateChatMessages(connection, sourceRowsValue, channels, identity, platformPrincipalId, accountId) {
  let created = 0;
  for (const row of sourceRowsValue) {
    const channel = channels.get(String(row.conversation_id));
    if (!channel) throw new Error(`chat_messages.id=${String(row.id)} 找不到会话`);
    const authorPrincipalId = messageAuthor(
      row,
      channel.hostPrincipalId,
      identity,
      platformPrincipalId,
    );
    const subtype = `cm:${String(row.id)}`;
    const existing = await connection.query(
      `SELECT id FROM post
        WHERE kind = 'message' AND root_id = ? AND subtype = ? LIMIT 1`,
      [channel.postId, subtype],
    );
    if (existing.length > 0) continue;
    const postId = newId('pst');
    await connection.query(
      `INSERT INTO post
         (id, account_id, kind, subtype, author_principal_id, title, body,
          visibility, parent_id, root_id, streaming, created_at)
       VALUES (?, ?, 'message', ?, ?, '', ?, 'private', ?, ?, ?, ?)`,
      [
        postId,
        accountId,
        subtype,
        authorPrincipalId,
        stringValue(row.content),
        channel.postId,
        channel.postId,
        numberValue(row.streaming) === 1 ? 1 : 0,
        dateString(row.created_at),
      ],
    );
    created += 1;
  }
  return created;
}

function taskAuthor(row, identity, platformPrincipalId) {
  if (row.creator_id === null || row.creator_id === undefined) return platformPrincipalId;
  const principalId = identity.agentToPrincipal.get(String(row.creator_id));
  if (!principalId) throw new Error(`tasks.id=${String(row.id)} 的 creator_id 无法映射`);
  return principalId;
}

function taskAssignee(row, identity) {
  if (row.assignee_id === null || row.assignee_id === undefined) return null;
  const principalId = identity.agentToPrincipal.get(String(row.assignee_id));
  if (!principalId) throw new Error(`tasks.id=${String(row.id)} 的 assignee_id 无法映射`);
  return principalId;
}

async function migrateTasks(connection, sourceRowsValue, identity, platformPrincipalId, accountId) {
  const taskByLegacyId = new Map();
  let created = 0;
  for (const row of sourceRowsValue) {
    const sourceStatus = String(row.status);
    let status = mapTaskStatus(sourceStatus);
    const visibility = mapVisibility(row.visibility);
    const specIsEmpty = row.deliverable_spec === null
      || row.deliverable_spec === undefined
      || String(row.deliverable_spec).trim() === '';
    const body = stringValue(row.instruction)
      + (specIsEmpty && !stringValue(row.instruction).includes('[迁移：原任务无验收方案]')
        ? '\n\n[迁移：原任务无验收方案]'
        : '');
    if (specIsEmpty) status = 'rejected';
    const spec = specIsEmpty ? '{"items":[]}' : String(row.deliverable_spec);
    const taskId = String(row.task_id);
    const title = migrationTaskTitle(row.title, taskId);
    const existing = await connection.query(
      `SELECT id, kind FROM post
        WHERE kind = 'task' AND subtype = 'legacy-task' AND title = ?
        ORDER BY id`,
      [title],
    );
    if (existing.length > 1) throw new Error(`目标库存在重复迁移任务: ${taskId}`);

    let postId;
    const assigneePrincipalId = taskAssignee(row, identity);
    if (existing.length === 0) {
      postId = newId('pst');
      await connection.query(
        `INSERT INTO post
           (id, account_id, kind, subtype, author_principal_id, title, body,
            visibility, parent_id, root_id, created_at)
         VALUES (?, ?, 'task', 'legacy-task', ?, ?, ?, ?, NULL, ?, ?)`,
        [
          postId,
          accountId,
          taskAuthor(row, identity, platformPrincipalId),
          title,
          body,
          visibility,
          postId,
          dateString(row.created_at),
        ],
      );
      await connection.query(
        `INSERT INTO post_task
           (post_id, status, assignee_principal_id, is_ready, workdir, executor,
            deliverable_spec, attempts, max_attempts, claimed_at, submitted_at, closed_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        [
          postId,
          status,
          assigneePrincipalId,
          sourceStatus === 'blocked' && !specIsEmpty ? 0 : 1,
          nullableString(row.workdir),
          spec,
          numberValue(row.deliver_attempts),
          numberValue(row.max_attempts) || 3,
          nullableString(row.claimed_at),
          ['submitted', 'pending_confirm', 'done'].includes(status)
            ? nullableString(row.result_at)
            : null,
          nullableString(row.result_at),
        ],
      );
      if (assigneePrincipalId) {
        await connection.query(
          `INSERT INTO post_target (post_id, principal_id, role, read_at, created_at)
           VALUES (?, ?, 'assignee', NULL, ?)`,
          [postId, assigneePrincipalId, dateString(row.created_at)],
        );
      }
      created += 1;
    } else {
      postId = String(existing[0].id);
      const extension = await connection.query(
        `SELECT post_id FROM post_task WHERE post_id = ? LIMIT 1`,
        [postId],
      );
      if (extension.length === 0) throw new Error(`迁移任务根帖缺少 post_task: ${postId}`);
      if (assigneePrincipalId) {
        const target = await connection.query(
          `SELECT post_id FROM post_target
            WHERE post_id = ? AND principal_id = ? AND role = 'assignee' LIMIT 1`,
          [postId, assigneePrincipalId],
        );
        if (target.length === 0) {
          await connection.query(
            `INSERT INTO post_target (post_id, principal_id, role, read_at, created_at)
             VALUES (?, ?, 'assignee', NULL, ?)`,
            [postId, assigneePrincipalId, dateString(row.created_at)],
          );
        }
      }
    }
    taskByLegacyId.set(String(row.id), {
      postId,
      visibility,
      authorPrincipalId: taskAuthor(row, identity, platformPrincipalId),
      sourceRow: row,
    });
  }
  return { taskByLegacyId, created };
}

async function migrateTaskMessages(
  connection,
  sourceRowsValue,
  tasks,
  identity,
  platformPrincipalId,
  accountId,
) {
  let created = 0;
  let skippedVerdicts = 0;
  for (const row of sourceRowsValue) {
    const type = String(row.type);
    if (type === 'verdict') {
      skippedVerdicts += 1;
      continue;
    }
    if (!['chat', 'progress', 'report', 'system'].includes(type)) {
      throw new Error(`未知 task_messages.type: ${type}`);
    }
    const task = tasks.get(String(row.task_id));
    if (!task) throw new Error(`task_messages.id=${String(row.id)} 找不到任务`);
    const role = String(row.sender_role);
    let authorPrincipalId;
    if (role === 'admin') authorPrincipalId = identity.adminPrincipalId;
    else if (role === 'platform' || role === 'system') authorPrincipalId = platformPrincipalId;
    else if (role === 'agent') {
      if (row.sender_id === null || row.sender_id === undefined) {
        throw new Error(`task_messages.id=${String(row.id)} 的 agent sender_id 为空`);
      }
      authorPrincipalId = identity.agentToPrincipal.get(String(row.sender_id));
      if (!authorPrincipalId) {
        throw new Error(`task_messages.id=${String(row.id)} 的 sender_id 无法映射`);
      }
    } else {
      throw new Error(`未知 task_messages.sender_role: ${role}`);
    }
    const subtype = `tm:${type}:${String(row.id)}`;
    const existing = await connection.query(
      `SELECT id FROM post
        WHERE kind = 'message' AND root_id = ? AND subtype = ? LIMIT 1`,
      [task.postId, subtype],
    );
    if (existing.length > 0) continue;
    await connection.query(
      `INSERT INTO post
         (id, account_id, kind, subtype, author_principal_id, title, body,
          visibility, parent_id, root_id, created_at)
       VALUES (?, ?, 'message', ?, ?, '', ?, ?, ?, ?, ?)`,
      [
        newId('pst'),
        accountId,
        subtype,
        authorPrincipalId,
        stringValue(row.content),
        task.visibility,
        task.postId,
        task.postId,
        dateString(row.created_at),
      ],
    );
    created += 1;
  }
  return { created, skippedVerdicts };
}

async function migrateTaskVerdicts(connection, sourceRowsValue, tasks, accountId) {
  let created = 0;
  for (const row of sourceRowsValue) {
    if (String(row.result_status) !== 'success') continue;
    if (!['pending_confirm', 'done', 'resolved'].includes(String(row.status))) continue;
    const task = tasks.get(String(row.id));
    if (!task) throw new Error(`tasks.id=${String(row.id)} 找不到迁移后的根帖`);
    const subtype = `tv:${String(row.id)}`;
    if (await findOneBySubtype(connection, 'verdict', subtype)) continue;
    const verdictId = newId('pst');
    const opinion = stringValue(row.result);
    const occurredAt = nullableString(row.result_at) ?? dateString(row.created_at);
    await connection.query(
      `INSERT INTO post
         (id, account_id, kind, subtype, author_principal_id, title, body,
          visibility, parent_id, root_id, created_at)
       VALUES (?, ?, 'verdict', ?, ?, 'accept', ?, ?, ?, ?, ?)`,
      [
        verdictId,
        accountId,
        subtype,
        task.authorPrincipalId,
        opinion,
        task.visibility,
        task.postId,
        task.postId,
        occurredAt,
      ],
    );
    await connection.query(
      `INSERT INTO post_verdict
         (post_id, decision, opinion, target_task_id, attempt_no, source)
       VALUES (?, 'accept', ?, ?, ?, 'human')`,
      [verdictId, opinion, task.postId, numberValue(row.deliver_attempts)],
    );
    created += 1;
  }
  return created;
}

async function migrateAttachments(
  connection,
  sourceRowsValue,
  identity,
  accountId,
  sourceRoot,
  targetRoot,
  copiedFiles,
) {
  const attachmentByLegacyId = new Map();
  let created = 0;
  for (const row of sourceRowsValue) {
    const legacyId = String(row.attachment_id);
    const ownerPrincipalId = identity.agentToPrincipal.get(String(row.owner_agent_id));
    if (!ownerPrincipalId) throw new Error(`attachments.attachment_id=${legacyId} 的 owner_agent_id 无法映射`);
    const scanStatus = String(row.scan_status || 'pending');
    if (!['pending', 'clean', 'infected', 'skipped', 'error'].includes(scanStatus)) {
      throw new Error(`未知 attachments.scan_status: ${scanStatus}`);
    }
    const existing = await connection.query(
      `SELECT id FROM attachment
        WHERE owner_principal_id = ? AND sha256 = ? LIMIT 1`,
      [ownerPrincipalId, String(row.sha256)],
    );
    if (existing.length > 0) {
      attachmentByLegacyId.set(legacyId, String(existing[0].id));
      continue;
    }
    const id = newId('att');
    const [year, month, day] = dateParts(row.created_at);
    const extension = safeExtension(row.filename, row.relative_path);
    const relativePath = path.posix.join(
      ownerPrincipalId,
      year,
      month,
      day,
      `${id}${extension ? `.${extension}` : ''}`,
    );
    const sourcePath = resolveInside(sourceRoot, String(row.relative_path));
    const targetPath = resolveInside(targetRoot, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath);
    copiedFiles.push(targetPath);
    await connection.query(
      `INSERT INTO attachment
         (id, account_id, owner_principal_id, filename, mime, size_bytes,
          sha256, relative_path, scan_status, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        id,
        accountId,
        ownerPrincipalId,
        stringValue(row.filename),
        stringValue(row.mime),
        stringValue(row.size_bytes),
        String(row.sha256),
        relativePath,
        scanStatus,
        dateString(row.created_at),
      ],
    );
    attachmentByLegacyId.set(legacyId, id);
    created += 1;
  }
  return { attachmentByLegacyId, created };
}

function appendLegacyPath(note, legacyPath, hasAttachment) {
  const text = stringValue(note);
  if (hasAttachment || !legacyPath) return text;
  return text ? `${text}\n[迁移 legacy path: ${legacyPath}]` : `[迁移 legacy path: ${legacyPath}]`;
}

async function migrateDeliverables(connection, sourceRowsValue, tasks, attachments) {
  const groups = new Map();
  for (const row of sourceRowsValue) {
    const task = tasks.get(String(row.task_id));
    if (!task) throw new Error(`deliverables.id=${String(row.id)} 找不到任务`);
    const key = `${String(row.task_id)}\u0000${String(row.name)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, task });
  }

  let created = 0;
  for (const group of groups.values()) {
    group.sort((left, right) => {
      const byDate = dateString(left.row.created_at).localeCompare(dateString(right.row.created_at));
      return byDate || String(left.row.id).localeCompare(String(right.row.id), 'en');
    });
    const existingRows = await connection.query(
      `SELECT version FROM deliverable WHERE post_id = ? AND name = ?`,
      [group[0].task.postId, stringValue(group[0].row.name)],
    );
    if (existingRows.length < group.length) {
      await connection.query(
        `UPDATE deliverable SET current = 0 WHERE post_id = ? AND name = ?`,
        [group[0].task.postId, stringValue(group[0].row.name)],
      );
    }
    for (let index = 0; index < group.length; index += 1) {
      const { row, task } = group[index];
      const version = index + 1;
      const existing = await connection.query(
        `SELECT id FROM deliverable
          WHERE post_id = ? AND name = ? AND version = ? LIMIT 1`,
        [task.postId, stringValue(row.name), version],
      );
      if (existing.length > 0) continue;
      let attachmentId = null;
      if (row.attachment_id !== null && row.attachment_id !== undefined && row.attachment_id !== '') {
        attachmentId = attachments.get(String(row.attachment_id));
        if (!attachmentId) {
          throw new Error(`deliverables.id=${String(row.id)} 的 attachment_id 无法映射`);
        }
      }
      await connection.query(
        `INSERT INTO deliverable
           (id, post_id, name, version, attachment_id, note, current, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId('dlv'),
          task.postId,
          stringValue(row.name),
          version,
          attachmentId,
          appendLegacyPath(row.message, row.path, Boolean(attachmentId)),
          index === group.length - 1 ? 1 : 0,
          dateString(row.created_at),
        ],
      );
      created += 1;
    }
  }
  return created;
}

async function migrateEvents(connection, sourceRowsValue, accountId) {
  const existingRows = await connection.query(
    `SELECT id, payload FROM event
      WHERE resource_type = 'legacy'
        AND payload LIKE ?`,
    [`%"migration":"${MIGRATION_SOURCE}"%`],
  );
  const migratedIds = new Set();
  for (const row of existingRows) {
    const payload = JSON.parse(String(row.payload));
    if (payload.migration === MIGRATION_SOURCE && payload.legacy_event_id !== undefined) {
      migratedIds.add(String(payload.legacy_event_id));
      await connection.query(
        `UPDATE event
            SET published_at = COALESCE(published_at, occurred_at)
          WHERE id = ?`,
        [row.id],
      );
    }
  }

  let created = 0;
  for (const row of sourceRowsValue) {
    const legacyEventId = String(row.id);
    if (migratedIds.has(legacyEventId)) continue;
    const payload = JSON.stringify({
      migration: MIGRATION_SOURCE,
      legacy_event_id: legacyEventId,
      legacy_actor: row.actor === null ? null : String(row.actor),
      legacy_ref_task: row.ref_task === null ? null : String(row.ref_task),
      legacy_ref_plan: row.ref_plan === null ? null : String(row.ref_plan),
      legacy_summary: stringValue(row.summary),
    });
    await connection.query(
      `INSERT INTO event
         (id, account_id, actor_principal_id, action, resource_type, resource_id,
          before_state, after_state, payload, retention, occurred_at, published_at)
       VALUES (?, ?, NULL, ?, 'legacy', NULL, NULL, NULL, ?, 'audit', ?, ?)`,
      [
        newId('evt'),
        accountId,
        String(row.type),
        payload,
        dateString(row.created_at),
        dateString(row.created_at),
      ],
    );
    migratedIds.add(legacyEventId);
    created += 1;
  }
  return created;
}

async function writeMigrationBaseline(
  connection,
  sourceCountsValue,
  sourceRowsValue,
  accountId,
  targetCountsValue,
) {
  const payloadValue = {
    source: MIGRATION_SOURCE,
    counts: sourceCountsValue,
    max_legacy_event_id: sourceRowsValue.length > 0
      ? String(sourceRowsValue[sourceRowsValue.length - 1].id)
      : null,
    migrated_at: nowString(),
  };
  const existingRows = await connection.query(
    `SELECT id, payload
       FROM event
      WHERE action = 'migration.baseline'`,
  );
  const existing = existingRows.find((row) => {
    try {
      return JSON.parse(String(row.payload)).source === MIGRATION_SOURCE;
    } catch {
      return false;
    }
  });
  const targetCounts = {
    ...targetCountsValue,
    event: targetCountsValue.event + (existing ? 0 : 1),
  };
  payloadValue.target_counts = targetCounts;
  const payload = JSON.stringify(payloadValue);
  if (existing) {
    await connection.query(
      `UPDATE event
          SET account_id = ?, payload = ?, retention = 'audit',
              occurred_at = ?, published_at = COALESCE(published_at, ?)
        WHERE id = ?`,
      [accountId, payload, nowString(), nowString(), existing.id],
    );
    return;
  }
  const occurredAt = nowString();
  await connection.query(
    `INSERT INTO event
       (id, account_id, actor_principal_id, action, resource_type, resource_id,
        before_state, after_state, payload, retention, occurred_at, published_at)
     VALUES (?, ?, NULL, 'migration.baseline', 'migration', NULL, NULL, NULL, ?, 'audit', ?, ?)`,
    [newId('evt'), accountId, payload, occurredAt, occurredAt],
  );
}

async function refreshReplyCounts(connection, roots) {
  for (const postId of roots) {
    await connection.query(
      `UPDATE post
          SET reply_count = (
            SELECT COUNT(*) FROM post child WHERE child.parent_id = post.id
          )
        WHERE id = ?`,
      [postId],
    );
  }
}

async function main() {
  const { from, to, force, confirmWipeContent, allowEmpty } = parseArgs();
  const source = await mariadb.createConnection(connectionOptions(from));
  const target = await mariadb.createConnection(connectionOptions(to));
  let inTransaction = false;
  const copiedFiles = [];
  try {
    await assertConnectedDatabase(source, from, '源库');
    await assertSourceTables(source, from);
    const sourceData = await loadSource(source, from);
    const sourceBefore = await sourceCounts(source);
    console.log(`[migrate] 源库校验通过 source=${from} counts=${JSON.stringify(sourceBefore)}`);
    const coreSourceCount = sourceBefore.conversations
      + sourceBefore.chat_messages
      + sourceBefore.events;
    if (coreSourceCount === 0 && !allowEmpty) {
      throw new Error(
        `源库 ${from} 的 conversations/chat_messages/events 均为空，拒绝迁移；如确认这是有意的空迁移，请使用 --allow-empty`,
      );
    }

    const sourceAgents = await source.query(
      `SELECT id, agent_id, name, key_hash FROM agents ORDER BY id`,
    );
    const accountId = await findAccount(target);
    const identity = await loadTargetIdentity(target, sourceAgents);
    const sourceRoot = await legacyAttachmentRoot(source, from);
    const targetRoot = await targetAttachmentRoot(target, to);
    await validateForceTarget(target, force, confirmWipeContent);

    await target.beginTransaction();
    inTransaction = true;
    if (force && confirmWipeContent) await clearContent(target);
    const platformPrincipalId = await ensurePlatformPrincipal(target, accountId);

    const channelsResult = await migrateConversations(
      target,
      sourceData.conversations,
      identity,
      accountId,
    );
    const chatCreated = await migrateChatMessages(
      target,
      sourceData.chatMessages,
      channelsResult.channelByConversation,
      identity,
      platformPrincipalId,
      accountId,
    );
    const tasksResult = await migrateTasks(
      target,
      sourceData.tasks,
      identity,
      platformPrincipalId,
      accountId,
    );
    const taskMessagesResult = await migrateTaskMessages(
      target,
      sourceData.taskMessages,
      tasksResult.taskByLegacyId,
      identity,
      platformPrincipalId,
      accountId,
    );
    const verdictCreated = await migrateTaskVerdicts(
      target,
      sourceData.tasks,
      tasksResult.taskByLegacyId,
      accountId,
    );
    const attachmentsResult = await migrateAttachments(
      target,
      sourceData.attachments,
      identity,
      accountId,
      sourceRoot,
      targetRoot,
      copiedFiles,
    );
    const deliverablesCreated = await migrateDeliverables(
      target,
      sourceData.deliverables,
      tasksResult.taskByLegacyId,
      attachmentsResult.attachmentByLegacyId,
    );
    const eventsCreated = await migrateEvents(target, sourceData.events, accountId);
    const targetCountsBeforeBaseline = await targetContentCounts(target);
    await writeMigrationBaseline(
      target,
      sourceBefore,
      sourceData.events,
      accountId,
      targetCountsBeforeBaseline,
    );
    await refreshReplyCounts(
      target,
      new Set([
        ...[...channelsResult.channelByConversation.values()].map((value) => value.postId),
        ...[...tasksResult.taskByLegacyId.values()].map((value) => value.postId),
      ]),
    );

    const sourceAfter = await sourceCounts(source);
    if (!sameCounts(sourceBefore, sourceAfter)) {
      throw new Error(`老库行数在迁移期间发生变化，回滚目标库 before=${JSON.stringify(sourceBefore)} after=${JSON.stringify(sourceAfter)}`);
    }

    await target.commit();
    inTransaction = false;
    console.log(
      `[migrate] 完成 channels=${channelsResult.created} chat_messages=${chatCreated} `
      + `tasks=${tasksResult.created} task_messages=${taskMessagesResult.created} `
      + `task_verdicts=${verdictCreated} attachments=${attachmentsResult.created} `
      + `deliverables=${deliverablesCreated} events=${eventsCreated} `
      + `task_verdict_messages_skipped=${taskMessagesResult.skippedVerdicts} `
      + `source_readonly_rows=${JSON.stringify(sourceAfter)}`,
    );
  } catch (error) {
    if (inTransaction) await target.rollback();
    for (const file of copiedFiles) await rm(file, { force: true });
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
