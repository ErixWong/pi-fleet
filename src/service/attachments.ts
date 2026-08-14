import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { query } from '../db.js';
import type { AgentIdentity } from '../auth.js';
import { getSetting, getSettingInt } from './settings.js';

/**
 * 附件系统（§3.7）：磁盘落盘 + DB 存元数据。
 * - 落盘：{attachments_root}/{owner_agent_id}/yyyy/mm/dd/{attachment_id}.{ext}
 * - 归属：owner 以 agent 占位账号（阶段①迁移回填 owner_account_id）；配额按 owner 算
 * - 去重：同 owner 同 sha256 复用，不占双份配额
 * - 扫描：上传 pending → 后台 clock 调 clamd（未配置降级标 skipped）
 * - 权限：下载 = owner 或 参与被引用任务者；无公开 URL
 */

export interface AttachmentView {
  attachment_id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  scan_status: 'pending' | 'clean' | 'infected' | 'skipped';
  owner_agent_id: number;
  created_at: string;
}

export interface UploadResult {
  ok: boolean;
  attachment_id?: string;
  reused?: boolean;
  error?: string;
}

function yymmddDir(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}/${p(now.getMonth() + 1)}/${p(now.getDate())}`;
}

/** 从原始文件名提取安全扩展名（小写字母数字，最长 10；无扩展名返回 ''） */
function safeExt(filename: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(filename.trim());
  return m ? m[1].toLowerCase() : '';
}

function attachmentsRoot(): string {
  return getSetting('attachments_root') || path.resolve('attachments');
}

function toView(r: Record<string, unknown>): AttachmentView {
  return {
    attachment_id: String(r.attachment_id),
    filename: String(r.filename),
    mime: String(r.mime ?? 'application/octet-stream'),
    size_bytes: Number(r.size_bytes),
    sha256: String(r.sha256),
    scan_status: (r.scan_status as AttachmentView['scan_status']) ?? 'pending',
    owner_agent_id: Number(r.owner_agent_id),
    created_at: String(r.created_at),
  };
}

export async function attachmentViewById(attachmentId: string): Promise<AttachmentView | null> {
  const rows = await query(`SELECT * FROM attachments WHERE attachment_id = ? LIMIT 1`, [attachmentId]);
  return rows.length === 0 ? null : toView(rows[0] as Record<string, unknown>);
}

/** 内部完整行（含相对路径，供落盘/删除用） */
async function attachmentRow(attachmentId: string): Promise<Record<string, unknown> | null> {
  const rows = await query(`SELECT * FROM attachments WHERE attachment_id = ? LIMIT 1`, [attachmentId]);
  return rows.length === 0 ? null : (rows[0] as Record<string, unknown>);
}

/**
 * 上传附件（MCP base64 与 REST multipart 共用）：
 * 大小校验 → sha256 去重（同 owner 复用）→ 配额校验 → 落盘 → DB 元数据（扫描状态按 clamd 配置）。
 */
export async function uploadAttachment(
  agent: AgentIdentity,
  opts: { filename: string; mime?: string; buffer: Buffer },
): Promise<UploadResult> {
  const filename = (opts.filename ?? '').trim();
  const mime = (opts.mime ?? 'application/octet-stream').trim() || 'application/octet-stream';
  const size = opts.buffer.length;
  const maxBytes = getSettingInt('max_attachment_bytes', 50 * 1024 * 1024);
  if (!filename) return { ok: false, error: '缺少 filename' };
  if (size === 0) return { ok: false, error: '附件为空' };
  if (size > maxBytes) {
    return { ok: false, error: `附件 ${size} 字节超过单文件上限 ${maxBytes} 字节` };
  }
  const sha256 = createHash('sha256').update(opts.buffer).digest('hex');

  // 同账号去重：同 hash 复用已有附件，不占双份配额
  const dup = (await query(
    `SELECT attachment_id FROM attachments WHERE owner_agent_id = ? AND sha256 = ? LIMIT 1`,
    [agent.id, sha256],
  )) as Array<Record<string, unknown>>;
  if (dup.length > 0) {
    return { ok: true, attachment_id: String(dup[0].attachment_id), reused: true };
  }

  // 配额校验：已用 + 本文件 ≤ 配额
  const quota = getSettingInt('quota_bytes', 1024 * 1024 * 1024);
  const used = (await query(
    `SELECT COALESCE(SUM(size_bytes), 0) AS used FROM attachments WHERE owner_agent_id = ?`,
    [agent.id],
  )) as Array<Record<string, unknown>>;
  const usedBytes = Number(used[0].used);
  if (usedBytes + size > quota) {
    return { ok: false, error: `配额不足：已用 ${usedBytes} 字节，配额 ${quota} 字节（需要 ${size} 字节）` };
  }

  // 落盘：{root}/{owner}/yyyy/mm/dd/{att-id}.{ext}
  const attachmentId = `att-${randomBytes(4).toString('hex')}`;
  const relDir = path.posix.join(String(agent.id), yymmddDir());
  const ext = safeExt(filename);
  const relPath = path.posix.join(relDir, `${attachmentId}${ext ? `.${ext}` : ''}`);
  const absDir = path.join(attachmentsRoot(), relDir);
  const absPath = path.join(attachmentsRoot(), relPath);
  const tmpPath = `${absPath}.tmp-${randomBytes(3).toString('hex')}`;
  await mkdir(absDir, { recursive: true });
  await writeFile(tmpPath, opts.buffer);
  await rename(tmpPath, absPath);

  // DB 元数据：clamd 未配置 → 直接 skipped（降级不阻塞）；配置了 → pending 待后台扫描
  const clamdConfigured = Boolean(getSetting('clamd_host'));
  await query(
    `INSERT INTO attachments (attachment_id, owner_agent_id, uploader_agent_id, filename, mime, size_bytes, sha256, scan_status, relative_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      attachmentId,
      agent.id,
      agent.id,
      filename,
      mime,
      size,
      sha256,
      clamdConfigured ? 'pending' : 'skipped',
      relPath,
    ],
  );
  return { ok: true, attachment_id: attachmentId };
}

