import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import type { Response } from 'express';
import multer from 'multer';
import { principalAuthMiddleware, requirePrincipal, requireScope } from '../../auth-principal.js';
import {
  canReadAttachment,
  createAttachment,
  getAttachment,
  softDeleteAttachment,
} from '../../service/resources.js';

export const attachmentsV2Router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function sendAttachmentFile(
  res: Response,
  absPath: string,
  originalName: string,
  mime: string,
): void {
  const textLike =
    mime.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/markdown', 'application/javascript', 'application/x-sh'].includes(mime);
  const disposition = textLike ? 'inline' : 'attachment';
  const contentType = textLike ? `${mime || 'text/plain'}; charset=utf-8` : mime || 'application/octet-stream';
  const safeName = path.basename(originalName).replace(/[^\x20-\x7E\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF.\-]/g, '_');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
  );
  res.sendFile(absPath, (error) => {
    if (error && !res.headersSent) res.status(404).json({ error: '附件文件缺失' });
  });
}

function attachmentRoot(): string {
  return path.resolve(process.env.ATTACHMENTS_ROOT ?? path.resolve(process.cwd(), 'attachments'));
}

function safeAttachmentPath(root: string, relativePath: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    return null;
  }
  return resolvedPath;
}

attachmentsV2Router.post(
  '/',
  principalAuthMiddleware(),
  requireScope('attachment:write'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const file = req.file;
      if (!file || file.size === 0) {
        res.status(400).json({ error: 'file is required and cannot be empty' });
        return;
      }
      const sha256 = createHash('sha256').update(file.buffer).digest('hex');
      const date = new Date();
      const pad = (value: number) => String(value).padStart(2, '0');
      const datePath = `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
      const extension = /\.([A-Za-z0-9]{1,10})$/.exec(file.originalname.trim())?.[1].toLowerCase() ?? '';
      const relativePath = path.posix.join(
        context.principal.id,
        datePath,
        `${sha256}${extension ? `.${extension}` : ''}`,
      );
      const root = attachmentRoot();
      const filePath = safeAttachmentPath(root, relativePath);
      if (!filePath) {
        res.status(400).json({ error: 'invalid attachment path' });
        return;
      }
      const created = await createAttachment({
        account_id: context.account_id,
        owner_principal_id: context.principal.id,
        filename: file.originalname,
        mime: file.mimetype,
        size_bytes: file.size,
        sha256,
        relative_path: relativePath,
      });
      if (!created.deduped) {
        try {
          await mkdir(path.dirname(filePath), { recursive: true });
          await writeFile(filePath, file.buffer);
        } catch (error) {
          await softDeleteAttachment(created.attachment.id);
          throw error;
        }
      }
      res.status(201).json({
        ok: true,
        attachment_id: created.attachment.id,
        reused: created.deduped,
      });
    } catch (error) {
      next(error);
    }
  },
);

attachmentsV2Router.get(
  '/:id',
  principalAuthMiddleware(),
  requireScope('attachment:read'),
  async (req, res, next) => {
    try {
      const context = requirePrincipal();
      const attachment = await getAttachment(req.params.id);
      if (!attachment || attachment.deleted_at || attachment.account_id !== context.account_id) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (!await canReadAttachment(attachment, context.principal.id)) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (attachment.scan_status === 'infected') {
        res.status(405).json({ error: 'attachment is infected' });
        return;
      }
      const filePath = safeAttachmentPath(attachmentRoot(), attachment.relative_path);
      if (!filePath) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      sendAttachmentFile(res, filePath, attachment.filename, attachment.mime);
    } catch (error) {
      next(error);
    }
  },
);
