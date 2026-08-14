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
  last_seen_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tasks (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id VARCHAR(32) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  instruction TEXT NOT NULL,
  kind ENUM('manual','scheduled') NOT NULL DEFAULT 'manual',
  visibility ENUM('private','public') NOT NULL DEFAULT 'private' COMMENT 'private=仅发起人+指派主机可见可接；public=入公共池可被认领',
  creator_id BIGINT NULL,
  assignee_id BIGINT NULL,
  status ENUM('pending','pending_audit','rejected','active','claimed','submitted','pending_confirm','done','failed','cancelled','open','running','resolved') NOT NULL DEFAULT 'pending',
  deliver_attempts INT NOT NULL DEFAULT 0 COMMENT '交付尝试次数（打回/预检不合格累计）',
  max_attempts INT NOT NULL DEFAULT 3 COMMENT '交付尝试上限（任务级覆盖平台默认）',
  schedule_cron VARCHAR(100) NULL,
  window_start TIME NULL,
  window_end TIME NULL,
  next_due_at DATETIME NULL,
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
  CONSTRAINT fk_tasks_creator FOREIGN KEY (creator_id) REFERENCES agents(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id BIGINT NOT NULL,
  sender_id BIGINT NULL,
  sender_role ENUM('agent','admin','system','platform') NOT NULL DEFAULT 'agent' COMMENT 'platform=平台程序（预检/回收等）',
  type ENUM('chat','progress','report','verdict','system') NOT NULL DEFAULT 'chat' COMMENT 'chat=普通回复 progress=进度 report=报告 verdict=验收判决',
  content MEDIUMTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_messages_task FOREIGN KEY (task_id) REFERENCES tasks(id),
  CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES agents(id)
) ENGINE=InnoDB;

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
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(next_due_at);
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
-- 消息类型（§10.3：报告/进度并入消息流）与来源标记（§3.4 验收回帖）
ALTER TABLE messages ADD COLUMN IF NOT EXISTS type ENUM('chat','progress','report','verdict','system') NOT NULL DEFAULT 'chat' AFTER sender_role;
ALTER TABLE messages MODIFY COLUMN sender_role ENUM('agent','admin','system','platform') NOT NULL DEFAULT 'agent';
-- 附件系统：交付物引用附件（引用即授权；同名交付物版本自增）
ALTER TABLE deliverables ADD COLUMN IF NOT EXISTS attachment_id BIGINT NULL AFTER agent_id;
-- 状态枚举扩展（旧表迁移）：加入公共池/认领/验收状态 active / claimed / submitted / pending_confirm
ALTER TABLE tasks MODIFY COLUMN status ENUM('pending','pending_audit','rejected','active','claimed','submitted','pending_confirm','done','failed','cancelled','open','running','resolved') NOT NULL DEFAULT 'pending';

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

-- LLM 多模型（§3.4 扩展：区分能力/多模态、支持多模型、价格标记）
CREATE TABLE IF NOT EXISTS llm_models (
  id VARCHAR(32) PRIMARY KEY COMMENT '内部引用名，如 default / vision / cheap',
  name VARCHAR(128) NOT NULL,
  base_url VARCHAR(255) NOT NULL,
  model VARCHAR(128) NOT NULL,
  api_key VARCHAR(255) NOT NULL DEFAULT '',
  vision TINYINT(1) NOT NULL DEFAULT 0 COMMENT '多模态（可识图）',
  price VARCHAR(64) NOT NULL DEFAULT '' COMMENT '价格标记（自由文本，如 ¥1.2/1M tokens），留痕性质',
  note VARCHAR(255) NOT NULL DEFAULT '',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- LLM 调用日志（成本归平台：模型/用途/tokens/价格）
CREATE TABLE IF NOT EXISTS llm_calls (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  model_id VARCHAR(32) NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_llm_calls_time ON llm_calls(created_at);
`;

/** 初始化数据库 schema（幂等） */
export async function initDb(): Promise<void> {
  const conn = await getPool().getConnection();
  try {
    for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
      await conn.query(stmt);
    }
  } finally {
    conn.release();
  }
}