/** 附件绝对路径 */
export async function attachmentAbsPath(attachmentId: string): Promise<string | null> {
  const row = await attachmentRow(attachmentId);
  if (!row) return null;
  return path.join(attachmentsRoot(), String(row.relative_path));
}

/**
 * 下载权限（§3.7 + §编排八 交付物可见性三档）：
 * - participants（默认）：owner 或 参与被引用任务者（引用即授权）
 * - public：任意已认证 agent
 * - account：阶段①账号系统落地后=同账号；当前与 participants 一致（占位）
 */
export async function canDownload(agentId: number, attachmentId: string): Promise<boolean> {
  const att = await attachmentViewById(attachmentId);
  if (!att) return false;
  if (att.owner_agent_id === agentId) return true;
  // 收集全部引用任务的交付物可见性（P2-4：多引用时档位不确定 → union 语义）
  const refs = await query(
    `SELECT t.deliverable_visibility FROM deliverables d
       JOIN tasks t ON t.id = d.task_id
      WHERE d.attachment_id = (SELECT id FROM attachments WHERE attachment_id = ?)`,
    [attachmentId],
  );
  if (refs.length === 0) return false;
  // 任一引用任务为 public → public（放行）；否则按 participants 判定
  if (refs.some((r) => String((r as Record<string, unknown>).deliverable_visibility ?? 'participants') === 'public')) {
    return true;
  }
  // account：阶段①账号系统落地后=同账号；当前无账号概念，降级为 participants（参与者可下载）
  // participants：参与被引用任务
  const part = await query(
    `SELECT t.id FROM deliverables d
       JOIN tasks t ON t.id = d.task_id
      WHERE d.attachment_id = (SELECT id FROM attachments WHERE attachment_id = ?)
        AND (t.assignee_id = ? OR t.creator_id = ?)
      LIMIT 1`,
    [attachmentId, agentId, agentId],
  );
  return part.length > 0;
}

/** 管理端直接取附件（已登录管理员） */
export async function adminAttachment(attachmentId: string): Promise<AttachmentView | null> {
  return attachmentViewById(attachmentId);
}

/**
 * 删除附件：未被任何任务引用可删（释放配额）；已被引用不可删（全程留痕优先）。
 */
