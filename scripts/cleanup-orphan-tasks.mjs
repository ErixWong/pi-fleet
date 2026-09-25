// 一次性清理脚本（issue #52）：软删「祖先已删但自身存活」的遗留任务。
// 检测在 JS 侧沿 post_task.parent_task_id 上溯祖先链，命中已删或缺失祖先即视为孤儿；
// 删除走 service 层 deletePost（级联软删整个子树，逐行记录 post.deleted 事件）。
// 只写 post.deleted_at / post.reply_count 和 event 表，不硬删任何行。
//
// 运行：node --import tsx scripts/cleanup-orphan-tasks.mjs [--dry-run]
import { tsImport } from 'tsx/esm/api';

process.env.DB_NAME_NEW = process.env.DB_NAME_NEW ?? 'erix';

const posts = await tsImport('../src/service/posts.ts', import.meta.url);
const { getPool } = await tsImport('../src/db/pool.ts', import.meta.url);

const dryRun = process.argv.includes('--dry-run');

// 返回存活任务中「任一祖先已删或缺失」的 post id 列表。
async function findOrphanTaskIds() {
  const pool = getPool();
  const taskRows = await pool.query(
    `SELECT p.id, t.parent_task_id
       FROM post p
       JOIN post_task t ON t.post_id = p.id
      WHERE p.deleted_at IS NULL`,
  );
  const stateById = new Map();
  for (const row of await pool.query('SELECT id, deleted_at FROM post')) {
    stateById.set(String(row.id), row.deleted_at ? 'deleted' : 'live');
  }
  const parentByTask = new Map(taskRows.map((row) => [String(row.id), row.parent_task_id ? String(row.parent_task_id) : null]));
  const orphans = [];
  for (const row of taskRows) {
    const seen = new Set([String(row.id)]);
    let parentId = row.parent_task_id ? String(row.parent_task_id) : null;
    let broken = false;
    while (parentId) {
      if (seen.has(parentId)) break; // 环路交给业务层异常处理，不在此清理
      seen.add(parentId);
      const state = stateById.get(parentId);
      if (state === undefined || state === 'deleted') {
        broken = true;
        break;
      }
      parentId = parentByTask.get(parentId) ?? null;
    }
    if (broken) orphans.push(String(row.id));
  }
  return orphans;
}

async function countRows(predicateSql) {
  const row = (await getPool().query(`SELECT COUNT(*) AS n FROM post WHERE ${predicateSql}`))[0];
  return Number(row.n);
}

const before = await findOrphanTaskIds();
console.log(`清理前「祖先已删但自身存活」的任务数：${before.length}`);

if (before.length === 0) {
  console.log('无需清理。');
  await getPool().end();
  process.exit(0);
}

if (dryRun) {
  console.log(`dry-run：将软删以下 ${before.length} 个任务（含级联后代）：`);
  for (const id of before) console.log(`  ${id}`);
  await getPool().end();
  process.exit(0);
}

let deletedRows = 0;
for (const id of before) {
  const beforeCount = await countRows('deleted_at IS NOT NULL');
  await posts.deletePost(id); // 已删的 id 是 no-op
  deletedRows += (await countRows('deleted_at IS NOT NULL')) - beforeCount;
}

const after = await findOrphanTaskIds();
console.log(`本次级联软删 post 行数：${deletedRows}`);
console.log(`清理后「祖先已删但自身存活」的任务数：${after.length}`);
if (after.length !== 0) {
  console.error(`清理不完整，仍有孤儿：${after.join(', ')}`);
  process.exit(1);
}
console.log('清理完成。');
await getPool().end();
