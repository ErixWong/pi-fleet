import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { query } from '../db.js';
import { getSetting, getSettingInt } from './settings.js';

/**
 * LLM 审核/验收（§3.4 平台接 LLM）：
 * - 多模型（llm_models 表）：每个模型有 base_url/model/key、多模态能力（vision，可识图）、价格标记、启用开关
 * - 用途绑定（settings：llm_audit_model / llm_verify_model，'auto' = 有图片自动选多模态模型）
 * - 调用日志（llm_calls）：模型/用途/任务/tokens/价格，成本归平台
 * - 故障降级：未配置 / 调用失败重试后仍失败 → 降级为仅程序校验放行并标记"未经 LLM 审核/验收"
 */

export interface LlmModel {
  id: string;
  name: string;
  base_url: string;
  model: string;
  api_key: string;
  vision: boolean;
  price: string;
  note: string;
  enabled: boolean;
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

// ─────────────────────────── 模型管理 ───────────────────────────

/** 全部模型（含禁用） */
export async function listModels(): Promise<LlmModel[]> {
  const rows = (await query(`SELECT * FROM llm_models ORDER BY enabled DESC, name`)) as Array<Record<string, unknown>>;
  return rows.map(toModel);
}

/** 启用模型；空表 → 回退旧单模型配置（llm_base_url/llm_model）作为 default */
export async function enabledModels(): Promise<LlmModel[]> {
  const rows = (await query(
    `SELECT * FROM llm_models WHERE enabled = 1 ORDER BY name`,
  )) as Array<Record<string, unknown>>;
  if (rows.length > 0) return rows.map(toModel);
  const base = getSetting('llm_base_url');
  const model = getSetting('llm_model');
  if (base && model) {
    return [{
      id: 'default', name: '默认模型', base_url: base, model,
      api_key: getSetting('llm_api_key'), vision: false,
      price: '', note: '兼容旧配置', enabled: true,
    }];
  }
  return [];
}

function toModel(r: Record<string, unknown>): LlmModel {
  return {
    id: String(r.id),
    name: String(r.name),
    base_url: String(r.base_url),
    model: String(r.model),
    api_key: String(r.api_key ?? ''),
    vision: Number(r.vision) === 1,
    price: String(r.price ?? ''),
    note: String(r.note ?? ''),
    enabled: Number(r.enabled) !== 0,
  };
}

/** LLM 是否已配置（任一启用模型或旧配置） */
export async function llmConfigured(): Promise<boolean> {
  return (await enabledModels()).length > 0;
}

/** 按 id 取模型（不校验启用） */
export async function getModelById(id: string): Promise<LlmModel | null> {
  const rows = (await query(`SELECT * FROM llm_models WHERE id = ? LIMIT 1`, [id])) as Array<Record<string, unknown>>;
  if (rows.length > 0) return toModel(rows[0]);
  // 兼容旧配置 default
  const models = await enabledModels();
  return models.find((m) => m.id === id) ?? null;
}

/**
 * 按用途选模型：
 * - 'auto'：需要识图（hasImages）→ 优先 vision 模型；否则第一个启用模型
 * - 指定 id：取该模型（fallback auto）
 */
export async function pickModel(purpose: 'audit' | 'verify', hasImages: boolean): Promise<LlmModel | null> {
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

// ─────────────────────────── 模型 CRUD（设置页） ───────────────────────────

export async function upsertModel(m: Omit<LlmModel, 'enabled'> & { enabled?: boolean }): Promise<{ ok: boolean; error?: string }> {
  const id = (m.id ?? '').trim();
  if (!id || !/^[a-zA-Z0-9_-]{1,32}$/.test(id)) return { ok: false, error: '模型 id 须为字母数字下划线（≤32）' };
  if (!m.name?.trim()) return { ok: false, error: '缺少模型名称' };
  if (!m.base_url?.trim() || !m.model?.trim()) return { ok: false, error: '缺少 base_url 或 model' };
  await query(
    `INSERT INTO llm_models (id, name, base_url, model, api_key, vision, price, note, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name=VALUES(name), base_url=VALUES(base_url), model=VALUES(model),
       api_key=IF(VALUES(api_key)='', api_key, VALUES(api_key)), vision=VALUES(vision),
       price=VALUES(price), note=VALUES(note), enabled=VALUES(enabled)`,
    [id, m.name.trim(), m.base_url.trim(), m.model.trim(), (m.api_key ?? '').trim(),
     m.vision ? 1 : 0, (m.price ?? '').trim(), (m.note ?? '').trim(), m.enabled === false ? 0 : 1],
  );
  return { ok: true };
}

export async function deleteModel(id: string): Promise<{ ok: boolean; error?: string }> {
  if (id === 'default') return { ok: false, error: '默认模型不可删除（可禁用）' };
  await query(`DELETE FROM llm_models WHERE id = ?`, [id]);
  return { ok: true };
}

// ─────────────────────────── 调用（多模态 / 日志） ───────────────────────────

interface CallRecord {
  modelId: string;
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
      `INSERT INTO llm_calls (model_id, purpose, task_id, vision, prompt_tokens, completion_tokens, price, ok, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [rec.modelId, rec.purpose, rec.taskId, rec.vision ? 1 : 0, rec.promptTokens, rec.completionTokens,
       rec.price.slice(0, 64), rec.ok ? 1 : 0, rec.error.slice(0, 255)],
    );
  } catch {
    // 日志失败不影响主流程
  }
}

/** 调用模型（OpenAI 兼容，支持多模态 content 数组）；失败抛错（由调用方降级） */
export async function chatCompletion(
  model: LlmModel,
  messages: ChatMessage[],
  opts: { json?: boolean; purpose?: 'audit' | 'verify' | 'test'; taskId?: number | null } = {},
): Promise<string> {
  const base = model.base_url.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const body: Record<string, unknown> = {
    model: model.model,
    messages,
    temperature: 0.2,
    max_tokens: 1024,
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  const timeoutMs = getSettingInt('llm_timeout_ms', 60_000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let record: CallRecord = {
    modelId: model.id, purpose: opts.purpose ?? 'test', taskId: opts.taskId ?? null,
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
  model: LlmModel,
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
  model: LlmModel,
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
  if (passed) {
    const target = t.assignee_id !== null ? 'open' : 'active';
    await query(`UPDATE tasks SET status = ? WHERE id = ? AND status = 'pending_audit'`, [target, id]);
  } else {
    await query(`UPDATE tasks SET status = 'rejected' WHERE id = ? AND status = 'pending_audit'`, [id]);
  }
  await query(
    `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'platform', 'verdict', ?)`,
    [id, passed ? `[LLM 审核通过] ${reason}` : `[LLM 审核未通过] ${reason}（请用 task(revise) 修订后重新提交审核）`],
  );
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
    // 图片：读入内存（多模态识图），限制数量与大小
    if (mime.startsWith('image/')) {
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
    await query(`UPDATE tasks SET status = 'pending_confirm' WHERE id = ? AND status = 'submitted'`, [id]);
    await query(
      `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'platform', 'verdict', ?)`,
      [id, `[LLM 验收通过] ${reason}`],
    );
    return;
  }
  const attempts = Number(t.deliver_attempts) + 1;
  const maxAttempts = Number(t.max_attempts) || 3;
  const note = `[LLM 验收未通过] ${reason}`;
  if (attempts >= maxAttempts) {
    await query(`UPDATE tasks SET status='failed', deliver_attempts=? WHERE id = ? AND status = 'submitted'`, [attempts, id]);
    await query(
      `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'platform', 'verdict', ?)`,
      [id, `${note}（第 ${attempts}/${maxAttempts} 次，已达上限，任务失败）`],
    );
  } else {
    await query(`UPDATE tasks SET status='claimed', deliver_attempts=? WHERE id = ? AND status = 'submitted'`, [attempts, id]);
    await query(
      `INSERT INTO messages (task_id, sender_id, sender_role, type, content) VALUES (?, NULL, 'platform', 'verdict', ?)`,
      [id, `${note}（第 ${attempts}/${maxAttempts} 次，请按原因续做；任务目录保留=工作现场保留）`],
    );
  }
}

/** 测试模型连接（设置页"测试连接"按钮） */
export async function testLlmConnection(modelId?: string): Promise<{ ok: boolean; detail: string }> {
  const model = modelId ? await getModelById(modelId) : (await enabledModels())[0];
  if (!model) return { ok: false, detail: '未配置可用模型（模型管理里添加，或填 base_url/model）' };
  try {
    const reply = await chatCompletion(model, [{ role: 'user', content: '只回复两个字：正常' }], { purpose: 'test' });
    return { ok: true, detail: `模型「${model.name}」连接成功：${reply.slice(0, 80)}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** 调用日志（最近 N 条） */
export async function listLlmCalls(limit = 50): Promise<Array<Record<string, unknown>>> {
  return query(`SELECT * FROM llm_calls ORDER BY id DESC LIMIT ?`, [limit]);
}
