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
  creator_id BIGINT NULL,
  assignee_id BIGINT NULL,
  status ENUM('pending','running','done','failed','cancelled','open','resolved') NOT NULL DEFAULT 'pending',
  schedule_cron VARCHAR(100) NULL,
  window_start TIME NULL,
  window_end TIME NULL,
  next_due_at DATETIME NULL,
  workdir VARCHAR(512) NULL,
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
  sender_role ENUM('agent','admin','system') NOT NULL DEFAULT 'agent',
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

CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(next_due_at);
CREATE INDEX IF NOT EXISTS idx_reports_task ON reports(task_id, created_at);

-- 幂等迁移（旧库升级）：删除主题概念遗留（topics 表 / topic_id 列 / 相关外键）
ALTER TABLE reports DROP FOREIGN KEY IF EXISTS fk_reports_topic;
ALTER TABLE tasks DROP FOREIGN KEY IF EXISTS fk_tasks_topic;
DROP INDEX IF EXISTS idx_reports_topic ON reports;
ALTER TABLE reports DROP COLUMN IF EXISTS topic_id;
ALTER TABLE tasks DROP COLUMN IF EXISTS topic_id;
DROP TABLE IF EXISTS topics;

-- 幂等迁移：已存在的 tasks 表补充新列（workdir / last_activity_at / creator_id / resolved_by_id）
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS workdir VARCHAR(512) NULL AFTER next_due_at;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_activity_at DATETIME NULL AFTER claimed_at;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS creator_id BIGINT NULL AFTER assignee_id;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS resolved_by_id BIGINT NULL AFTER result_at;
-- 状态枚举扩展（旧表迁移）：加入协作会话状态 open / resolved
ALTER TABLE tasks MODIFY COLUMN status ENUM('pending','running','done','failed','cancelled','open','resolved') NOT NULL DEFAULT 'pending';
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
