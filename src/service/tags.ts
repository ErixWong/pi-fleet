import { query, withTransaction } from '../db.js';

/**
 * 标签系统（tags 目录 + agent_tags/task_tags 多对多）：
 * - tags：唯一权威目录（category 二级分类 × scope 适用实体）
 *   runtime 分类 scope=both：主机「运行环境」↔ 任务「技术栈」同一 tag_id 双向复用
 * - 主机/任务标签由管理员贴（元数据），平台不做死板匹配；
 *   LLM 推荐/语义理解是上层用途（标签只是素材）
 */

export interface TagView {
  id: number;
  category: string;
  name: string;
  label: string;
  scope: 'host' | 'task' | 'both';
  sort: number;
  builtin: boolean;
  color: string;
}

export interface TagGroup {
  category: string;
  /** category 显示名 */
  title: string;
  tags: TagView[];
}

const CATEGORY_TITLES: Record<string, string> = {
  env: '环境',
  deploy: '部署形态',
  os: '操作系统',
  arch: '架构',
  runtime: '运行环境 / 技术栈',
  type: '任务类型',
  custom: '自定义',
};

const CATEGORY_SCOPE: Record<string, 'host' | 'task' | 'both'> = {
  env: 'host',
  deploy: 'host',
  os: 'host',
  arch: 'host',
  runtime: 'both',
  type: 'task',
  custom: 'both',
};

const CATEGORY_ORDER = ['env', 'deploy', 'os', 'arch', 'runtime', 'type', 'custom'];

/** 全部标签目录（按 category 分组） */
export async function listTags(): Promise<TagGroup[]> {
  const rows = (await query(
    `SELECT id, category, name, label, scope, sort, builtin, color FROM tags ORDER BY
       FIELD(category, ${CATEGORY_ORDER.map(() => '?').join(',')}), sort, id`,
    CATEGORY_ORDER,
  )) as Array<Record<string, unknown>>;
  const groups = new Map<string, TagView[]>();
  for (const r of rows) {
    const cat = String(r.category);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push({
      id: Number(r.id),
      category: cat,
      name: String(r.name),
      label: String(r.label),
      scope: (r.scope as TagView['scope']) ?? 'host',
      sort: Number(r.sort),
      builtin: Number(r.builtin) === 1,
      color: String(r.color ?? ''),
    });
  }
  return CATEGORY_ORDER.filter((c) => groups.has(c)).map((c) => ({
    category: c,
    title: CATEGORY_TITLES[c] ?? c,
    tags: groups.get(c)!,
  }));
}

/** 主机/任务标签的行视图（JOIN tags） */
export interface EntityTag extends TagView {
  agent_id?: number;
  task_id?: number;
}

/** 读取主机的全部标签 */
export async function getAgentTags(agentId: number): Promise<TagView[]> {
  const rows = (await query(
    `SELECT t.id, t.category, t.name, t.label, t.scope, t.sort, t.builtin, t.color
       FROM agent_tags at JOIN tags t ON t.id = at.tag_id
      WHERE at.agent_id = ? ORDER BY FIELD(t.category, ${CATEGORY_ORDER.map(() => '?').join(',')}), t.sort, t.id`,
    [agentId, ...CATEGORY_ORDER],
  )) as Array<Record<string, unknown>>;
  return rows.map((r) => tagFromRow(r));
}

/** 读取任务的全部标签 */
export async function getTaskTags(taskId: number): Promise<TagView[]> {
  const rows = (await query(
    `SELECT t.id, t.category, t.name, t.label, t.scope, t.sort, t.builtin, t.color
       FROM task_tags tt JOIN tags t ON t.id = tt.tag_id
      WHERE tt.task_id = ? ORDER BY FIELD(t.category, ${CATEGORY_ORDER.map(() => '?').join(',')}), t.sort, t.id`,
    [taskId, ...CATEGORY_ORDER],
  )) as Array<Record<string, unknown>>;
  return rows.map((r) => tagFromRow(r));
}

function tagFromRow(r: Record<string, unknown>): TagView {
  return {
    id: Number(r.id),
    category: String(r.category),
    name: String(r.name),
    label: String(r.label),
    scope: (r.scope as TagView['scope']) ?? 'host',
    sort: Number(r.sort),
    builtin: Number(r.builtin) === 1,
    color: String(r.color ?? ''),
  };
}

