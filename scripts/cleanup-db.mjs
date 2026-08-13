// 数据库清理：删除测试/演示主机及其任务，只保留真实主机（本机 local-pi）
import { createPool } from 'mariadb';
const pool = createPool({ host: '127.0.0.1', port: 3306, user: 'root', password: 'erixPwd', database: 'task_dispatch', supportBigNumbers: true, bigNumberStrings: true });

const KEEP = ['local-pi'];

const [beforeAgents, beforeTasks, beforeMsgs, beforeReports] = await Promise.all([
  pool.query(`SELECT COUNT(*) c FROM agents`),
  pool.query(`SELECT COUNT(*) c FROM tasks`),
  pool.query(`SELECT COUNT(*) c FROM messages`),
  pool.query(`SELECT COUNT(*) c FROM reports`),
]);

// 测试主机 id
const testAgents = await pool.query(
  `SELECT id FROM agents WHERE name NOT IN (${KEEP.map(() => '?').join(',')})`,
  KEEP,
);
const testIds = testAgents.map((a) => a.id);
if (testIds.length === 0) {
  console.log('没有测试主机，无需清理');
} else {
  const ph = testIds.map(() => '?').join(',');
  const twice = [...testIds, ...testIds]; // 两处 IN 各用一次
  // 测试主机的消息（作为发送者）
  await pool.query(`DELETE FROM messages WHERE sender_id IN (${ph})`, testIds);
  // 测试任务（assignee 或 creator 是测试主机）的消息与报告
  await pool.query(
    `DELETE FROM messages WHERE task_id IN (SELECT id FROM tasks WHERE assignee_id IN (${ph}) OR creator_id IN (${ph}))`,
    twice,
  );
  await pool.query(
    `DELETE FROM reports WHERE task_id IN (SELECT id FROM tasks WHERE assignee_id IN (${ph}) OR creator_id IN (${ph}))`,
    twice,
  );
  // 测试任务
  const delTasks = await pool.query(
    `DELETE FROM tasks WHERE assignee_id IN (${ph}) OR creator_id IN (${ph})`,
    twice,
  );
  // 测试主机
  const delAgents = await pool.query(`DELETE FROM agents WHERE id IN (${ph})`, testIds);
  console.log(`清理：测试主机 ${delAgents.affectedRows} 台，关联任务 ${delTasks.affectedRows} 个`);
}

const [afterAgents, afterTasks, afterMsgs, afterReports] = await Promise.all([
  pool.query(`SELECT COUNT(*) c FROM agents`),
  pool.query(`SELECT COUNT(*) c FROM tasks`),
  pool.query(`SELECT COUNT(*) c FROM messages`),
  pool.query(`SELECT COUNT(*) c FROM reports`),
]);
console.log(`agents: ${beforeAgents[0].c} -> ${afterAgents[0].c}`);
console.log(`tasks:  ${beforeTasks[0].c} -> ${afterTasks[0].c}`);
console.log(`messages: ${beforeMsgs[0].c} -> ${afterMsgs[0].c}`);
console.log(`reports:  ${beforeReports[0].c} -> ${afterReports[0].c}`);

const left = await pool.query(`SELECT id, name, hostname, status FROM agents ORDER BY id`);
for (const a of left) console.log(`  [${a.id}] ${a.name} | ${a.hostname} | ${a.status}`);
await pool.end();
