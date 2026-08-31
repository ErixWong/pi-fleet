import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { query } from '../db.js';
import { getSetting, getSettingInt } from './settings.js';
import { recordEvent } from './events.js';

/**
 * LLM 审核/验收（§3.4 平台接 LLM）：
 * - 提供商（llm_providers）：base_url / api_key / 启用开关 在 provider 级共享，**一个 provider 对应多个 model**
 * - 模型（llm_models）：挂在 provider 下，model 即请求体 model 字段；含多模态（vision，可识图）、价格标记、启用开关
 * - 用途绑定（settings：llm_audit_model / llm_verify_model，'auto' = 有图片自动选多模态模型）
 * - 调用日志（llm_calls）：provider/模型/用途/任务/tokens/价格，成本归平台
 * - 故障降级：未配置 / 调用失败重试后仍失败 → 降级为仅程序校验放行并标记"未经 LLM 审核/验收"
 */

export interface LlmProvider {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  note: string;
  enabled: boolean;
}

export interface LlmModel {
  id: string;
  provider_id: string;
  model: string; // 请求体 model 字段
  name: string;
  vision: boolean;
  temperature: number | null; // 采样温度；null = 平台默认 1
  price: string;
  note: string;
  enabled: boolean;
}

/** 模型视图：JOIN provider 后的调用/展示信息（base_url/api_key 继承自 provider） */
export interface LlmModelView extends LlmModel {
  base_url: string;
  api_key: string;
  provider_name: string;
  provider_enabled: boolean;
}

export interface LlmVerdict {
  passed: boolean;
  reason: string;
}

/** OpenAI 兼容消息：content 可为纯文本或多模态片段数组（含 image_url） */
export type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'system' | 'user' | 'assistant'; content: (TextPart | ImagePart)[] };

interface TextPart { type: 'text'; text: string }
interface ImagePart { type: 'image_url'; image_url: { url: string } }

// ─────────────────────────── Provider 管理 ───────────────────────────

/** 全部 provider（api_key 掩码回显，仅展示用） */
export async function listProviders(): Promise<LlmProvider[]> {
  const rows = (await query(`SELECT * FROM llm_providers ORDER BY enabled DESC, name`)) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const p = toProvider(r);
    if (p.api_key) p.api_key = '******';
    return p;
  });
}

export async function getProviderById(id: string): Promise<LlmProvider | null> {
  const rows = (await query(`SELECT * FROM llm_providers WHERE id = ? LIMIT 1`, [id])) as Array<Record<string, unknown>>;
  return rows.length > 0 ? toProvider(rows[0]) : null;
}

function toProvider(r: Record<string, unknown>): LlmProvider {
  return {
    id: String(r.id),
    name: String(r.name),
    base_url: String(r.base_url),
    api_key: String(r.api_key ?? ''),
    note: String(r.note ?? ''),
    enabled: Number(r.enabled) !== 0,
  };
}

/** 新增/更新 provider（api_key 空串或 '******' = 不改，保留原值） */
export async function upsertProvider(p: Omit<LlmProvider, 'enabled'> & { enabled?: boolean }): Promise<{ ok: boolean; error?: string; id?: string }> {
  let id = (p.id ?? '').trim();
  if (!id) id = `p-${randomBytes(4).toString('hex')}`;
  else if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) return { ok: false, error: 'provider id 须为字母数字下划线（≤32）' };
  if (!p.name?.trim()) return { ok: false, error: '缺少 provider 名称' };
  if (!p.base_url?.trim()) return { ok: false, error: '缺少 Base URL' };
  const key = (p.api_key ?? '').trim();
  await query(
    `INSERT INTO llm_providers (id, name, base_url, api_key, note, enabled)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name=VALUES(name), base_url=VALUES(base_url),
       api_key=IF(VALUES(api_key)='' OR VALUES(api_key)='******', api_key, VALUES(api_key)),
       note=VALUES(note), enabled=VALUES(enabled)`,
    [id, p.name.trim(), p.base_url.trim(), key, (p.note ?? '').trim(), p.enabled === false ? 0 : 1],
  );
  return { ok: true, id };
}

