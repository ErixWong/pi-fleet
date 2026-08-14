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
import { recoverStaleRunningTasks, recoverStaleClaimedTasks, autoConfirmPendingConfirm } from './scheduler.js';
import { initSettings } from './service/settings.js';
import { scanPendingAttachments } from './service/attachments.js';
import { scanPendingAudits, scanPendingVerifications } from './service/llm.js';
import { runPeriodicClones, runStageGates } from './service/plans.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  await initDb();
  await initSettings();
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

  // 生命周期回收（§10.2）：每小时清理——running 超时→failed；公共池 claimed 超时→回池；pending_confirm 超 7 天→自动确认
  const RECOVER_INTERVAL_MS = 60 * 60 * 1000;
  setInterval(() => {
    Promise.all([
      recoverStaleRunningTasks(2),
      recoverStaleClaimedTasks(2),
      autoConfirmPendingConfirm(7),
      scanPendingAttachments(),
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
  void Promise.all([
    recoverStaleRunningTasks(2),
    recoverStaleClaimedTasks(2),
    autoConfirmPendingConfirm(7),
    scanPendingAttachments(),
  ]).catch(() => {});

  // LLM 审核/验收（§3.4 异步）：每分钟扫 pending_audit / submitted 两个队列；未配置时降级直通
  const LLM_SCAN_MS = 60 * 1000;
  setInterval(() => {
    Promise.all([scanPendingAudits(), scanPendingVerifications()])
      .then(([a, v]) => {
        if (a.audited + v.verified > 0) {
          console.log(`[llm] 审核=${a.audited}(拒${a.rejected}/降级${a.degraded}) 验收=${v.verified}(过${v.passed}/拒${v.failed}/降级${v.degraded})`);
        }
      })
      .catch((err) => console.error('[llm] 扫描失败:', err));
  }, LLM_SCAN_MS);

  // 编排（orchestration.md）：闸门放行 + 周期序列克隆（与 LLM 扫描同节奏）
  setInterval(() => {
    Promise.all([runStageGates(), runPeriodicClones()])
      .then(([g, c]) => {
        if (g + c > 0) console.log(`[plan] 闸门放行=${g} 周期克隆=${c}`);
      })
      .catch((err) => console.error('[plan] 编排扫描失败:', err));
  }, LLM_SCAN_MS);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
