import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  canReadAttachment,
  createAttachment,
  getAttachment,
  softDeleteAttachment,
} from '../service/resources.js';
import {
  mcpPrincipal,
  guardScope,
  toolFailure,
  toolOk,
  toolErr,
  type ToolResult,
} from './context.js';

export function registerResourceTools(server: McpServer): void {
  server.tool(
    'attachment',
    'Read attachment metadata or upload a small attachment.',
    {
      action: z.string(),
      attachment_id: z.string().min(1).optional(),
      filename: z.string().optional(),
      mime: z.string().optional(),
      data_base64: z.string().optional(),
    },
    async (args): Promise<ToolResult> => {
      try {
        const context = mcpPrincipal();
        if (args.action === 'upload') {
          guardScope('attachment:write');
          if (!args.filename || !args.data_base64) {
            return toolErr('filename and data_base64 are required');
          }
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data_base64)) {
            return toolErr('data_base64 is invalid');
          }
          const buffer = Buffer.from(args.data_base64, 'base64');
          if (buffer.length === 0) return toolErr('attachment is empty');
          if (buffer.length > 5 * 1024 * 1024) {
            return toolErr('attachment exceeds 5MB');
          }
          const sha256 = createHash('sha256').update(buffer).digest('hex');
          const date = new Date();
          const pad = (value: number) => String(value).padStart(2, '0');
          const datePath = `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
          const extension = /\.([A-Za-z0-9]{1,10})$/.exec(args.filename.trim())?.[1].toLowerCase() ?? '';
          const relativePath = path.posix.join(
            context.principal.id,
            datePath,
            `${sha256}${extension ? `.${extension}` : ''}`,
          );
          const attachmentRoot = path.resolve(
            process.env.ATTACHMENTS_ROOT ?? path.resolve(process.cwd(), 'attachments'),
          );
          const attachmentPath = path.resolve(attachmentRoot, relativePath);
          const created = await createAttachment({
            account_id: context.account_id,
            owner_principal_id: context.principal.id,
            filename: args.filename.trim(),
            mime: args.mime?.trim() ?? '',
            size_bytes: buffer.length,
            sha256,
            relative_path: relativePath,
          });
          if (!created.deduped) {
            try {
              await mkdir(path.dirname(attachmentPath), { recursive: true });
              await writeFile(attachmentPath, buffer);
            } catch (error) {
              await softDeleteAttachment(created.attachment.id);
              throw error;
            }
          }
          return toolOk({
            ok: true,
            attachment_id: created.attachment.id,
            reused: created.deduped,
          });
        }
        if (args.action !== 'read') return toolErr(`unknown action: ${args.action}`);
        guardScope('attachment:read');
        if (!args.attachment_id) return toolErr('attachment_id is required');
        const attachment = await getAttachment(args.attachment_id);
        if (!attachment || attachment.deleted_at || attachment.account_id !== context.account_id) {
          return toolErr('not found');
        }
        if (!await canReadAttachment(attachment, context.principal.id)) {
          return toolErr('not found');
        }
        return toolOk({
          attachment: {
            id: attachment.id,
            filename: attachment.filename,
            mime: attachment.mime,
            size_bytes: attachment.size_bytes,
            sha256: attachment.sha256,
            scan_status: attachment.scan_status,
            created_at: attachment.created_at,
          },
          download_hint: `GET /api/v2/attachments/${attachment.id} (Bearer)`,
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