/** 删除 provider（其下仍有模型时拒绝，避免孤儿模型） */
export async function deleteProvider(id: string): Promise<{ ok: boolean; error?: string }> {
  const cnt = (await query(`SELECT COUNT(*) AS c FROM llm_models WHERE provider_id = ?`, [id])) as Array<Record<string, unknown>>;
  const n = Number(cnt[0]?.c ?? 0);
  if (n > 0) return { ok: false, error: `provider「${id}」下仍有 ${n} 个模型，请先删除这些模型` };
  await query(`DELETE FROM llm_providers WHERE id = ?`, [id]);
  return { ok: true };
}

// ─────────────────────────── 模型管理 ───────────────────────────

const MODEL_JOIN = `
  SELECT m.id, m.provider_id, m.name, m.model, m.vision, m.temperature, m.price, m.note, m.enabled,
         p.base_url, p.api_key, p.name AS provider_name, p.enabled AS provider_enabled
    FROM llm_models m
    LEFT JOIN llm_providers p ON p.id = m.provider_id`;

/** 全部模型（api_key 掩码回显，仅展示用） */
export async function listModels(): Promise<LlmModelView[]> {
  const rows = (await query(`${MODEL_JOIN} ORDER BY m.enabled DESC, p.name, m.name`)) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const v = toModelView(r);
    if (v.api_key) v.api_key = '******';
    return v;
  });
}

/** 可用模型 = 模型启用 且 所属 provider 启用 */
export async function enabledModels(): Promise<LlmModelView[]> {
  const rows = (await query(
    `${MODEL_JOIN} WHERE m.enabled = 1 AND p.enabled = 1 ORDER BY p.name, m.name`,
  )) as Array<Record<string, unknown>>;
  return rows.map(toModelView);
}

/** 按 id 取模型视图（含 provider 连接，调用用真实 key） */
export async function getModelById(id: string): Promise<LlmModelView | null> {
  const rows = (await query(`${MODEL_JOIN} WHERE m.id = ? LIMIT 1`, [id])) as Array<Record<string, unknown>>;
  return rows.length > 0 ? toModelView(rows[0]) : null;
}

/** 某 provider 下的第一个模型（测试连接用；先启用后任意） */
export async function firstModelOfProvider(providerId: string): Promise<LlmModelView | null> {
  const rows = (await query(
    `${MODEL_JOIN} WHERE m.provider_id = ? ORDER BY m.enabled DESC, m.name LIMIT 1`,
    [providerId],
  )) as Array<Record<string, unknown>>;
  return rows.length > 0 ? toModelView(rows[0]) : null;
}

function toModel(r: Record<string, unknown>): LlmModel {
  return {
    id: String(r.id),
    provider_id: String(r.provider_id),
    model: String(r.model),
    name: String(r.name),
    vision: Number(r.vision) === 1,
    temperature: r.temperature === null || r.temperature === undefined ? null : Number(r.temperature),
    price: String(r.price ?? ''),
    note: String(r.note ?? ''),
    enabled: Number(r.enabled) !== 0,
  };
}

function toModelView(r: Record<string, unknown>): LlmModelView {
  return {
    ...toModel(r),
    base_url: String(r.base_url ?? ''),
    api_key: String(r.api_key ?? ''),
    provider_name: String(r.provider_name ?? ''),
    provider_enabled: Number(r.provider_enabled) === 1,
  };
}

/** LLM 是否已配置（存在 模型+provider 均启用的组合） */
export async function llmConfigured(): Promise<boolean> {
  return (await enabledModels()).length > 0;
}

/**
 * 按用途选模型：
 * - 'auto'：需要识图（hasImages）→ 优先 vision 模型；否则第一个启用模型
 * - 指定 id：取该模型（fallback auto）
 */
