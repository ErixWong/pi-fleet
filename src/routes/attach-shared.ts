import type { Response } from 'express';
import path from 'node:path';

/**
 * 附件发送助手（agent 与管理端共用）：
 * - 文本类 mime 内联（预览），其余 Content-Disposition: attachment（还原原始文件名）
 * - 文件名经 filename* RFC5987 UTF-8 编码，中文安全
 */
export function sendAttachmentFile(
  res: Response,
  absPath: string,
  originalName: string,
  mime: string,
): void {
  const textLike =
    mime.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/markdown', 'application/javascript', 'application/x-sh'].includes(mime);
  const disposition = textLike ? 'inline' : 'attachment';
  // 文本类必须带 charset=utf-8，否则浏览器按本地系统编码（如 GBK）解析 UTF-8 中文 → 乱码
  const contentType = textLike ? `${mime || 'text/plain'}; charset=utf-8` : mime || 'application/octet-stream';
  const safeName = path.basename(originalName).replace(/[^\x20-\x7E\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF.\-]/g, '_');
  res.setHeader('Content-Type', contentType);
  // 附件是权限敏感数据（owner/参与人），且修复过 charset——禁止缓存，避免浏览器沿用旧响应（304/乱码）
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
  );
  res.sendFile(absPath, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: '附件文件缺失' });
    }
  });
}
