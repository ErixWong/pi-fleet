import path from 'node:path';
import { Router } from 'express';
import { principalAuthMiddleware, requirePrincipal, requireScope } from '../../auth-principal.js';
import { getAttachment } from '../../service/resources.js';
import { sendAttachmentFile } from '../attach-shared.js';

export const attachmentsV2Router = Router();

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