export async function pickModel(purpose: 'audit' | 'verify', hasImages: boolean): Promise<LlmModelView | null> {
  const models = await enabledModels();
  if (models.length === 0) return null;
  const settingKey = purpose === 'audit' ? 'llm_audit_model' : 'llm_verify_model';
  const bind = getSetting(settingKey) || 'auto';
  if (bind !== 'auto') {
    const found = models.find((m) => m.id === bind);
    if (found) {
      if (hasImages && !found.vision) {
        // 指定模型非多模态但需要识图 → 自动改选 vision 模型
        const vision = models.find((m) => m.vision);
        if (vision) return vision;
      }
      return found;
    }
  }
  if (hasImages) {
    const vision = models.find((m) => m.vision);
    if (vision) return vision;
  }
  return models[0];
}

// ─────────────────────────── Provider / 模型 CRUD ───────────────────────────

export async function upsertModel(m: Omit<LlmModel, 'enabled'> & { enabled?: boolean }): Promise<{ ok: boolean; error?: string }> {
  // id 是内部主键：新增时留空 → 自动生成随机串；显式传入（编辑路径）才校验格式
  let id = (m.id ?? '').trim();
  if (!id) id = `m-${randomBytes(4).toString('hex')}`;
  else if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) return { ok: false, error: '模型 id 须为字母数字下划线（≤32）' };
  if (!m.name?.trim()) return { ok: false, error: '缺少模型名称' };
  if (!m.model?.trim()) return { ok: false, error: '缺少模型 ID（请求体 model 字段，如 gpt-4o）' };
  const pid = (m.provider_id ?? '').trim();
  if (!pid) return { ok: false, error: '请选择所属 provider' };
  const prov = await getProviderById(pid);
  if (!prov) return { ok: false, error: `provider「${pid}」不存在` };
  // temperature：空/NaN → NULL（平台默认 1）；否则收窄到 [0,2]
  const tempRaw = Number(m.temperature);
  const temperature = Number.isFinite(tempRaw) && m.temperature !== null && String(m.temperature).trim() !== '' ? Math.min(2, Math.max(0, tempRaw)) : null;
  await query(
    `INSERT INTO llm_models (id, provider_id, name, model, vision, temperature, price, note, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE provider_id=VALUES(provider_id), name=VALUES(name), model=VALUES(model),
       vision=VALUES(vision), temperature=VALUES(temperature), price=VALUES(price), note=VALUES(note), enabled=VALUES(enabled)`,
    [id, pid, m.name.trim(), m.model.trim(), m.vision ? 1 : 0, temperature, (m.price ?? '').trim(), (m.note ?? '').trim(),
     m.enabled === false ? 0 : 1],
  );
  return { ok: true };
}

export async function deleteModel(id: string): Promise<{ ok: boolean; error?: string }> {
  await query(`DELETE FROM llm_models WHERE id = ?`, [id]);
  return { ok: true };
}

// ─────────────────────────── 调用（多模态 / 日志） ───────────────────────────

interface CallRecord {
  modelId: string;
  providerId: string;
  purpose: 'audit' | 'verify' | 'test';
  taskId: number | null;
  vision: boolean;
  price: string;
  ok: boolean;
  error: string;
  promptTokens: number;
  completionTokens: number;
}