/** 把标签名列表解析为 tag_id（匹配内置 name/label；识别不了自建 custom，scope 取传入实体） */
async function resolveTagNames(
  conn: { query(sql: string, params?: unknown[]): Promise<unknown> },
  names: string[],
  scope: 'host' | 'task',
): Promise<number[]> {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (clean.length === 0) return [];
  const allTags = (await conn.query(`SELECT id, category, name, label FROM tags`)) as Array<Record<string, unknown>>;
  const byName = new Map<string, number>();
  const byLabel = new Map<string, number>();
  for (const t of allTags) {
    byName.set(String(t.name).toLowerCase(), Number(t.id));
    byLabel.set(String(t.label).toLowerCase(), Number(t.id));
  }
  const ids: number[] = [];
  for (const raw of clean) {
    const lower = raw.toLowerCase();
    let id = byName.get(lower) ?? byLabel.get(lower);
    if (!id) {
      await conn.query(
        `INSERT IGNORE INTO tags (category, name, label, scope, sort, builtin, color) VALUES ('custom', ?, ?, ?, 999, 0, '#adb5bd')`,
        [raw, raw, scope],
      );
      const created = (await conn.query(`SELECT id FROM tags WHERE category='custom' AND name=? LIMIT 1`, [raw])) as Array<Record<string, unknown>>;
      if (created.length === 0) continue;
      id = Number(created[0].id);
      byName.set(lower, id);
      byLabel.set(lower, id);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 替换主机标签（全量覆盖；names 未匹配内置时自建 custom） */
export async function setAgentTags(agentId: number, names: string[]): Promise<TagView[]> {
  await withTransaction(async (conn) => {
    const ids = await resolveTagNames(conn, names, 'host');
    await conn.query(`DELETE FROM agent_tags WHERE agent_id = ?`, [agentId]);
    for (const tagId of ids) {
      await conn.query(`INSERT IGNORE INTO agent_tags (agent_id, tag_id) VALUES (?, ?)`, [agentId, tagId]);
    }
    // 同步遗留 tags 字符串列（兼容旧前端展示；主数据在 agent_tags）
    await conn.query(`UPDATE agents SET tags = ? WHERE id = ?`, [ids.length ? names.join(', ') : '', agentId]);
  });
  // 事务提交后读取（事务内读另一连接看不到未提交数据）
  return getAgentTags(agentId);
}

/** 替换任务标签（全量覆盖） */
export async function setTaskTags(taskId: number, names: string[]): Promise<TagView[]> {
  await withTransaction(async (conn) => {
    const ids = await resolveTagNames(conn, names, 'task');
    await conn.query(`DELETE FROM task_tags WHERE task_id = ?`, [taskId]);
    for (const tagId of ids) {
      await conn.query(`INSERT IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)`, [taskId, tagId]);
    }
  });
  // 事务提交后读取
  return getTaskTags(taskId);
}

/** 任务业务串 T-xxx → 数字 id（供 setTaskTags 用） */
export async function taskIdByBusiness(businessId: string): Promise<number | null> {
  const rows = (await query(`SELECT id FROM tasks WHERE task_id = ? LIMIT 1`, [businessId])) as Array<Record<string, unknown>>;
  return rows.length ? Number(rows[0].id) : null;
}

/** 按标签过滤主机：names 命中任意一个标签即可（any 语义） */
export async function agentsByTags(names: string[]): Promise<Array<{ id: number; agent_id: string; name: string; hostname: string; status: string }>> {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length === 0) return [];
  const rows = (await query(
    `SELECT DISTINCT a.id, a.agent_id, a.name, a.hostname, a.status
       FROM agents a
       JOIN agent_tags at ON at.agent_id = a.id
       JOIN tags t ON t.id = at.tag_id
      WHERE (t.name IN (${clean.map(() => '?').join(',')}) OR t.label IN (${clean.map(() => '?').join(',')})) AND a.visible = 1`,
    [...clean, ...clean],
  )) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    agent_id: String(r.agent_id),
    name: String(r.name),
    hostname: String(r.hostname),
    status: String(r.status),
  }));
}
