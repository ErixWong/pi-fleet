import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerIdentityTools } from './identity-tools.js';
import { registerPostTools } from './post-tools.js';
import { registerResourceTools } from './resource-tools.js';
import { registerTaskTools } from './task-tools.js';

export function createMcpServerV2(): McpServer {
  const server = new McpServer(
    { name: 'task-dispatch-v2', version: '0.3.0' },
    { capabilities: { tools: {} } },
  );
  registerIdentityTools(server);
  registerPostTools(server);
  registerTaskTools(server);
  registerResourceTools(server);
  return server;
}
