import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { initSchema } from './db/pool.js';
import { mcpRouter } from './routes/mcp.js';
import { v2Router } from './routes/v2/index.js';
import { initNewSettings } from './service/new-settings.js';
import { startOutboxWorker } from './service/outbox-worker.js';
import { startLifecycleWorker } from './service/lifecycle.js';
import { startAttachmentScanWorker } from './service/attachment-worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const { created } = await initSchema();
  console.log(
    `✓ 新库 schema 就绪（${created.length > 0 ? `新增 ${created.length} 表：${created.join(', ')}` : '无新建表'}）`,
  );
  await initNewSettings();
  const stopWorker = startOutboxWorker({
    deliver: async (event) => {
      if (event.retention === 'notify') console.log('[outbox]', event.id, event.action);
      return { ok: true };
    },
  });
  const stopLifecycleWorker = startLifecycleWorker();
  const stopAttachmentWorker = startAttachmentScanWorker();

  const app = express();

  // 生产环境：托管前端构建产物（web/dist），SPA fallback
  // 兼容两种布局：开发 src/index.ts → ../web/dist；构建后 dist/src/index.js → ../../web/dist
  const webDistCandidates = [
    path.resolve(here, '../../web/dist'),
    path.resolve(here, '../web/dist'),
  ];
  const webDist = webDistCandidates.find((p) => existsSync(p));
  if (webDist) {
    // 静态托管：index.html 不缓存（bundle 带 hash），避免浏览器缓存旧版前端导致 UI 显示过期
    app.use(express.static(webDist, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/mcp')) {
        res.sendFile(path.join(webDist, 'index.html'));
        return;
      }
      next();
    });
  }

  app.use('/api/v2', v2Router);
  app.use(mcpRouter);

  // 全局异常保护：任何路由/异步错误不崩进程（返回 500），否则 unhandledRejection 会让 Node 直接退出
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: '服务器内部错误' });
    }
  });

  const server = app.listen(config.port, () => {
    console.log(`✓ 平台已启动: http://127.0.0.1:${config.port}`);
    console.log(`  API 端点:   http://127.0.0.1:${config.port}/api/v2`);
    console.log(`  MCP 端点:   http://127.0.0.1:${config.port}/mcp2`);
  });
  server.on('close', () => {
    stopWorker();
    stopLifecycleWorker();
    stopAttachmentWorker();
  });
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});

// 兜底：未捕获的异步异常/拒绝不崩进程（express 4 不自动捕获 async 路由 rejection）
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
