import { createPool, type Pool, type PoolConnection } from 'mariadb';
import { config } from './config.js';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      connectionLimit: 5,
      // BIGINT 以字符串返回：避免 BigInt 序列化崩溃与 JS 精度丢失
      supportBigNumbers: true,
      bigNumberStrings: true,
      // 显式处理时间类型：DATETIME/TIME 映射为字符串，避免驱动转 Date 的时区坑
      dateStrings: true,
    });
  }
  return pool;
}

/** 执行查询，自动获取/释放连接 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const conn = await getPool().getConnection();
  try {
    return (await conn.query(sql, params)) as T[];
  } finally {
    conn.release();
  }
}

/** 在事务中执行回调 */
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
    conn.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS admin (
  id INT PRIMARY KEY DEFAULT 1,
  password_hash VARCHAR(256) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS agents (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  agent_id VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  hostname VARCHAR(128) NOT NULL DEFAULT '',
  description VARCHAR(512) NOT NULL DEFAULT '',
  system_prompt TEXT,
  tags VARCHAR(255) NOT NULL DEFAULT '',
  accept_external TINYINT(1) NOT NULL DEFAULT 0 COMMENT '接单开关：是否允许认领公共池(pool)外单',
  key_hash CHAR(64) NOT NULL UNIQUE,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  visible TINYINT(1) NOT NULL DEFAULT 1 COMMENT '软删除标记：有关联数据时置 0 不再显示',
  last_seen_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 编排：plan → stage → task 强制三层（2026-08-15 重构：任务必须从属 stage；stage 双属性 wait_prev/recurrence）
CREATE TABLE IF NOT EXISTS plans (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  plan_id VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  status ENUM('active','paused','archived','done') NOT NULL DEFAULT 'active',
  creator_agent_id BIGINT NULL COMMENT '谁创建归谁（阶段①账号派生归属）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS plan_stages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  plan_id BIGINT NOT NULL,
  seq INT NOT NULL,
  name VARCHAR(128) NOT NULL,
  wait_prev TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否等待前序 stage 完成：1=顺序（闸门）；0=并发（不等待，可并行启动）',
  recurrence ENUM('none','daily','weekly:0','weekly:1','weekly:2','weekly:3','weekly:4','weekly:5','weekly:6','hourly') NOT NULL DEFAULT 'none' COMMENT '定时：是否自动重复生成任务（none=手动/一次性；其他=周期生成原子任务）',
  window_start TIME NULL COMMENT '错峰窗口起（recurrence 非 none 时生效）',
  window_end TIME NULL COMMENT '错峰窗口止（recurrence 非 none 时生效）',
  next_due_at DATETIME NULL COMMENT '定时 stage 下一次生成时刻（recurrence 非 none 时生效）',
  UNIQUE KEY uq_plan_seq (plan_id, seq),
  CONSTRAINT fk_stage_plan FOREIGN KEY (plan_id) REFERENCES plans(id)
) ENGINE=InnoDB;
CREATE INDEX IF NOT EXISTS idx_stage_plan ON plan_stages(plan_id, seq);

CREATE TABLE IF NOT EXISTS tasks (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id VARCHAR(32) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  instruction TEXT NOT NULL,
  origin ENUM('manual','periodic') NOT NULL DEFAULT 'manual' COMMENT '来源：manual=手动创建；periodic=定时 stage 周期生成',
  plan_id BIGINT NOT NULL COMMENT '从属 plan（强制三层：task → stage → plan）',
  stage_id BIGINT NOT NULL COMMENT '所属 stage（强制：任务必须挂 stage）',
  visibility ENUM('private','public') NOT NULL DEFAULT 'private' COMMENT 'private=仅发起人+指派主机可见可接；public=入公共池可被认领',
  creator_id BIGINT NULL,
  assignee_id BIGINT NULL,
  status ENUM('pending','pending_audit','rejected','active','claimed','submitted','pending_confirm','done','failed','cancelled','open','running','resolved','blocked') NOT NULL DEFAULT 'pending',
  series_id BIGINT NULL COMMENT '周期序列首实例 id（同一定时 stage 每轮生成的任务归拢）',
  content_hash CHAR(64) NULL COMMENT '定义字段 hash（周期审核继承）',
  deliverable_visibility ENUM('participants','account','public') NOT NULL DEFAULT 'participants' COMMENT '交付物可见性三档（§编排八）',
  deliver_attempts INT NOT NULL DEFAULT 0 COMMENT '交付尝试次数（打回/预检不合格累计）',
  max_attempts INT NOT NULL DEFAULT 3 COMMENT '交付尝试上限（任务级覆盖平台默认）',
  workdir VARCHAR(512) NULL,
  deliverable_spec TEXT NULL,
  deliverable_version VARCHAR(16) NULL,
  result TEXT NULL,
  result_status ENUM('success','failed') NULL,
  result_at DATETIME NULL,
  claimed_at DATETIME NULL,
  last_activity_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tasks_assignee FOREIGN KEY (assignee_id) REFERENCES agents(id),
  CONSTRAINT fk_tasks_creator FOREIGN KEY (creator_id) REFERENCES agents(id),
  CONSTRAINT fk_tasks_plan FOREIGN KEY (plan_id) REFERENCES plans(id),
  CONSTRAINT fk_tasks_stage FOREIGN KEY (stage_id) REFERENCES plan_stages(id)
) ENGINE=InnoDB;

-- 任务消息流（原 messages 表，2026-08-15 改名：语义=任务内帖子流，与 chat_messages 对话消息区分；旧库由 initDb RENAME 迁移）
CREATE TABLE IF NOT EXISTS task_messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id BIGINT NOT NULL,
  sender_id BIGINT NULL,
  sender_role ENUM('agent','admin','system','platform') NOT NULL DEFAULT 'agent' COMMENT 'platform=平台程序（预检/回收等）',
  type ENUM('chat','progress','report','verdict','system') NOT NULL DEFAULT 'chat' COMMENT 'chat=普通回复 progress=进度 report=报告 verdict=验收判决',
  content MEDIUMTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_taskmsg_task FOREIGN KEY (task_id) REFERENCES tasks(id),
  CONSTRAINT fk_taskmsg_sender FOREIGN KEY (sender_id) REFERENCES agents(id)
) ENGINE=InnoDB;

-- 独立对话通道（管理员↔agent 直接对话，与 task_messages 解耦；task_id 为可选的来源任务上下文）
-- 多会话（2026-08-16）：主机对话不再固定 conv-host-{id} 单会话，允许创建多个（name/workdir/run_user 各自独立），
-- 任务对话保持固定 conv-task-{taskId}；workdir 约定为 ~/projects 下目录（远端 pi 在该目录下运行，pi 会话按目录存储可续接）
CREATE TABLE IF NOT EXISTS conversations (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  conversation_id VARCHAR(32) NOT NULL UNIQUE,
  agent_id BIGINT NOT NULL,
  task_id VARCHAR(32) NULL COMMENT '来源任务（业务串 T-xxx，可选；对话仍存独立表不污染任务流）',
  name VARCHAR(128) NOT NULL DEFAULT '' COMMENT '会话名（主机会话展示用，如 pi-market 开发）',
  workdir VARCHAR(512) NULL COMMENT '工作目录（~/projects 下；远端 pi 在该路径下运行，按目录续接会话）',
  run_user VARCHAR(64) NULL COMMENT '运行 pi 的用户（空=bridge 当前用户；非当前用户时 bridge 用 sudo -n -u 切换，需 sudoers 白名单）',
  status ENUM('open','archived') NOT NULL DEFAULT 'open',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_conv_agent FOREIGN KEY (agent_id) REFERENCES agents(id)
) ENGINE=InnoDB;
CREATE INDEX IF NOT EXISTS idx_conv_agent ON conversations(agent_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_task ON conversations(task_id);

-- 主机 ~/projects 目录列表缓存（bridge 上报；创建主机会话时供选择工作目录）
CREATE TABLE IF NOT EXISTS agent_projects (
  agent_id BIGINT NOT NULL,
  projects TEXT NULL COMMENT 'JSON 数组：~/projects 下目录名',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (agent_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  conversation_id VARCHAR(32) NOT NULL COMMENT '业务 ID conv-<8hex>，FK conversations.conversation_id',
  sender_role ENUM('admin','agent') NOT NULL,
  content TEXT NOT NULL,
  streaming TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=pi 流式中间态（打字机），0=最终落库',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_chatmsg_conv FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
) ENGINE=InnoDB;
CREATE INDEX IF NOT EXISTS idx_chatmsg_conv ON chat_messages(conversation_id, id);
-- 修正早期错误定义（conversation_id 误为 BIGINT；新表无数据，直接重建）
DROP TABLE IF EXISTS chat_messages_v1_bad;

CREATE TABLE IF NOT EXISTS reports (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id BIGINT NULL,
  agent_id BIGINT NULL,
  content MEDIUMTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_reports_task FOREIGN KEY (task_id) REFERENCES tasks(id),
  CONSTRAINT fk_reports_agent FOREIGN KEY (agent_id) REFERENCES agents(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS deliverables (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id BIGINT NOT NULL,
  name VARCHAR(128) NOT NULL,
  path VARCHAR(512) NOT NULL DEFAULT '',
  version VARCHAR(16) NOT NULL,
  message TEXT NULL,
  current BOOLEAN NOT NULL DEFAULT FALSE,
  agent_id BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_deliv_task FOREIGN KEY (task_id) REFERENCES tasks(id),
  CONSTRAINT fk_deliv_agent FOREIGN KEY (agent_id) REFERENCES agents(id)
) ENGINE=InnoDB;

CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_reports_task ON reports(task_id, created_at);

-- 附件系统（§3.7）：磁盘落盘 + DB 存元数据；owner 以 agent 占位账号（阶段①迁移回填 owner_account_id）
CREATE TABLE IF NOT EXISTS attachments (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  attachment_id VARCHAR(32) NOT NULL UNIQUE COMMENT 'att-<8hex>，文件名=附件ID+原扩展名',
  owner_agent_id BIGINT NOT NULL COMMENT 'MVP 以 agent 占位账号；配额主体',
  uploader_agent_id BIGINT NOT NULL COMMENT '留痕：经哪个 agent 上传',
  filename VARCHAR(255) NOT NULL COMMENT '原始文件名（仅存 DB，下载时还原）',
  mime VARCHAR(128) NOT NULL DEFAULT 'application/octet-stream',
  size_bytes BIGINT NOT NULL,
  sha256 CHAR(64) NOT NULL COMMENT '同账号去重键',
  scan_status ENUM('pending','clean','infected','skipped') NOT NULL DEFAULT 'pending',
  relative_path VARCHAR(512) NOT NULL COMMENT '{owner}/yyyy/mm/dd/{att-id}.{ext}',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_att_owner FOREIGN KEY (owner_agent_id) REFERENCES agents(id),
  CONSTRAINT fk_att_uploader FOREIGN KEY (uploader_agent_id) REFERENCES agents(id)
) ENGINE=InnoDB;
CREATE INDEX IF NOT EXISTS idx_att_owner ON attachments(owner_agent_id);
CREATE INDEX IF NOT EXISTS idx_att_sha ON attachments(owner_agent_id, sha256);

-- 系统设置（§3.7 附件配置先行；阶段③扩展 SMTP/LLM/提示词 panel）
CREATE TABLE IF NOT EXISTS settings (
  k VARCHAR(64) PRIMARY KEY,
  v TEXT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 幂等迁移（旧库升级）：删除主题概念遗留（topics 表 / topic_id 列 / 相关外键）
ALTER TABLE reports DROP FOREIGN KEY IF EXISTS fk_reports_topic;
ALTER TABLE tasks DROP FOREIGN KEY IF EXISTS fk_tasks_topic;
DROP INDEX IF EXISTS idx_reports_topic ON reports;
ALTER TABLE reports DROP COLUMN IF EXISTS topic_id;
ALTER TABLE tasks DROP COLUMN IF EXISTS topic_id;
DROP TABLE IF EXISTS topics;

-- 幂等迁移：已存在的 tasks 表补充新列（workdir / last_activity_at / creator_id / resolved_by_id / deliverable_*）
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS workdir VARCHAR(512) NULL AFTER next_due_at;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_activity_at DATETIME NULL AFTER claimed_at;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS creator_id BIGINT NULL AFTER assignee_id;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS resolved_by_id BIGINT NULL AFTER result_at;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deliverable_spec TEXT NULL AFTER workdir;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deliverable_version VARCHAR(16) NULL AFTER deliverable_spec;
-- 开放生态（§8/§3.6）：市场语义列
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS visibility ENUM('private','public') NOT NULL DEFAULT 'private' AFTER kind;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deliver_attempts INT NOT NULL DEFAULT 0 AFTER resolved_by_id;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 3 AFTER deliver_attempts;
-- 开放生态：agent 接单开关（默认关，safer default）
ALTER TABLE agents ADD COLUMN IF NOT EXISTS accept_external TINYINT(1) NOT NULL DEFAULT 0 AFTER tags;
-- 主机删除：软删除标记（有关联数据时置 0 不再显示；物理删除直接删行）
ALTER TABLE agents ADD COLUMN IF NOT EXISTS visible TINYINT(1) NOT NULL DEFAULT 1 AFTER status;
-- 消息类型（§10.3：报告/进度并入消息流）与来源标记（§3.4 验收回帖）
ALTER TABLE task_messages ADD COLUMN IF NOT EXISTS type ENUM('chat','progress','report','verdict','system') NOT NULL DEFAULT 'chat' AFTER sender_role;
ALTER TABLE task_messages MODIFY COLUMN sender_role ENUM('agent','admin','system','platform') NOT NULL DEFAULT 'agent';
-- 附件系统：交付物引用附件（引用即授权；同名交付物版本自增）
ALTER TABLE deliverables ADD COLUMN IF NOT EXISTS attachment_id BIGINT NULL AFTER agent_id;
-- 编排（orchestration.md）tasks 结构迁移：2026-08-15 模型重构后 tasks 由 SCHEMA 直接重建（强三层+无 kind），旧 migrateTasksV2 已移除
-- 带 information_schema 版本门，不在此无条件执行（本环境 ALTER 重建必失败 errno 194）。

-- 编排：plan（三层容器，命名弃用 project 避免与 workdir 项目模式撞车）——表定义已移至 agents 之后/tasks 之前（FK 顺序）

-- 提示词/设置修改留痕（§3.4：提示词即审核口径，修改需留痕：改人、改时、前值）
CREATE TABLE IF NOT EXISTS settings_history (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  k VARCHAR(64) NOT NULL,
  old_v TEXT,
  new_v TEXT,
  changed_by VARCHAR(64) NOT NULL DEFAULT 'admin',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
CREATE INDEX IF NOT EXISTS idx_settings_hist_k ON settings_history(k, created_at);

-- LLM 提供商（§3.4 重构：一个 provider 对应多个 model；base_url/api_key 在 provider 级共享，不再逐模型重复）
CREATE TABLE IF NOT EXISTS llm_providers (
  id VARCHAR(32) PRIMARY KEY COMMENT '内部引用名，如 openai / deepseek / local',
  name VARCHAR(128) NOT NULL,
  base_url VARCHAR(255) NOT NULL,
  api_key VARCHAR(255) NOT NULL DEFAULT '',
  note VARCHAR(255) NOT NULL DEFAULT '',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- LLM 模型（挂在 provider 下；base_url/api_key 继承 provider，行内不再冗余）
CREATE TABLE IF NOT EXISTS llm_models (
  id VARCHAR(32) PRIMARY KEY COMMENT '内部引用名，如 gpt-4o-mini',
  provider_id VARCHAR(32) NOT NULL,
  name VARCHAR(128) NOT NULL,
  model VARCHAR(128) NOT NULL COMMENT '请求体 model 字段（如 gpt-4o）',
  vision TINYINT(1) NOT NULL DEFAULT 0 COMMENT '多模态（可识图）',
  temperature DECIMAL(3,1) NULL DEFAULT NULL COMMENT '采样温度；NULL=平台默认 1（兼容仅允许 temperature=1 的中转）',
  price VARCHAR(64) NOT NULL DEFAULT '' COMMENT '价格标记（自由文本，如 ¥1.2/1M tokens），留痕性质',
  note VARCHAR(255) NOT NULL DEFAULT '',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 旧库升级：llm_models 补 provider_id 列（数据迁移在 initDb 内 JS 完成，成功后删 base_url/api_key 列）
ALTER TABLE llm_models ADD COLUMN IF NOT EXISTS provider_id VARCHAR(32) NULL AFTER id;
ALTER TABLE llm_models ADD COLUMN IF NOT EXISTS temperature DECIMAL(3,1) NULL DEFAULT NULL AFTER vision;

-- LLM 调用日志（成本归平台：provider/模型/用途/tokens/价格）
CREATE TABLE IF NOT EXISTS llm_calls (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  model_id VARCHAR(32) NOT NULL,
  provider_id VARCHAR(32) NULL COMMENT '冗余记录：删除 provider 后日志仍可归因',
  purpose ENUM('audit','verify','test') NOT NULL,
  task_id BIGINT NULL,
  vision TINYINT(1) NOT NULL DEFAULT 0,
  prompt_tokens INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  price VARCHAR(64) NOT NULL DEFAULT '',
  ok TINYINT(1) NOT NULL DEFAULT 1,
  error VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS provider_id VARCHAR(32) NULL AFTER model_id;
CREATE INDEX IF NOT EXISTS idx_llm_calls_time ON llm_calls(created_at);

-- ─── 标签系统（tags 目录 + agent/task 多对多；内置种子见 seedBuiltinTags） ───
CREATE TABLE IF NOT EXISTS tags (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  category VARCHAR(20) NOT NULL COMMENT '二级分类：env|deploy|os|arch|runtime|type|custom',
  name VARCHAR(64) NOT NULL COMMENT '内部标识（小写）',
  label VARCHAR(64) NOT NULL COMMENT '显示名',
  scope ENUM('host','task','both') NOT NULL DEFAULT 'host' COMMENT '适用：host=仅主机 / task=仅任务 / both=运行环境双向复用',
  sort INT NOT NULL DEFAULT 0,
  builtin TINYINT(1) NOT NULL DEFAULT 1 COMMENT '内置（1）或自定义（0）',
  color VARCHAR(16) NOT NULL DEFAULT '' COMMENT '徽标色（按 category 默认）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_cat_name (category, name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS agent_tags (
  agent_id BIGINT NOT NULL,
  tag_id BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (agent_id, tag_id),
  KEY idx_agent_tags_tag (tag_id),
  CONSTRAINT fk_agent_tags_agent FOREIGN KEY (agent_id) REFERENCES agents(id),
  CONSTRAINT fk_agent_tags_tag FOREIGN KEY (tag_id) REFERENCES tags(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS task_tags (
  task_id BIGINT NOT NULL,
  tag_id BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id, tag_id),
  KEY idx_task_tags_tag (tag_id),
  CONSTRAINT fk_task_tags_task FOREIGN KEY (task_id) REFERENCES tasks(id),
  CONSTRAINT fk_task_tags_tag FOREIGN KEY (tag_id) REFERENCES tags(id)
) ENGINE=InnoDB;
`;

/** 初始化数据库 schema（幂等） */
export async function initDb(): Promise<void> {
  const conn = await getPool().getConnection();
  try {
    // 迁移：messages → task_messages（2026-08-15 语义改名；RENAME 为元数据操作，避 errno 194）
    const tbl = (await conn.query(
      `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('messages','task_messages')`,
    )) as Array<Record<string, unknown>>;
    if (Number(tbl[0]?.c ?? 0) === 1) {
      await conn.query(`RENAME TABLE IF EXISTS messages TO task_messages`);
      console.log('[db] messages → task_messages 迁移完成');
    }
    // 迁移：编排模型重构（2026-08-15）——强制三层（task→stage→plan）+ stage 双属性（wait_prev/recurrence）
    // 检测旧结构（plans 有 recurrence 列 或 tasks 有 schedule_cron 列）→ 清空重建（用户确认删除全部 task/plan 数据）
    const oldPlan = (await conn.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'plans' AND column_name = 'recurrence'`,
    )) as Array<Record<string, unknown>>;
    const oldTask = (await conn.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tasks' AND column_name = 'schedule_cron'`,
    )) as Array<Record<string, unknown>>;
    if (Number(oldPlan[0]?.c ?? 0) > 0 || Number(oldTask[0]?.c ?? 0) > 0) {
      console.log('[db] 编排模型重构：清空并重建 tasks/plans/plan_stages 及关联数据（task_messages/deliverables/reports）');
      for (const t of ['task_messages', 'deliverables', 'reports', 'tasks', 'plan_stages', 'plans']) {
        await conn.query(`DROP TABLE IF EXISTS ${t}`);
      }
      console.log('[db] 编排表已清空重建，等待 SCHEMA 创建新结构');
    }
    // 修正：chat_messages 早期误建为 BIGINT conversation_id（无数据），DROP 后由 SCHEMA 重建为 VARCHAR
    const chatCols = (await conn.query(
      `SELECT column_type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'chat_messages' AND column_name = 'conversation_id'`,
    )) as Array<Record<string, unknown>>;
    if (chatCols.length > 0 && String(chatCols[0].column_type).toLowerCase().startsWith('bigint')) {
      await conn.query(`DROP TABLE IF EXISTS chat_messages`);
      console.log('[db] chat_messages 重建（conversation_id VARCHAR）');
    }
    for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
      await conn.query(stmt);
    }
    // 迁移：conversations 新列（task_id/name/workdir/run_user）——SCHEMA 建表后执行
    await migrateConversations(conn);
    await migrateLlmProviders(conn);
    await seedBuiltinTags(conn);
    await migrateLegacyAgentTags(conn);
  } finally {
    conn.release();
  }
}

/**
 * 迁移：conversations 新列（task_id/name/workdir/run_user，多会话模型）。
 * 幂等：列已存在（新库 SCHEMA 已含）即跳过；旧库在 SCHEMA 建表后 ALTER 补齐。
 */
async function migrateConversations(conn: { query(sql: string, params?: unknown[]): Promise<unknown> }): Promise<void> {
  const cols = async (name: string) =>
    (await conn.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'conversations' AND column_name = ?`,
      [name],
    )) as Array<Record<string, unknown>>;
  const add = async (name: string, ddl: string) => {
    const r = await cols(name);
    if (Number(r[0]?.c ?? 0) === 0) {
      await conn.query(`ALTER TABLE conversations ADD COLUMN ${ddl}`);
      console.log(`[db] conversations 加 ${name}`);
    }
  };
  await add('task_id', `task_id VARCHAR(32) NULL COMMENT '来源任务（业务串 T-xxx，可选）' AFTER agent_id`);
  await add('name', `name VARCHAR(128) NOT NULL DEFAULT '' COMMENT '会话名（主机会话展示用）' AFTER task_id`);
  await add('workdir', `workdir VARCHAR(512) NULL COMMENT '对话工作目录（远程 pi 在该路径下运行）' AFTER task_id`);
  await add('run_user', `run_user VARCHAR(64) NULL COMMENT '运行 pi 的用户（空=bridge 当前用户）' AFTER workdir`);
  // task_id 早期误建为 BIGINT → MODIFY 为 VARCHAR(32)（业务串 T-xxx）
  const t = (await conn.query(
    `SELECT column_type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'conversations' AND column_name = 'task_id'`,
  )) as Array<Record<string, unknown>>;
  if (t.length > 0 && String(t[0].column_type).toLowerCase().startsWith('bigint')) {
    await conn.query(`ALTER TABLE conversations MODIFY COLUMN task_id VARCHAR(32) NULL COMMENT '来源任务（业务串 T-xxx，可选）'`);
    console.log('[db] conversations.task_id → VARCHAR(32)');
  }
}

/**
 * LLM provider→model 重构迁移：旧 llm_models 行（base_url/api_key 在行内）
 * 按 (base_url, api_key) 归并为 provider，回填 provider_id 后删行内冗余列。
 * 幂等：已迁移（无 base_url 列）时直接跳过；空表/新库无副作用。
 */
async function migrateLlmProviders(conn: { query(sql: string, params?: unknown[]): Promise<unknown> }): Promise<void> {
  const cols = (await conn.query(`SHOW COLUMNS FROM llm_models`)) as Array<{ Field: string }>;
  const hasLegacyCols = cols.some((c) => c.Field === 'base_url');
  if (hasLegacyCols) {
    const pending = (await conn.query(
      `SELECT id, name, base_url, api_key, note FROM llm_models WHERE provider_id IS NULL`,
    )) as Array<Record<string, unknown>>;
    if (pending.length > 0) {
      // 按 (base_url, api_key) 分组归并
      const groups = new Map<string, { base_url: string; api_key: string; names: string[]; notes: string[] }>();
      for (const r of pending) {
        const key = `${String(r.base_url ?? '')}|${String(r.api_key ?? '')}`;
        if (!groups.has(key)) groups.set(key, { base_url: String(r.base_url ?? ''), api_key: String(r.api_key ?? ''), names: [], notes: [] });
        groups.get(key)!.names.push(String(r.name));
        if (r.note) groups.get(key)!.notes.push(String(r.note));
      }
      let i = 0;
      for (const g of groups.values()) {
        i++;
        const pid = `legacy-${i}`;
        const host = safeHost(g.base_url);
        await conn.query(
          `INSERT INTO llm_providers (id, name, base_url, api_key, note) VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE name=VALUES(name), base_url=VALUES(base_url), api_key=VALUES(api_key)`, 
          [pid, host ? `旧配置-${host}` : `旧配置${i}`, g.base_url, g.api_key,
           `由旧模型行自动迁移（原名称：${[...new Set(g.names)].join('、').slice(0, 120)}${g.notes.length ? `；原备注：${[...new Set(g.notes)].join('、').slice(0, 80)}` : ''}）`],
        );
        await conn.query(
          `UPDATE llm_models SET provider_id = ? WHERE provider_id IS NULL AND base_url = ? AND api_key = ?`,
          [pid, g.base_url, g.api_key],
        );
      }
    }
    // 数据迁移完成后删除行内冗余列（新库/已迁移库无此列，DROP IF EXISTS 无副作用）
    await conn.query(`ALTER TABLE llm_models DROP COLUMN IF EXISTS base_url`);
    await conn.query(`ALTER TABLE llm_models DROP COLUMN IF EXISTS api_key`);
  }
}

/** 从 base_url 提取主机名做 provider 命名（失败返回空串） */
function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
  } catch {
    return '';
  }
}

// ─────────────────────────── 标签系统（tags/agent_tags/task_tags） ───────────────────────────

type DbConn = { query(sql: string, params?: unknown[]): Promise<unknown> };

/** 内置标签种子（幂等 INSERT IGNORE；runtime 分类 scope=both = 主机运行环境 ↔ 任务技术栈双向复用） */
async function seedBuiltinTags(conn: DbConn): Promise<void> {
  const rows: Array<[string, string, string, string, number, string]> = [
    // 环境（host）
    ['env', 'dev_env', '开发环境', 'host', 10, '#0d6efd'],
    ['env', 'test_env', '测试环境', 'host', 20, '#6f42c1'],
    ['env', 'prod_env', '生产环境', 'host', 30, '#dc3545'],
    // 部署形态（host）
    ['deploy', 'vps', 'VPS', 'host', 10, '#20c997'],
    ['deploy', 'nas', 'NAS', 'host', 20, '#20c997'],
    ['deploy', 'bare_metal', '物理机', 'host', 30, '#20c997'],
    // 操作系统（host）
    ['os', 'win', 'Windows', 'host', 10, '#198754'],
    ['os', 'linux', 'Linux', 'host', 20, '#198754'],
    ['os', 'macos', 'macOS', 'host', 30, '#198754'],
    // 架构（host）
    ['arch', 'x86-64', 'x86-64', 'host', 10, '#fd7e14'],
    ['arch', 'arm64', 'ARM64', 'host', 20, '#fd7e14'],
    ['arch', 'arm', 'ARM', 'host', 30, '#fd7e14'],
    ['arch', 'riscv', 'RISC-V', 'host', 40, '#fd7e14'],
    // 运行环境/技术栈（both：主机可打、任务可打，同一 tag_id 即匹配键）
    ['runtime', 'docker', 'Docker', 'both', 10, '#0dcaf0'],
    ['runtime', 'nodejs', 'Node.js', 'both', 20, '#0dcaf0'],
    ['runtime', 'php', 'PHP', 'both', 30, '#0dcaf0'],
    ['runtime', 'python', 'Python', 'both', 40, '#0dcaf0'],
    ['runtime', 'java', 'Java', 'both', 50, '#0dcaf0'],
    ['runtime', 'go', 'Go', 'both', 60, '#0dcaf0'],
    ['runtime', 'mysql', 'MySQL', 'both', 70, '#0dcaf0'],
    ['runtime', 'redis', 'Redis', 'both', 80, '#0dcaf0'],
    ['runtime', 'nginx', 'Nginx', 'both', 90, '#0dcaf0'],
    ['runtime', 'gpu', 'GPU', 'both', 100, '#0dcaf0'],
    ['runtime', 'ffmpeg', 'FFmpeg', 'both', 110, '#0dcaf0'],
    ['runtime', 'chrome', 'Chrome 浏览器自动化', 'both', 120, '#0dcaf0'],
    // 任务类型（task）
    ['type', 'data_collect', '数据采集', 'task', 10, '#6f42c1'],
    ['type', 'frontend', '前端开发', 'task', 20, '#6f42c1'],
    ['type', 'backend', '后端开发', 'task', 30, '#6f42c1'],
    ['type', 'fullstack', '全栈开发', 'task', 40, '#6f42c1'],
    ['type', 'database', '数据库', 'task', 50, '#6f42c1'],
    ['type', 'testing', '测试', 'task', 60, '#6f42c1'],
    ['type', 'doc', '文档', 'task', 70, '#6f42c1'],
    ['type', 'design', '设计', 'task', 80, '#6f42c1'],
    ['type', 'ops', '运维', 'task', 90, '#6f42c1'],
    ['type', 'ai', 'AI 任务', 'task', 100, '#6f42c1'],
    ['type', 'crawler', '爬虫', 'task', 110, '#6f42c1'],
  ];
  for (const [category, name, label, scope, sort, color] of rows) {
    await conn.query(
      `INSERT IGNORE INTO tags (category, name, label, scope, sort, builtin, color) VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [category, name, label, scope, sort, color],
    );
  }
}

/** 旧 tags 字符串归一化：小写 + 常见别名映射（幂等） */
function normalizeTagName(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/\s+/g, '-');
  const map: Record<string, string> = {
    windows: 'win',
    mac: 'macos',
    x86_64: 'x86-64',
    x86: 'x86-64',
    dev: 'dev_env',
    prod: 'prod_env',
    test: 'test_env',
  };
  return map[s] ?? s;
}

/** 迁移旧 agents.tags 逗号字符串 → agent_tags（一次性语义；幂等：INSERT IGNORE + 自建 custom 受唯一键保护） */
async function migrateLegacyAgentTags(conn: DbConn): Promise<void> {
  const rows = (await conn.query(`SELECT id, tags FROM agents WHERE TRIM(tags) <> ''`)) as Array<Record<string, unknown>>;
  if (rows.length === 0) return;
  const allTags = (await conn.query(`SELECT id, category, name, label, scope FROM tags`)) as Array<Record<string, unknown>>;
  const byName = new Map<string, Record<string, unknown>>();
  const byLabel = new Map<string, Record<string, unknown>>();
  for (const t of allTags) {
    byName.set(String(t.name).toLowerCase(), t);
    byLabel.set(String(t.label).toLowerCase(), t);
  }
  let linked = 0;
  for (const r of rows) {
    const agentId = Number(r.id);
    for (const raw of String(r.tags).split(',')) {
      const name = normalizeTagName(raw);
      if (!name) continue;
      let tag = byName.get(name) ?? byLabel.get(name) ?? byLabel.get(raw.trim().toLowerCase());
      if (!tag) {
        // 识别不了 → 自建 custom（host 适用），唯一键防重复
        await conn.query(`INSERT IGNORE INTO tags (category, name, label, scope, sort, builtin, color) VALUES ('custom', ?, ?, 'host', 999, 0, '#adb5bd')`, [name, name]);
        const created = (await conn.query(`SELECT id FROM tags WHERE category='custom' AND name=? LIMIT 1`, [name])) as Array<Record<string, unknown>>;
        if (created.length === 0) continue;
        tag = created[0];
        byName.set(name, tag);
      }
      const r2 = await conn.query(`INSERT IGNORE INTO agent_tags (agent_id, tag_id) VALUES (?, ?)`, [agentId, Number(tag.id)]);
      linked += (r2 as { affectedRows?: number }).affectedRows ?? 0;
    }
  }
  if (linked > 0) console.log(`[db] 标签迁移：旧 agents.tags → agent_tags 建立 ${linked} 条关联`);
}
