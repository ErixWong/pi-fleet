// tasks 表重建（该环境 MariaDB 对 tasks 做 ALTER 重建必失败 errno 194，只能复制换表）
// 用法：按需修改下面 CREATE 后 node scripts/rebuild-tasks.mjs
// 安全约定：fail-fast（任一步失败即非零退出，不继续破坏性步骤）；
// 旧表 rename 为 tasks_bak 保留（验证无误后手工 DROP），不直接 DROP。
import 'dotenv/config';
import { createPool } from 'mariadb';

const pool = createPool({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME ?? 'task_dispatch',
  supportBigNumbers: true,
  bigNumberStrings: true,
});

let failed = false;
const q = async (label, sql) => {
  try {
    const r = await pool.query(sql);
    console.log('OK  ', label, JSON.stringify(r, (k, v) => typeof v === 'bigint' ? String(v) : v).slice(0, 120));
    return r;
  } catch (e) {
    failed = true;
    console.error('FAIL', label, '->', e.code, e.sqlMessage?.slice(0, 200));
    throw e; // fail-fast：后续步骤不再执行（尤其换表/删表）
  }
};

try {
  await q('create new', `CREATE TABLE tasks_new (
    id BIGINT PRIMARY KEY AUTO_INCREMENT, task_id VARCHAR(32) NOT NULL UNIQUE, title VARCHAR(255) NOT NULL,
    instruction TEXT NOT NULL, kind ENUM('manual','scheduled') NOT NULL DEFAULT 'manual',
    origin ENUM('manual','periodic') NOT NULL DEFAULT 'manual',
    visibility ENUM('private','public') NOT NULL DEFAULT 'private',
    creator_id BIGINT NULL, assignee_id BIGINT NULL,
    status ENUM('pending','pending_audit','rejected','active','claimed','submitted','pending_confirm','done','failed','cancelled','open','running','resolved','blocked') NOT NULL DEFAULT 'pending',
    deliverable_visibility ENUM('participants','account','public') NOT NULL DEFAULT 'participants',
    deliver_attempts INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL DEFAULT 3,
    schedule_cron VARCHAR(100) NULL, window_start TIME NULL, window_end TIME NULL, next_due_at DATETIME NULL,
    workdir VARCHAR(512) NULL, deliverable_spec TEXT NULL, deliverable_version VARCHAR(16) NULL,
    result TEXT NULL, result_status ENUM('success','failed') NULL, result_at DATETIME NULL,
    claimed_at DATETIME NULL, last_activity_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_by_id BIGINT NULL, stage_id BIGINT NULL, series_id BIGINT NULL, content_hash CHAR(64) NULL) ENGINE=InnoDB`);

  // 动态取两端共有列：旧库缺新列（如 stage_id/series_id）时按默认填充，不炸
  const targetCols = ['id', 'task_id', 'title', 'instruction', 'kind', 'origin', 'visibility', 'creator_id', 'assignee_id',
    'status', 'deliverable_visibility', 'deliver_attempts', 'max_attempts', 'schedule_cron', 'window_start', 'window_end',
    'next_due_at', 'workdir', 'deliverable_spec', 'deliverable_version', 'result', 'result_status', 'result_at',
    'claimed_at', 'last_activity_at', 'created_at', 'resolved_by_id', 'stage_id', 'series_id', 'content_hash'];
  const existing = await q('introspect old columns', `SHOW COLUMNS FROM tasks`);
  const have = new Set(existing.map((r) => String(r.Field)));
  const cols = targetCols.filter((c) => have.has(c));
  console.log('复制列：', cols.join(','));
  await q('copy', `INSERT INTO tasks_new (${cols.join(',')}) SELECT ${cols.join(',')} FROM tasks`);

  // 复制校验：行数一致才允许换表
  const [oldN] = await q('count old', `SELECT COUNT(*) AS n FROM tasks`);
  const [newN] = await q('count new', `SELECT COUNT(*) AS n FROM tasks_new`);
  if (String(oldN.n) !== String(newN.n)) {
    throw new Error(`复制行数不一致：old=${oldN.n} new=${newN.n}，中止换表`);
  }

  // 摘掉所有引用 tasks 的 FK（schema 三处：messages / reports / deliverables；IF EXISTS 兼容无 FK 的旧库）
  await q('drop fk msg', `ALTER TABLE messages DROP FOREIGN KEY IF EXISTS fk_messages_task`);
  await q('drop fk reports', `ALTER TABLE reports DROP FOREIGN KEY IF EXISTS fk_reports_task`);
  await q('drop fk deliv', `ALTER TABLE deliverables DROP FOREIGN KEY IF EXISTS fk_deliv_task`);

  // 原子换表：单条 RENAME 多表是原子的；旧表保留为 tasks_bak，验证后手工 DROP
  await q('drop stale bak', `DROP TABLE IF EXISTS tasks_bak`);
  await q('swap', `RENAME TABLE tasks TO tasks_bak, tasks_new TO tasks`);

  await q('idx assignee', `CREATE INDEX idx_tasks_assignee ON tasks(assignee_id)`);
  await q('idx status', `CREATE INDEX idx_tasks_status ON tasks(status)`);
  await q('idx due', `CREATE INDEX idx_tasks_due ON tasks(next_due_at)`);
  await q('idx stage', `CREATE INDEX idx_tasks_stage ON tasks(stage_id)`);
  await q('fk msg', `ALTER TABLE messages ADD CONSTRAINT fk_messages_task FOREIGN KEY (task_id) REFERENCES tasks(id)`);
  await q('fk reports', `ALTER TABLE reports ADD CONSTRAINT fk_reports_task FOREIGN KEY (task_id) REFERENCES tasks(id)`);
  await q('fk deliv', `ALTER TABLE deliverables ADD CONSTRAINT fk_deliv_task FOREIGN KEY (task_id) REFERENCES tasks(id)`);

  // 最终验证：新列存在 + 行数不变
  await q('verify columns', `SHOW COLUMNS FROM tasks LIKE 'stage_id'`);
  const [finalN] = await q('verify count', `SELECT COUNT(*) AS n FROM tasks`);
  if (String(finalN.n) !== String(oldN.n)) throw new Error(`换表后行数不一致：${finalN.n} != ${oldN.n}`);
  console.log(`完成。旧表保留为 tasks_bak（${oldN.n} 行），验证无误后请手工 DROP TABLE tasks_bak`);
} catch {
  process.exitCode = 1;
  if (!failed) console.error('中止：校验未通过');
  console.error('迁移未完成，tasks/tasks_new/tasks_bak 现状请人工检查后处理');
} finally {
  await pool.end();
}