async function recordCall(rec: CallRecord): Promise<void> {
  try {
    await query(
      `INSERT INTO llm_calls (model_id, provider_id, purpose, task_id, vision, prompt_tokens, completion_tokens, price, ok, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [rec.modelId, rec.providerId, rec.purpose, rec.taskId, rec.vision ? 1 : 0, rec.promptTokens, rec.completionTokens,
       rec.price.slice(0, 64), rec.ok ? 1 : 0, rec.error.slice(0, 255)],
    );
  } catch {
    // 日志失败不影响主流程
  }
}

/** 调用模型（OpenAI 兼容，支持多模态 content 数组）；失败抛错（由调用方降级） */
export async function chatCompletion(
  model: LlmModelView,
  messages: ChatMessage[],
  opts: { json?: boolean; purpose?: 'audit' | 'verify' | 'test'; taskId?: number | null } = {},
): Promise<string> {
  const base = model.base_url.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const body: Record<string, unknown> = {
    model: model.model,
    messages,
    // 温度：模型级可配（llm_models.temperature），未设用 1——部分中转/模型（如 kimi）仅允许 temperature=1
    temperature: model.temperature ?? 1,
    max_tokens: 1024,
  };
  // 不传 response_format：部分中转要求 prompt 必须含小写 "json" 字样才放行 json_object，否则 400；
  // 平台已用提示词约束“输出 json”，extractJson 容错解析，去掉它兼容面最大
  if (opts.json) {
    // 依赖提示词约束输出 json（审核/验收 prompt 均含“输出 json”），extractJson 容错解析
  }
  const timeoutMs = getSettingInt('llm_timeout_ms', 60_000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let record: CallRecord = {
    modelId: model.id, providerId: model.provider_id, purpose: opts.purpose ?? 'test', taskId: opts.taskId ?? null,
    vision: model.vision, price: model.price, ok: false, error: '', promptTokens: 0, completionTokens: 0,
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(model.api_key ? { authorization: `Bearer ${model.api_key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const msg = `LLM 接口 ${res.status}: ${(await res.text()).slice(0, 200)}`;
      record.error = msg;
      await recordCall(record);
      throw new Error(msg);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    record.promptTokens = Number(data.usage?.prompt_tokens ?? 0);
    record.completionTokens = Number(data.usage?.completion_tokens ?? 0);
    record.ok = true;
    await recordCall(record);
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM 返回空内容');
    return content;
  } catch (e) {
    // 网络异常/超时/解析失败：记录失败调用（成本与故障留痕）后向上抛，由调用方降级
    if (!record.ok) {
      record.error = record.error || (e instanceof Error ? e.message.slice(0, 255) : String(e));
      await recordCall(record);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 从 LLM 输出中提取 JSON（剥离 ```json 围栏与前后杂文本） */
function extractJson(raw: string): Record<string, unknown> {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text) as Record<string, unknown>;
}

/** 调用 LLM 并解析 {passed, reason}；失败抛错 */
export async function llmVerdict(
  model: LlmModelView,
  systemPrompt: string,
  userContent: string | ChatMessage['content'],
  opts: { purpose?: 'audit' | 'verify'; taskId?: number | null } = {},
): Promise<LlmVerdict> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent } as ChatMessage,
  ];
  const content = await chatCompletion(model, messages, { json: true, purpose: opts.purpose, taskId: opts.taskId });
  const parsed = extractJson(content);
  const passed = parsed.passed === true || parsed.passed === 'true';
  return { passed, reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 500) : '' };
}

/** 带重试的判决（2 次自动重试，§3.4 故障降级哲学） */
export async function llmVerdictWithRetry(
  model: LlmModelView,
  systemPrompt: string,
  userContent: string | ChatMessage['content'],
  opts: { purpose?: 'audit' | 'verify'; taskId?: number | null } = {},
  retries = 2,
): Promise<LlmVerdict> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await llmVerdict(model, systemPrompt, userContent, opts);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 提示词模板渲染（{{key}} 替换） */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

// ─────────────────────────── 审核（pending_audit 队列） ───────────────────────────

export async function scanPendingAudits(): Promise<{ audited: number; rejected: number; degraded: number }> {
  const rows = (await query(
    `SELECT * FROM tasks WHERE status = 'pending_audit' LIMIT 20`,
  )) as Array<Record<string, unknown>>;
  let audited = 0;
  let rejected = 0;
  let degraded = 0;
  const auditPrompt = getSetting('prompt_audit');
  for (const t of rows) {
    const taskId = String(t.task_id);
    const model = await pickModel('audit', false);
    if (!model) {
      await finalizeAudit(t, true, 'LLM 未配置，降级放行（未经 LLM 审核）');
      degraded++;
      audited++;
      continue;
    }
    try {
      const verdict = await llmVerdictWithRetry(
        model,
        auditPrompt,
        renderPrompt(auditPrompt, {
          title: String(t.title ?? ''),
          instruction: String(t.instruction ?? ''),
          deliverable_spec: String(t.deliverable_spec ?? '[]'),
        }),
        { purpose: 'audit', taskId: Number(t.id) },
      );
      await finalizeAudit(t, verdict.passed, verdict.reason);
      audited++;
      if (!verdict.passed) rejected++;
    } catch (e) {
      await finalizeAudit(t, true, `LLM 故障降级放行（未经 LLM 审核）：${e instanceof Error ? e.message.slice(0, 100) : '调用失败'}`);
      degraded++;
      audited++;
    }
  }
  return { audited, rejected, degraded };
}

/** 审核结论落库：通过 → private+assignee=open / public=active；不通过 → rejected（原因回帖） */
async function finalizeAudit(t: Record<string, unknown>, passed: boolean, reason: string): Promise<void> {
  const id = t.id;
  let affected = 0;
  if (passed) {
    const target = t.assignee_id !== null ? 'open' : 'active';
    const updated = await query(`UPDATE tasks SET status = ? WHERE id = ? AND status = 'pending_audit'`, [target, id]);
    affected = (updated as { affectedRows?: number }).affectedRows ?? 0;
  } else {
    const updated = await query(`UPDATE tasks SET status = 'rejected' WHERE id = ? AND status = 'pending_audit'`, [id]);
    affected = (updated as { affectedRows?: number }).affectedRows ?? 0;
  }
  // 并发保护：UPDATE 未命中（0 行）说明已被另一扫描处理过，不再重复回帖
  if (affected === 0) return;
  await query(
    `INSERT INTO task_messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'platform', 'verdict', ?)`,
    [id, passed ? `[LLM 审核通过] ${reason}` : `[LLM 审核未通过] ${reason}（请用 task(revise) 修订后重新提交审核）`],
  );
  await recordEvent(passed ? 'task.audit_passed' : 'task.audit_rejected', {
    actor: 'system',
    ref_task: id as string | number,
    summary: passed ? `LLM 审核通过任务 ${String(t.task_id)}` : `LLM 审核拒绝任务 ${String(t.task_id)}`,
  });
}

// ─────────────────────────── 验收（submitted 队列，支持识图） ───────────────────────────

/** 收集交付物内容（§3.7 读取边界）：文本读前 N 字节；图片走多模态（base64）；其他二进制只列类型 */
async function collectDeliverables(
  taskId: number,
  maxRead: number,
): Promise<{ text: string; images: { name: string; dataBase64: string; mime: string }[]; binaryCount: number }> {
  const rows = (await query(
    `SELECT d.name, d.version, a.attachment_id, a.filename, a.mime, a.size_bytes, a.relative_path
       FROM deliverables d
       LEFT JOIN attachments a ON a.id = d.attachment_id
      WHERE d.task_id = ? AND d.current = TRUE ORDER BY d.name`,
    [taskId],
  )) as Array<Record<string, unknown>>;
  const textParts: string[] = [];
  const images: { name: string; dataBase64: string; mime: string }[] = [];
  let binaryCount = 0;
  for (const r of rows) {
    if (r.attachment_id === null) {
      textParts.push(`- ${r.name}@${r.version}：无附件（仅路径 ${r.path ?? ''}）`);
      continue;
    }
    const mime = String(r.mime ?? '');
    const abs = path.join(getSetting('attachments_root'), String(r.relative_path));
    // SVG 是矢量文本（XML），LLM 多模态接口不认（cannot identify image file），按文本读取
    const isSvg = mime === 'image/svg+xml';
    // 图片：读入内存（多模态识图），限制数量与大小
    if (mime.startsWith('image/') && !isSvg) {
      if (images.length >= 5) {
        textParts.push(`- ${r.name}@${r.version}：图片 ${r.filename}（超出识图数量上限 5，仅列存在）`);
        continue;
      }
      try {
        const data = await readFile(abs);
        if (data.length > 2 * 1024 * 1024) {
          textParts.push(`- ${r.name}@${r.version}：图片 ${r.filename}（>2MB 跳过识图，仅列存在）`);
          continue;
        }
        images.push({ name: `${r.filename} (${r.name}@${r.version})`, dataBase64: data.toString('base64'), mime });
      } catch {
        textParts.push(`- ${r.name}@${r.version}：图片 ${r.filename}（读取失败）`);
      }
      continue;
    }
    const textLike =
      mime.startsWith('text/') ||
      isSvg ||
      ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/markdown', 'application/javascript'].includes(mime);
    if (!textLike) {
      textParts.push(`- ${r.name}@${r.version}：二进制附件 ${r.filename}（${mime}，${r.size_bytes} 字节，只验存在性与类型）`);
      binaryCount++;
      continue;
    }
    let content = '';
    try {
      const data = await readFile(abs);
      content = data.subarray(0, maxRead).toString('utf8');
    } catch {
      content = '(附件文件读取失败)';
    }
    const truncated = Number(r.size_bytes ?? 0) > maxRead ? `（已截断至前 ${maxRead} 字节）` : '';
    textParts.push(`--- ${r.name}@${r.version}（${r.filename}）${truncated} ---\n${content}`);
  }
  return { text: textParts.join('\n\n'), images, binaryCount };
}

/** 组装验收用户内容：文本 + 图片（多模态） */
function buildVerifyUserContent(
  verifyPrompt: string,
  vars: Record<string, string>,
  images: { name: string; dataBase64: string; mime: string }[],
): ChatMessage['content'] {
  const text = renderPrompt(verifyPrompt, vars);
  if (images.length === 0) return text;
  const parts: (TextPart | ImagePart)[] = [{ type: 'text', text }];
  for (const img of images) {
    parts.push({ type: 'text', text: `（图片：${img.name}）` });
    parts.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.dataBase64}` } });
  }
  return parts;
}

