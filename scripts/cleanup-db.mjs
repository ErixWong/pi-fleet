// 数据库清理：删除测试/演示主机及其任务/消息/报告/交付物，只保留真实主机（本机 local-pi）
// 注意：表空间损坏的表（task_messages/reports/deliverables）只能用 DELETE，不能用 TRUNCATE
import { createPool } from 'mariadb';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
const pool = createPool({ host: '127.0.0.1', port: 3306, user: 'root', password: 'erixPwd', database: 'task_dispatch', supportBigNumbers: true, bigNumberStrings: true });

const KEEP = ['local-pi', 'local-pi-open']; // 本机真实接入的主机

const count = async (t) => (await pool.query(`SELECT COUNT(*) c FROM ${t}`))[0].c;
const [beforeAgents, beforeTasks, beforeMsgs, beforeReports, beforeDels, beforeAtts] = await Promise.all([
  count('agents'), count('tasks'), count('task_messages'), count('reports'), count('deliverables'), count('attachments'),
]);

// 测试主机 id（保留名单之外）
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

  // 按归属任务删除（子表先删，避免外键）
  const scope = `(SELECT id FROM tasks WHERE assignee_id IN (${ph}) OR creator_id IN (${ph}))`;
  const delDel = await pool.query(`DELETE FROM deliverables WHERE task_id IN ${scope}`, twice);
  // 附件：测试主机为 owner 的（引用已随 deliverables 清除）——先取磁盘路径再删行，随后清理磁盘文件
  const attRows = await pool.query(
    `SELECT attachment_id, relative_path FROM attachments WHERE owner_agent_id IN (${ph})`,
    testIds,
  );
  const delAtt = await pool.query(`DELETE FROM attachments WHERE owner_agent_id IN (${ph})`, testIds);
  // 磁盘文件清理：{attachments_root}/{relative_path}（优先读 settings，未配置回退项目根/attachments）
  const rootRows = await pool.query(`SELECT v FROM settings WHERE k = 'attachments_root'`);
  const root = rootRows.length > 0 ? String(rootRows[0].v) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'attachments');
  let diskRemoved = 0;
  for (const a of attRows) {
    if (!a.relative_path) continue;
    const abs = path.join(root, String(a.relative_path));
    try {
      await rm(abs, { force: true });
      diskRemoved++;
    } catch { /* 文件本就不存在，忽略 */ }
  }
  const delRep = await pool.query(`DELETE FROM reports WHERE task_id IN ${scope}`, twice);
  const delMsg = await pool.query(`DELETE FROM task_messages WHERE task_id IN ${scope}`, twice);
  // 测试主机作为发送者的孤儿消息（无归属任务）
  await pool.query(`DELETE FROM task_messages WHERE sender_id IN (${ph})`, testIds);
  // 测试任务
  const delTasks = await pool.query(`DELETE FROM tasks WHERE assignee_id IN (${ph}) OR creator_id IN (${ph})`, twice);
  // 测试主机
  const delAgents = await pool.query(`DELETE FROM agents WHERE id IN (${ph})`, testIds);
  console.log(`清理：测试主机 ${delAgents.affectedRows} 台，任务 ${delTasks.affectedRows} 个，交付物 ${delDel.affectedRows}，附件 ${delAtt.affectedRows}（磁盘文件 ${diskRemoved}），报告 ${delRep.affectedRows}，消息 ${delMsg.affectedRows}`);
}

const [afterAgents, afterTasks, afterMsgs, afterReports, afterDels, afterAtts] = await Promise.all([
  count('agents'), count('tasks'), count('task_messages'), count('reports'), count('deliverables'), count('attachments'),
]);
console.log(`agents: ${beforeAgents} -> ${afterAgents}`);
console.log(`tasks:  ${beforeTasks} -> ${afterTasks}`);
console.log(`messages(task_messages): ${beforeMsgs} -> ${afterMsgs}`);
console.log(`reports:  ${beforeReports} -> ${afterReports}`);
console.log(`deliverables: ${beforeDels} -> ${afterDels}`);
console.log(`attachments: ${beforeAtts} -> ${afterAtts}`);

const left = await pool.query(`SELECT id, name, hostname, status, accept_external FROM agents ORDER BY id`);
for (const a of left) console.log(`  [${a.id}] ${a.name} | ${a.hostname} | ${a.status} | accept=${a.accept_external}`);
await pool.end();
