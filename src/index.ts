import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { config } from './config.js';
import { initDb } from './db.js';
import { apiRouter } from './routes/api.js';
import { mcpRouter } from './routes/mcp.js';
import { agentRouter } from './routes/agent.js';
import { recoverStaleRunningTasks } from './scheduler.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  await initDb();
  console.log('✓ 数据库 schema 就绪');

  const app = express();
  // 注意：不全局挂 body parser——MCP transport 需要读取原始 body 流，
  // /mcp 由 StreamableHTTPServerTransport 自行解析；JSON parser 挂载在 apiRouter 上
  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 7 * 24 * 3600 * 1000 },
    }),
  );

  // 生产环境：托管前端构建产物（web/dist），SPA fallback
  // 兼容两种布局：开发 src/index.ts → ../web/dist；构建后 dist/src/index.js → ../../web/dist
  const webDistCandidates = [
    path.resolve(here, '../../web/dist'),
    path.resolve(here, '../web/dist'),
  ];
  const webDist = webDistCandidates.find((p) => existsSync(p));
  if (webDist) {
    app.use(express.static(webDist));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/mcp')) {
        res.sendFile(path.join(webDist, 'index.html'));
        return;
      }
      next();
    });
  }

  app.use('/api', apiRouter);
  app.use('/api/agent', agentRouter);
  app.use(mcpRouter);

  app.listen(config.port, () => {
    console.log(`✓ 平台已启动: http://127.0.0.1:${config.port}`);
    console.log(`  API 端点:   http://127.0.0.1:${config.port}/api`);
    console.log(`  MCP 端点:   http://127.0.0.1:${config.port}/mcp`);
  });

  // 超时回收：每小时清理"认领后 2h 无活动"的 running 任务（长任务靠 report_progress 续期）
  const RECOVER_INTERVAL_MS = 60 * 60 * 1000;
  setInterval(() => {
    recoverStaleRunningTasks(2)
      .then((n) => {
        if (n > 0) console.log(`[recover] 超时回收 ${n} 个任务`);
      })
      .catch((err) => console.error('[recover] 失败:', err));
  }, RECOVER_INTERVAL_MS);
  // 启动时先跑一次
  void recoverStaleRunningTasks(2).catch(() => {});
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