export async function deleteAttachment(
  agent: AgentIdentity,
  attachmentId: string,
): Promise<{ ok: boolean; error?: string }> {
  const att = await attachmentRow(attachmentId);
  if (!att) return { ok: false, error: `附件 ${attachmentId} 不存在` };
  if (Number(att.owner_agent_id) !== agent.id) return { ok: false, error: '只能删除自己账号下的附件' };
  const refs = (await query(
    `SELECT COUNT(*) AS n FROM deliverables WHERE attachment_id = ?`,
    [att.id],
  )) as Array<Record<string, unknown>>;
  if (Number(refs[0].n) > 0) {
    return { ok: false, error: `附件已被 ${refs[0].n} 个交付物引用，不可删除（全程留痕优先）` };
  }
  const abs = path.join(attachmentsRoot(), String(att.relative_path));
  await rm(abs, { force: true }).catch(() => {});
  await query(`DELETE FROM attachments WHERE id = ?`, [att.id]);
  return { ok: true };
}

/** 清理孤儿附件（未被任何交付物引用）——管理端调用 */
export async function cleanupOrphanAttachments(): Promise<number> {
  const rows = (await query(
    `SELECT a.id, a.attachment_id, a.relative_path FROM attachments a
      LEFT JOIN deliverables d ON d.attachment_id = a.id
      WHERE d.id IS NULL`,
  )) as Array<Record<string, unknown>>;
  for (const r of rows) {
    const abs = path.join(attachmentsRoot(), String(r.relative_path));
    await rm(abs, { force: true }).catch(() => {});
    await query(`DELETE FROM attachments WHERE id = ?`, [r.id]);
  }
  return rows.length;
}

// ─────────────────────────── ClamAV 扫描（§3.7 2026-08-14 已定） ───────────────────────────

/**
 * 用 INSTREAM 协议向 clamd 发送数据扫描。
 * 返回 true=clean，false=infected；连接失败抛错（由调用方降级）。
 */
async function clamavInstreamScan(buffer: Buffer): Promise<boolean> {
  const host = getSetting('clamd_host');
  const port = getSettingInt('clamd_port', 3310);
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port }, () => {
      sock.write('zINSTREAM\0');
      // 分块发送：32bit 大端长度 + 数据，0 长度终止
      const MAX_CHUNK = 64 * 1024;
      for (let off = 0; off < buffer.length; off += MAX_CHUNK) {
        const chunk = buffer.subarray(off, off + MAX_CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length, 0);
        sock.write(len);
        sock.write(chunk);
      }
      sock.write(Buffer.from([0, 0, 0, 0]));
    });
    let resp = '';
    sock.setTimeout(15_000);
    sock.on('data', (d) => (resp += d.toString()));
    sock.on('end', () => {
      // 响应含 "stream: OK" 或 "stream: <virus> FOUND"
      resolve(!/FOUND/i.test(resp));
    });
    sock.on('timeout', () => {
      sock.destroy();
      reject(new Error('clamd 扫描超时'));
    });
    sock.on('error', (e) => {
      sock.destroy();
      reject(e);
    });
  });
}

/**
 * 后台扫描待检附件（index.ts clock 调用）：
 * 配置了 clamd → 扫描并更新 clean/infected；未配置 → 全部标 skipped（降级不阻塞）。
 */
export async function scanPendingAttachments(): Promise<{ scanned: number; skipped: number; infected: number }> {
  const rows = (await query(
    `SELECT * FROM attachments WHERE scan_status = 'pending' LIMIT 50`,
  )) as Array<Record<string, unknown>>;
  if (rows.length === 0) return { scanned: 0, skipped: 0, infected: 0 };
  const clamdHost = getSetting('clamd_host');
  let scanned = 0;
  let skipped = 0;
  let infected = 0;
  for (const r of rows) {
    if (!clamdHost) {
      await query(`UPDATE attachments SET scan_status = 'skipped' WHERE id = ?`, [r.id]);
      skipped++;
      continue;
    }
    const abs = path.join(attachmentsRoot(), String(r.relative_path));
    try {
      const { readFile } = await import('node:fs/promises');
      const data = await readFile(abs);
      const clean = await clamavInstreamScan(data);
      await query(`UPDATE attachments SET scan_status = ? WHERE id = ?`, [clean ? 'clean' : 'infected', r.id]);
      if (clean) scanned++;
      else infected++;
    } catch {
      // 扫描故障（clamd 不可达等）：不阻塞业务，保持 pending 下次重试（与 LLM 故障降级同哲学）
      // 已连续失败的留 pending，由后续 clock 轮次重试
    }
  }
  return { scanned, skipped, infected };
}
