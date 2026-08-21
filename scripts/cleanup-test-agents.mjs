// 清理验收脚本产生的测试 agent 及其任务/报告（保留 local-pi / vm-02 / web-01 等真实 agent）
import 'dotenv/config';
import { createPool } from 'mariadb';
const pool = createPool({ host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD ?? '', database: process.env.DB_NAME ?? 'task_dispatch' });

const [beforeAgents, beforeTasks] = await Promise.all([
  pool.query(`SELECT COUNT(*) c FROM agents`),
  pool.query(`SELECT COUNT(*) c FROM tasks`),
]);

// 先删报告/任务（外键），再删 agent
await pool.query(
  `DELETE FROM reports WHERE agent_id IN (SELECT id FROM agents WHERE name IN ('test-agent-01','rest-test'))`,
);
await pool.query(
  `DELETE FROM tasks WHERE assignee_id IN (SELECT id FROM agents WHERE name IN ('test-agent-01','rest-test'))`,
);
const del = await pool.query(
  `DELETE FROM agents WHERE name IN ('test-agent-01','rest-test')`,
);
const [afterAgents, afterTasks] = await Promise.all([
  pool.query(`SELECT COUNT(*) c FROM agents`),
  pool.query(`SELECT COUNT(*) c FROM tasks`),
]);

console.log(`清理测试 agent: ${del.affectedRows} 个`);
console.log(`agents: ${beforeAgents[0].c} -> ${afterAgents[0].c}`);
console.log(`tasks:  ${beforeTasks[0].c} -> ${afterTasks[0].c}`);

const left = await pool.query(`SELECT id, agent_id, name, hostname, tags, status FROM agents ORDER BY id`);
for (const a of left) console.log(`  [${a.id}] ${a.name} | ${a.agent_id} | ${a.hostname} | ${a.tags} | ${a.status}`);

await pool.end();
