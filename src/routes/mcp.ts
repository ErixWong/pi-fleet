import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServerV2 } from '../mcp/index.js';
import { principalAuthMiddleware } from '../auth-principal.js';

export const mcpRouter = Router();

const sessionsV2 = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

mcpRouter.post('/mcp2', principalAuthMiddleware(), async (req, res) => {
  const header = req.headers['mcp-session-id'];
  const sessionId = Array.isArray(header) ? header[0] : (header as string | undefined);

  let session = sessionId ? sessionsV2.get(sessionId) : undefined;

  if (!session) {
    const server = createMcpServerV2();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessionsV2.delete(sid);
    };
    session = { server, transport };
    await server.connect(transport);
  }

  await session.transport.handleRequest(req, res);

  if (session.transport.sessionId && !sessionsV2.has(session.transport.sessionId)) {
    sessionsV2.set(session.transport.sessionId, session);
  }
});

mcpRouter.get('/mcp2', (_req, res) =>
  res.status(405).json({ error: 'use POST /mcp2 (Streamable HTTP)' }),
);
mcpRouter.delete('/mcp2', (_req, res) =>
  res.status(405).json({ error: 'use POST /mcp2 (Streamable HTTP)' }),
);
