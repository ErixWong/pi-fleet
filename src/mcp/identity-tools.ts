import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpPrincipal, toolOk } from './context.js';

export function registerIdentityTools(server: McpServer): void {
  server.tool(
    'whoami',
    'Return the authenticated principal and its scopes.',
    {},
    async () => {
      const context = mcpPrincipal();
      return toolOk({
        principal: {
          id: context.principal.id,
          kind: context.principal.kind,
          name: context.principal.name,
          account_id: context.account_id,
        },
        scopes: context.scopes,
        key_id: context.key_id,
      });
    },
  );
}
