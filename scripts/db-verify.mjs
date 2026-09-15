import dotenv from 'dotenv';
import mariadb from 'mariadb';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const EXPECTED_TABLES = [
  'account',
  'principal',
  'device',
  'device_executor',
  'api_key',
  'post',
  'post_task',
  'post_channel',
  'post_verdict',
  'post_target',
  'post_summary',
  'attachment',
  'deliverable',
  'event',
  'pipeline',
  'pipeline_step',
  'trigger',
  'setting',
  'setting_history',
  'llm_provider',
  'llm_model',
  'llm_call',
  'tag',
  'post_tag',
  'reputation_event',
];

const EXPECTED_INDEXES = [
  ['principal', 'idx_principal_acct'],
  ['api_key', 'idx_key_prn'],
  ['post', 'idx_post_root'],
  ['post', 'idx_post_parent'],
  ['post', 'idx_post_kind'],
  ['post_task', 'idx_pt_status'],
  ['post_task', 'idx_pt_assignee'],
  ['post_task', 'idx_pt_step'],
  ['post_verdict', 'idx_pv_target'],
  ['post_target', 'idx_ptgt_inbox'],
  ['attachment', 'uq_att_owner_sha'],
  ['attachment', 'idx_att_acct'],
  ['attachment', 'idx_att_scan'],
  ['deliverable', 'uq_dlv_version'],
  ['deliverable', 'uq_dlv_current'],
  ['deliverable', 'idx_dlv_att'],
  ['event', 'idx_evt_outbox'],
  ['event', 'idx_evt_res'],
  ['event', 'idx_evt_actor'],
  ['event', 'idx_evt_action'],
  ['pipeline', 'idx_pipe_owner'],
  ['pipeline_step', 'uq_step_seq'],
  ['pipeline_step', 'idx_step_dep'],
  ['trigger', 'idx_trg_due'],
  ['setting_history', 'idx_seth_key'],
  ['llm_model', 'uq_model'],
  ['llm_call', 'idx_call_time'],
  ['llm_call', 'idx_call_ref'],
  ['tag', 'uq_tag'],
  ['post_tag', 'idx_ptag_tag'],
  ['reputation_event', 'idx_rep_prn'],
];

const FORBIDDEN_COLUMNS = [
  'depth',
  'tree_path',
  'locked_at',
  'hidden_at',
  'pinned_at',
  'reply_to_id',
  'reaction',
  'like',
  'like_count',
  'liked_at',
  'quota',
  'quota_bytes',
  'quota_count',
];

function usageError(message) {
  throw new Error(`${message}\n用法: node scripts/db-verify.mjs [--database <name>]`);
}

function parseArgs() {
  let database = process.env.DB_NAME_NEW ?? process.env.DB_NAME ?? 'erix';
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--database') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) usageError('--database 缺少值');
      database = args[i + 1];
      i += 1;
    } else {
      usageError(`未知参数: ${args[i]}`);
    }
  }
  if (!/^[A-Za-z0-9_$]+$/.test(database)) {
    usageError('数据库名只允许字母、数字、下划线和美元符号');
  }
  if (database === 'task_dispatch') {
    usageError('不支持验证旧数据库，请使用 DB_NAME_NEW 或 --database 指定新库');
  }
  return database;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

