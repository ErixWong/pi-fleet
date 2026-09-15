import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { config } from './config.js';
import { initDb } from './db.js';
import { initSchema, markNewDbUnavailable, requireNewDb } from './db/pool.js';
import { apiRouter } from './routes/api.js';
import { mcpRouter } from './routes/mcp.js';
import { agentRouter } from './routes/agent.js';
import { v2Router } from './routes/v2/index.js';
import { recoverStaleRunningTasks, recoverStaleClaimedTasks, autoConfirmPendingConfirm } from './scheduler.js';
import { initSettings } from './service/settings.js';
import { initNewSettings } from './service/new-settings.js';
import { scanPendingAttachments } from './service/attachments.js';
import { scanPendingAudits, scanPendingVerifications } from './service/llm.js';
import { runPeriodicClones, runStageGates } from './service/plans.js';
import { startOutboxWorker } from './service/outbox-worker.js';
import { startAttachmentScanWorker } from './service/attachment-worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  await initDb();
  console.log('✓ 老库 schema 就绪');
  console.log(
    `新库: ${config.dbNew.database}（${config.newDbRequired ? '必需' : '可选，不可用将跳过'}）`,
  );
  let newDbReady = false;
  try {
    const { created } = await initSchema();
    console.log(
      `✓ 新库 schema 就绪（${created.length > 0 ? `新增 ${created.length} 表：${created.join(', ')}` : '无新建表'}）`,
    );
    await initSettings();
    await initNewSettings();
    newDbReady = true;
  } catch (error) {
    markNewDbUnavailable();
    if (config.newDbRequired) {
      throw new Error(
        `新库 "${config.dbNew.database}" 不可用且 NEW_DB_REQUIRED=1：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    console.error(
      `⚠ 新库 "${config.dbNew.database}" 不可用（NEW_DB_REQUIRED=0），跳过新模型初始化；老 /api、/mcp 继续提供服务。`
        + ` 原因: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const stopWorker = newDbReady
    ? startOutboxWorker({
        deliver: async (event) => {
          if (event.retention === 'notify') console.log('[outbox]', event.id, event.action);
          return { ok: true };
        },
      })
    : () => {};
  const stopAttachmentWorker = newDbReady ? startAttachmentScanWorker() : () => {};

  const app = express();
  // 注意：不全局挂 body parser——MCP transport 需要读取原始 body 流，
  // /mcp 由 StreamableHTTPServerTransport 自行解析；JSON parser 挂载在 apiRouter 上
  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 7 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax' },
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

  app.use('/api', apiRouter);
  app.use('/api/v2', requireNewDb, v2Router);
  app.use('/api/agent', agentRouter);
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
    console.log(`  API 端点:   http://127.0.0.1:${config.port}/api`);
    console.log(`  MCP 端点:   http://127.0.0.1:${config.port}/mcp`);
  });
  server.on('close', () => {
    stopWorker();
    stopAttachmentWorker();
  });

  // 对话实时通道（agent 桥接器 WS：/api/agent/chat-stream）
  const { mountChatWs } = await import('./ws-server.js');
  mountChatWs(server);

  // 生命周期回收（§10.2）：每小时清理——running 超时→failed；公共池 claimed 超时→回池；pending_confirm 超 7 天→自动确认
  const RECOVER_INTERVAL_MS = 60 * 60 * 1000;
  setInterval(() => {
    const attachmentScan = newDbReady
      ? scanPendingAttachments()
      : Promise.resolve({ scanned: 0, skipped: 0, infected: 0 });
    Promise.all([
      recoverStaleRunningTasks(2),
      recoverStaleClaimedTasks(2),
      autoConfirmPendingConfirm(7),
      attachmentScan,
    ])
      .then(([n1, n2, n3, scan]) => {
        if (n1 + n2 + n3 > 0) console.log(`[recover] 超时回收 running=${n1} 认领回流=${n2} 自动确认=${n3}`);
        if (scan.scanned + scan.skipped + scan.infected > 0) {
          console.log(`[scan] 附件扫描 干净=${scan.scanned} 降级跳过=${scan.skipped} 感染=${scan.infected}`);
        }
      })
      .catch((err) => console.error('[recover] 失败:', err));
  }, RECOVER_INTERVAL_MS);
  // 启动时先跑一次
  if (newDbReady) {
    void Promise.all([
      recoverStaleRunningTasks(2),
      recoverStaleClaimedTasks(2),
      autoConfirmPendingConfirm(7),
      scanPendingAttachments(),
    ]).catch((err) => console.error('[recover] 启动扫描失败:', err));
  }

  // LLM 审核/验收（§3.4 异步）：每分钟扫 pending_audit / submitted 两个队列；未配置时降级直通
  const LLM_SCAN_MS = 60 * 1000;
  if (newDbReady) {
    setInterval(() => {
      Promise.all([scanPendingAudits(), scanPendingVerifications()])
        .then(([a, v]) => {
          if (a.audited + v.verified > 0) {
            console.log(`[llm] 审核=${a.audited}(拒${a.rejected}/降级${a.degraded}) 验收=${v.verified}(过${v.passed}/拒${v.failed}/降级${v.degraded})`);
          }
        })
        .catch((err) => console.error('[llm] 扫描失败:', err));
    }, LLM_SCAN_MS);
  }

  // 编排（orchestration.md）：闸门放行 + 周期序列克隆（与 LLM 扫描同节奏）
  if (newDbReady) {
    setInterval(() => {
      Promise.all([runStageGates(), runPeriodicClones()])
        .then(([g, c]) => {
          if (g + c > 0) console.log(`[plan] 闸门放行=${g} 周期克隆=${c}`);
        })
        .catch((err) => console.error('[plan] 编排扫描失败:', err));
    }, LLM_SCAN_MS);
  }
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});

// 兜底：未捕获的异步异常/拒绝不崩进程（express 4 不自动捕获 async 路由 rejection）
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
