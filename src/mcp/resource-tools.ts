import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAttachment } from '../service/resources.js';
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
    'Read attachment metadata. This read-only batch supports read only.',
    {
      action: z.literal('read'),
      attachment_id: z.string().min(1),
    },
    async ({ attachment_id }): Promise<ToolResult> => {
      try {
        guardScope('attachment:read');
        const context = mcpPrincipal();
        const attachment = await getAttachment(attachment_id);
        if (!attachment || attachment.deleted_at || attachment.account_id !== context.account_id) {
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