async function main() {
  const database = parseArgs();
  const connection = await mariadb.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: requiredEnv('DB_USER'),
    password: process.env.DB_PASSWORD ?? '',
    database,
  });
  const failures = [];
  const pass = (label) => console.log(`PASS ${label}`);
  const fail = (label, detail) => {
    failures.push(`${label}: ${detail}`);
    console.log(`FAIL ${label} — ${detail}`);
  };

  try {
    const tables = await connection.query(
      `SELECT TABLE_NAME AS table_name
         FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_type = 'BASE TABLE'
        ORDER BY TABLE_NAME`,
    );
    const actualTables = tables.map((row) => row.table_name);
    const missingTables = EXPECTED_TABLES.filter((name) => !actualTables.includes(name));
    const extraTables = actualTables.filter((name) => !EXPECTED_TABLES.includes(name));
    if (missingTables.length === 0 && extraTables.length === 0 && actualTables.length === 25) {
      pass('表清单 = 25 张');
    } else {
      fail(
        '表清单 = 25 张',
        `缺少 [${missingTables.join(', ')}]，多出 [${extraTables.join(', ')}]，实际 ${actualTables.length} 张`,
      );
    }

    const indexes = await connection.query(
      `SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name,
              NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq_in_index,
              COLUMN_NAME AS column_name
         FROM information_schema.statistics
        WHERE table_schema = DATABASE()
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    );
    const indexMap = new Map();
    for (const row of indexes) {
      const key = `${row.table_name}.${row.index_name}`;
      const entry = indexMap.get(key) ?? {
        tableName: row.table_name,
        indexName: row.index_name,
        nonUnique: Number(row.non_unique),
        columns: [],
      };
      entry.columns.push(row.column_name);
      indexMap.set(key, entry);
    }
    for (const [tableName, indexName] of EXPECTED_INDEXES) {
      const index = indexMap.get(`${tableName}.${indexName}`);
      if (index) pass(`索引 ${tableName}.${indexName}`);
      else fail(`索引 ${tableName}.${indexName}`, '不存在');
    }

    const currentKeyIndex = indexMap.get('deliverable.uq_dlv_current');
    if (
      currentKeyIndex
      && currentKeyIndex.nonUnique === 0
      && currentKeyIndex.columns.length === 1
      && currentKeyIndex.columns[0] === 'current_key'
    ) {
      pass('deliverable.uq_dlv_current 唯一键');
    } else {
      fail('deliverable.uq_dlv_current 唯一键', '不存在或列定义不正确');
    }

    const postTargetPrimary = indexMap.get('post_target.PRIMARY');
    if (
      postTargetPrimary
      && postTargetPrimary.columns.join(',') === 'post_id,principal_id,role'
    ) {
      pass('post_target 复合主键');
    } else {
      fail('post_target 复合主键', '应为 (post_id, principal_id, role)');
    }

    const attachmentUnique = indexMap.get('attachment.uq_att_owner_sha');
    if (
      attachmentUnique
      && attachmentUnique.nonUnique === 0
      && attachmentUnique.columns.join(',') === 'owner_principal_id,sha256'
    ) {
      pass('attachment.uq_att_owner_sha 唯一键');
    } else {
      fail('attachment.uq_att_owner_sha 唯一键', '不存在或列定义不正确');
    }

    const apiKeyHashUnique = indexes.some(
      (row) => row.table_name === 'api_key'
        && Number(row.non_unique) === 0
        && row.column_name === 'key_hash',
    );
    if (apiKeyHashUnique) pass('api_key.key_hash 唯一键');
    else fail('api_key.key_hash 唯一键', '不存在');

    const pipelineStepUnique = indexMap.get('pipeline_step.uq_step_seq');
    if (
      pipelineStepUnique
      && pipelineStepUnique.nonUnique === 0
      && pipelineStepUnique.columns.join(',') === 'pipeline_id,seq'
    ) {
      pass('pipeline_step.uq_step_seq 唯一键');
    } else {
      fail('pipeline_step.uq_step_seq 唯一键', '不存在或列定义不正确');
    }

    const generatedColumns = await connection.query(
      `SELECT EXTRA AS extra, GENERATION_EXPRESSION AS generation_expression
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'deliverable'
          AND column_name = 'current_key'`,
    );
    const generated = generatedColumns[0];
    if (
      generated
      && String(generated.extra).toLowerCase().includes('generated')
      && String(generated.extra).toLowerCase().includes('stored')
      && String(generated.generation_expression).toLowerCase().includes('case')
    ) {
      pass('deliverable.current_key 为 STORED 生成列');
    } else {
      fail('deliverable.current_key 为 STORED 生成列', '生成列定义缺失或不是 STORED');
    }

    const currentTimestampDefaults = await connection.query(
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLUMN_DEFAULT AS column_default
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND COLUMN_DEFAULT IS NOT NULL
          AND LOWER(CAST(COLUMN_DEFAULT AS CHAR)) LIKE '%current_timestamp%'`,
    );
    if (currentTimestampDefaults.length === 0) pass('无 DEFAULT CURRENT_TIMESTAMP');
    else {
      fail(
        '无 DEFAULT CURRENT_TIMESTAMP',
        currentTimestampDefaults.map((row) => `${row.table_name}.${row.column_name}`).join(', '),
      );
    }

    const postRootForeignKeys = await connection.query(
      `SELECT CONSTRAINT_NAME AS constraint_name
         FROM information_schema.key_column_usage
        WHERE table_schema = DATABASE()
          AND table_name = 'post'
          AND column_name = 'root_id'
          AND referenced_table_name IS NOT NULL`,
    );
    if (postRootForeignKeys.length === 0) pass('post.root_id 无外键');
    else fail('post.root_id 无外键', postRootForeignKeys.map((row) => row.constraint_name).join(', '));

    const forbiddenColumns = await connection.query(
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND LOWER(COLUMN_NAME) IN (${FORBIDDEN_COLUMNS.map(() => '?').join(', ')})`,
      FORBIDDEN_COLUMNS,
    );
    if (forbiddenColumns.length === 0) pass('砍单字段不存在');
    else {
      fail(
        '砍单字段不存在',
        forbiddenColumns.map((row) => `${row.table_name}.${row.column_name}`).join(', '),
      );
    }

    const blockedStatuses = await connection.query(
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND LOWER(COLUMN_NAME) = 'status'
          AND LOWER(COLUMN_TYPE) LIKE '%blocked%'`,
    );
    if (blockedStatuses.length === 0) pass('无 blocked 状态');
    else fail('无 blocked 状态', blockedStatuses.map((row) => `${row.table_name}.${row.column_name}`).join(', '));
  } finally {
    await connection.end();
  }

  if (failures.length > 0) {
    console.error(`\n校验失败 (${failures.length} 项):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`\n校验通过: ${EXPECTED_TABLES.length} 张表、关键约束、索引和陷阱清单均符合`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`校验失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
