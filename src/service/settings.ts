import { query } from '../db.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 系统设置（KV）：附件/LLM/提示词配置（§3.4/§3.7），存库而非 .env。
 * 启动时读入内存缓存；修改留痕（settings_history：改人/改时/前值，§3.4）。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** 默认附件根：项目根/attachments（相对路径按 dist/src 或 src 布局解析） */
function defaultRoot(): string {
  return path.resolve(here, '../../..', 'attachments');
}

const DEFAULTS: Record<string, string> = {
  // 附件（§3.7）
  attachments_root: defaultRoot(),
  quota_bytes: String(1024 * 1024 * 1024), // 账号级默认 1GB
  max_attachment_bytes: String(50 * 1024 * 1024), // 单文件 50MB
  clamd_host: '',
  clamd_port: '3310',
  // LLM 审核/验收（§3.4）：base_url/api_key 已提升到 llm_providers（一个 provider 对应多个 model）；
  // 这里只留读取边界/超时与用途绑定（llm_audit_model / llm_verify_model，默认 auto）
  llm_verifier_read_bytes: String(64 * 1024), // LLM 验收文本读取上限（§3.7 验收读取边界）
  llm_timeout_ms: String(60_000),
  // 主机失联阈值（分钟）：超过此时间无心跳（last_seen_at）→ 前端显示「失联」徽标；只读标记，不自动禁用
  agent_offline_after_min: String(30),
  // 提示词模板（§3.4：提示词即平台审核口径，内置默认值，管理员可改；修改留痕）
  prompt_audit: `你是任务分发平台的发布审核器。请审核任务发布内容，输出 json：{"passed": true|false, "reason": "简短原因"}。
审核标准（只查可操作性，不评判内容对错善恶）：
1. 任务描述是否清晰可执行（有明确目标、上下文、约束）；
2. 验收方案（deliverable_spec）是否可操作——每项须有非空 name，类型约束（.ext 或 mime/前缀）合理；
3. 交付物最少数量合理（min_count 缺省 1，大于 1 时任务描述应说明为什么）。
任务标题：{{title}}
任务描述：{{instruction}}
验收方案：{{deliverable_spec}}`,
  prompt_verify: `你是任务分发平台的验收器。请按验收方案校验交付物内容，输出 json：{"passed": true|false, "reason": "简短原因"}。
规则：
1. 逐项核对验收方案：每个约定项的交付物是否真实满足（存在、非空、内容符合语义要求）；
2. 只判断"是否达成约定"，不评判内容质量好坏之外的对错善恶；
3. 二进制交付物只验存在性与类型，不做内容语义判断。
任务标题：{{title}}
任务描述：{{instruction}}
验收方案：{{deliverable_spec}}
交付物内容（文本类读前 N 字节，二进制仅列文件名与类型）：
{{deliverables_text}}`,
};

let cache = new Map<string, string>();

/** 启动时加载全部设置到内存 */
export async function initSettings(): Promise<void> {
  const rows = await query(`SELECT k, v FROM settings`);
  cache = new Map((rows as Array<Record<string, unknown>>).map((r) => [String(r.k), String(r.v ?? '')]));
}

/** 读设置（缺省返回默认值） */
export function getSetting(key: string): string {
  return cache.get(key) ?? DEFAULTS[key] ?? '';
}

/** 数字型设置 */
export function getSettingInt(key: string, fallback: number): number {
  const v = Number(getSetting(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * 写设置（落库 + 刷新缓存 + 留痕）。
 * @param changedBy 修改人（默认 'admin'）
 */
export async function setSetting(key: string, value: string, changedBy = 'admin'): Promise<void> {
  const old = getSetting(key);
  if (old === value) return;
  await query(
    `INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)`,
    [key, value],
  );
  if (key.startsWith('prompt_')) {
    await query(
      `INSERT INTO settings_history (k, old_v, new_v, changed_by) VALUES (?, ?, ?, ?)`,
      [key, old, value, changedBy],
    );
  }
  cache.set(key, value);
}

/** 批量更新设置（设置页保存用） */
export async function updateSettings(
  entries: Record<string, string>,
  changedBy = 'admin',
): Promise<void> {
  for (const [k, v] of Object.entries(entries)) {
    if (typeof v !== 'string') continue;
    await setSetting(k, v, changedBy);
  }
}

/** 提示词/设置修改历史（分页，最近在前） */
export async function getSettingsHistory(page = 1, pageSize = 10): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
  const pageNum = Math.max(1, Math.floor(page));
  const size = Math.min(100, Math.max(1, Math.floor(pageSize)));
  const totalRows = (await query(`SELECT COUNT(*) AS c FROM settings_history`)) as Array<Record<string, unknown>>;
  const total = Number(totalRows[0]?.c ?? 0);
  const items = (await query(
    `SELECT * FROM settings_history ORDER BY id DESC LIMIT ? OFFSET ?`,
    [size, (pageNum - 1) * size],
  )) as Array<Record<string, unknown>>;
  return { items, total };
}

/** LLM 是否已配置（任一启用模型或旧配置）——见 src/service/llm.ts 的异步实现 */

/** 返回给管理端展示的设置 */
export function settingsView(): Record<string, string> {
  const keys = [...Object.keys(DEFAULTS), ...cache.keys()];
  const out: Record<string, string> = {};
  for (const k of new Set(keys)) {
    out[k] = getSetting(k);
  }
  return out;
}