export async function scanPendingVerifications(): Promise<{ verified: number; passed: number; failed: number; degraded: number }> {
  const rows = (await query(
    `SELECT * FROM tasks WHERE status = 'submitted' LIMIT 20`,
  )) as Array<Record<string, unknown>>;
  let verified = 0;
  let passed = 0;
  let failed = 0;
  let degraded = 0;
  const verifyPrompt = getSetting('prompt_verify');
  for (const t of rows) {
    const id = Number(t.id);
    const maxRead = getSettingInt('llm_verifier_read_bytes', 64 * 1024);
    const collected = await collectDeliverables(id, maxRead);
    const hasImages = collected.images.length > 0;
    const model = await pickModel('verify', hasImages);
    if (!model) {
      await finalizeVerification(t, true, 'LLM 未配置，降级放行（未经 LLM 验收）');
      degraded++;
      verified++;
      continue;
    }
    try {
      const userContent = buildVerifyUserContent(verifyPrompt, {
        title: String(t.title ?? ''),
        instruction: String(t.instruction ?? ''),
        deliverable_spec: String(t.deliverable_spec ?? '[]'),
        deliverables_text: collected.text.slice(0, 200_000),
      }, collected.images);
      const verdict = await llmVerdictWithRetry(
        model,
        verifyPrompt,
        userContent,
        { purpose: 'verify', taskId: id },
      );
      await finalizeVerification(t, verdict.passed, verdict.reason);
      verified++;
      if (verdict.passed) passed++;
      else failed++;
    } catch (e) {
      await finalizeVerification(t, true, `LLM 故障降级放行（未经 LLM 验收）：${e instanceof Error ? e.message.slice(0, 100) : '调用失败'}`);
      degraded++;
      verified++;
    }
  }
  return { verified, passed, failed, degraded };
}

