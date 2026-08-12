# AGENTS.md — 任务分发平台

本仓库：任务分发反馈平台（Web + REST + MCP），管理多台 Linux 设备上的 pi-agent。

## 常用命令

```bash
npm run dev          # 开发：tsx 直接跑 src/index.ts（注意 Windows 端口残留问题）
npm run build        # 构建到 dist（tsc）
npm start            # 生产：node dist/src/index.js（前端已 build 到 web/dist 时自动托管）
npm run typecheck    # 类型检查
npm test             # 验收：MCP 全流程 + REST 端点（需服务运行 + 管理员 admin123）
npm run init-admin   # 设置管理员密码
```

## 架构速览

```
src/
├── index.ts           # 入口：挂载 API/MCP/agent 路由 + 定时超时回收
├── config.ts          # 环境配置（.env）
├── db.ts              # MariaDB 连接池 + 幂等 schema
├── auth.ts            # 管理员 scrypt + agent key(Bearer, sha256) + AsyncLocalStorage
├── scheduler.ts       # 错峰窗口计算 + 超时回收
├── service/tasks.ts   # ★ 共享业务层（REST 与 MCP 共用）
├── routes/
│   ├── api.ts         # 管理员 JSON API
│   ├── agent.ts       # agent REST（heartbeat/poll/result/renew/reports）
│   └── mcp.ts         # MCP StreamableHTTP（每会话独立 Server）
└── mcp/tools.ts       # MCP 六工具（createMcpServer 工厂）
web/                   # Vue3 + Vite + Bootstrap5 前端
docs/agent-onboarding.md  # agent 接入指南（Linux 设备部署）
```

## 关键约定

- **业务逻辑只写一份**：新功能先放 `src/service/tasks.ts`，REST 和 MCP 都调它
- **时间**：Node 侧生成本地字符串，数据库不做时间判断
- **BIGINT 是字符串**：连接池配置了 bigNumberStrings，id 字段是字符串类型
- **Windows 端口残留**：`npm run dev`（tsx）停止时子进程可能残留占 3000 端口，
  重启前先 `Get-NetTCPConnection -LocalPort 3000 | 杀进程`；生产用 `node dist` 无此问题
- **测试数据**：验收脚本会创建 test-agent-* 与 T-* 任务，属正常现象

## 配置（.env）

```
PORT=3000
DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME   # MariaDB 连接
SESSION_SECRET                                # 会话密钥（生产必须改）
```
