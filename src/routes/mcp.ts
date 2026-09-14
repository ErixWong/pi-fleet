import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../mcp/tools.js';
import { createMcpServerV2 } from '../mcp/index.js';
import { mcpAuthMiddleware } from '../auth.js';
import { principalAuthMiddleware } from '../auth-principal.js';
import { requireNewDb } from '../db/pool.js';

export const mcpRouter = Router();

// Streamable HTTP 是有状态协议：initialize 建立会话后，后续请求携带
// Mcp-Session-Id 必须路由回同一个 transport。SDK 1.30 的 Server.connect()
// 仅支持单 transport，因此每个会话持有独立的 { server, transport }。
const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

mcpRouter.post('/mcp', mcpAuthMiddleware, async (req, res) => {
  const header = req.headers['mcp-session-id'];
  const sessionId = Array.isArray(header) ? header[0] : (header as string | undefined);

  let session = sessionId ? sessions.get(sessionId) : undefined;

  if (!session) {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };
    session = { server, transport };
    await server.connect(transport);
  }

  await session.transport.handleRequest(req, res);

  // initialize 完成后 sessionId 才生成，此时注册会话，后续请求才能命中
  if (session.transport.sessionId && !sessions.has(session.transport.sessionId)) {
    sessions.set(session.transport.sessionId, session);
  }
});

// 其余方法暂不支持
mcpRouter.get('/mcp', (_req, res) =>
  res.status(405).json({ error: 'use POST /mcp (Streamable HTTP)' }),
);
mcpRouter.delete('/mcp', (_req, res) =>
  res.status(405).json({ error: 'use POST /mcp (Streamable HTTP)' }),
);

const sessionsV2 = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

mcpRouter.post('/mcp2', requireNewDb, principalAuthMiddleware(), async (req, res) => {
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

mcpRouter.get('/mcp2', requireNewDb, (_req, res) =>
  res.status(405).json({ error: 'use POST /mcp2 (Streamable HTTP)' }),
);
mcpRouter.delete('/mcp2', requireNewDb, (_req, res) =>
  res.status(405).json({ error: 'use POST /mcp2 (Streamable HTTP)' }),
);