/** 验收结论落库：通过 → pending_confirm；不通过 → claimed 续做（attempts+1，超上限 failed） */
async function finalizeVerification(t: Record<string, unknown>, passed: boolean, reason: string): Promise<void> {
  const id = t.id;
  if (passed) {
    const updated = await query(`UPDATE tasks SET status = 'pending_confirm' WHERE id = ? AND status = 'submitted'`, [id]);
    // 并发保护：UPDATE 未命中（0 行）说明已被另一扫描处理过，不再重复回帖
    if ((updated as { affectedRows?: number }).affectedRows === 0) return;
    await query(
      `INSERT INTO task_messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'platform', 'verdict', ?)`,
      [id, `[LLM 验收通过] ${reason}`],
    );
    await recordEvent('task.verify_passed', {
      actor: 'system',
      ref_task: id as string | number,
      summary: `LLM 验收通过任务 ${String(t.task_id)}`,
    });
    return;
  }
  const attempts = Number(t.deliver_attempts) + 1;
  const maxAttempts = Number(t.max_attempts) || 3;
  const note = `[LLM 验收未通过] ${reason}`;
  if (attempts >= maxAttempts) {
    const updated = await query(`UPDATE tasks SET status='failed', deliver_attempts=? WHERE id = ? AND status = 'submitted'`, [attempts, id]);
    if ((updated as { affectedRows?: number }).affectedRows === 0) return;
    await query(
      `INSERT INTO task_messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'platform', 'verdict', ?)`,
      [id, `${note}（第 ${attempts}/${maxAttempts} 次，已达上限，任务失败）`],
    );
    await recordEvent('task.failed', {
      actor: 'system',
      ref_task: id as string | number,
      summary: `LLM 验收拒绝任务 ${String(t.task_id)}，达到尝试上限并失败`,
    });
  } else {
    const updated = await query(`UPDATE tasks SET status='claimed', deliver_attempts=? WHERE id = ? AND status = 'submitted'`, [attempts, id]);
    if ((updated as { affectedRows?: number }).affectedRows === 0) return;
    await query(
      `INSERT INTO task_messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'platform', 'verdict', ?)`,
      [id, `${note}（第 ${attempts}/${maxAttempts} 次，请按原因续做；任务目录保留=工作现场保留）`],
    );
    await recordEvent('task.verify_rejected', {
      actor: 'system',
      ref_task: id as string | number,
      summary: `LLM 验收拒绝任务 ${String(t.task_id)}，回到 claimed 续做`,
    });
  }
}

/**
 * 测试 LLM 连接（不落库配置）：
 * - model_id：测试指定模型（含 provider 连接）
 * - provider_id + model：临时测试该 provider 下一个未保存的模型串（新增模型表单用）
 * - provider_id：测试该 provider 下第一个模型
 * - 都不传：测试第一个可用模型
 */
export async function testLlmConnection(
  opts: { model_id?: string; provider_id?: string; model?: string } = {},
): Promise<{ ok: boolean; detail: string }> {
  let view: LlmModelView | null = null;
  if (opts.model_id) {
    view = await getModelById(opts.model_id);
    if (!view) return { ok: false, detail: `模型「${opts.model_id}」不存在` };
  } else if (opts.provider_id) {
    const prov = await getProviderById(opts.provider_id);
    if (!prov) return { ok: false, detail: `provider「${opts.provider_id}」不存在` };
    if (opts.model?.trim()) {
      view = {
        id: '(adhoc)', provider_id: prov.id, model: opts.model.trim(), name: prov.name,
        vision: false, temperature: null, price: '', note: '', enabled: true,
        base_url: prov.base_url, api_key: prov.api_key, provider_name: prov.name, provider_enabled: prov.enabled,
      };
    } else {
      view = await firstModelOfProvider(prov.id);
      if (!view) return { ok: false, detail: `provider「${prov.name}」下还没有模型，请先添加模型再测试` };
    }
  } else {
    view = (await enabledModels())[0] ?? null;
  }
  if (!view) return { ok: false, detail: '未配置可用模型：请先在 LLM 设置里添加 provider 与模型' };
  try {
    const reply = await chatCompletion(view, [{ role: 'user', content: '只回复两个字：正常' }], { purpose: 'test' });
    return { ok: true, detail: `「${view.provider_name}/${view.name}」连接成功：${reply.slice(0, 80)}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** 调用日志（分页，JOIN provider 名） */
export async function listLlmCalls(page = 1, pageSize = 10): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
  const pageNum = Math.max(1, Math.floor(page));
  const size = Math.min(100, Math.max(1, Math.floor(pageSize)));
  const totalRows = (await query(`SELECT COUNT(*) AS c FROM llm_calls`)) as Array<Record<string, unknown>>;
  const total = Number(totalRows[0]?.c ?? 0);
  const items = (await query(
    `SELECT c.*, p.name AS provider_name
       FROM llm_calls c
       LEFT JOIN llm_providers p ON p.id = c.provider_id
      ORDER BY c.id DESC LIMIT ? OFFSET ?`,
    [size, (pageNum - 1) * size],
  )) as Array<Record<string, unknown>>;
  return { items, total };
}
