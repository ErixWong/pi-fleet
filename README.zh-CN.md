# pifleet

[English](README.md) | **中文**

> 个人 agent 舰队的指挥与通讯中枢（自托管）。

pifleet 把几台 Linux 机器——x86 服务器、ARM 盒子、无 GUI 容器都行——编成一支舰队，
你在浏览器里指挥它：注册主机、派发任务、验收交付物，并和设备上的 agent 直接对话。

这是**个人用的舰队指挥工具，不是交易市场**。核心是把活派给自己的设备并和它们沟通；
将来若加市场/讨论区，也只是附带功能。

---

## 能做什么

| 能力 | 说明 |
|---|---|
| **设备舰队** | 用一次性 API key 注册异构主机；心跳、远程目录浏览、请求/应答控制链路 |
| **任务分发** | 任务状态机（`open → claimed → submitted → pending_confirm → done`），认领、超时回收、尝试次数、验收与打回 |
| **交付物** | 附件 sha256 去重、病毒扫描 worker、浏览器内预览（图片 / PDF / 文本）、按账号隔离权限 |
| **对话** | 每台设备一个通道，直接和该主机上的 agent 聊天 |
| **两种 agent 接入协议** | 主机 daemon 走 REST v2，pi agent 走 MCP2（`/mcp2`，Streamable HTTP） |
| **Web 控制台** | Vue 3 + Bootstrap SPA，与 API 同一进程托管 |
| **可审计** | 所有状态变更写入事件表，经事务性 outbox 发布 |

## 架构

```
👤 管理员（浏览器）                        ← 唯一的任务发起方
        │ HTTPS  /api/v2
┌───────┴─────────────────────────────────────────┐
│ pifleet 平台（单 Node 进程）                     │
│   /api/v2 REST · /mcp2 MCP · 静态 Web            │
│   鉴权（Bearer key → principal + scope）         │
│   业务层：identity / posts / task-flow           │
│           resources / event-outbox              │
│   worker：outbox · 附件扫描 · lifecycle          │
└───────┬─────────────────────────────────────────┘
        │ daemon 每 5s 轮询（认领 / 提交 / 心跳）
┌───────┴─────────────────────────────────────────┐
│ 执行设备群（异构，可水平扩展）                    │
│   agent-daemon + pi  ← 每台机器一套              │
└──────────────────────────────────────────────────┘
        MariaDB（状态）+ 本地磁盘（附件文件）
```

完整架构图与代码对应关系见 [`docs/design/architecture.md`](docs/design/architecture.md)。

**角色分工**：人在浏览器里操作；每台设备跑一个 `pi-agent` daemon，轮询任务、
按任务拉起 pi 进程、回传交付物。设备**不会自注册**——由管理员创建主机并签发 key。

## 快速开始

### 1. 平台服务端

要求：**Node.js ≥ 20**、**MariaDB**。

```bash
git clone https://github.com/ErixWong/pi-fleet.git
cd pi-fleet
npm install
npm run build

# 配置 .env：DB_HOST/DB_PORT/DB_USER/DB_PASSWORD、DB_NAME_NEW、PORT、ATTACHMENTS_ROOT
npm run db-rebuild -- --database erix        # 建表（25 张）
ADMIN_USERNAME=admin ADMIN_PASSWORD=... ADMIN_ACCOUNT_NAME=erix \
  npm run create-admin -- --database erix    # 创建首个管理员

npm run platform:start                       # 启动（platform:start:build 会先构建）
npm run platform:stop                        # 停止
```

平台在同一端口提供 API、MCP 端点和 Web 控制台（`PORT`，默认 `3000`；
当前部署用 `3200`）。

### 2. 注册设备

在 Web 控制台：**主机（Hosts）→ 注册主机** → 复制弹窗里的**一次性 API key**
（只显示一次）。这会创建 `host` principal，自带 `task:read`、`task:claim`、
`task:submit` scope。

### 3. 在设备上装 agent 客户端

```bash
npm install -g pifleet-agent-client

pi-agent setup --url=http://<平台地址>:3200 --key=<一次性 key>
# 写入 ~/.config/pi-agent/config.json（600），并把 task-dispatch 段
# 合并进 ~/.pi/agent/mcp.json

pi-agent run                    # 前台试跑
sudo pi-agent install-service   # 装成 systemd 常驻服务
```

验证：Web 控制台里该设备出现且心跳在刷新；发一个指定该设备的测试任务，
走通认领 → 提交 → 交付物验收。

沙箱隔离、排障等详见 [`docs/agent-onboarding.md`](docs/agent-onboarding.md)。

## 仓库结构

```
src/           平台服务端：routes/v2、mcp/（MCP2）、service/、db/、worker
web/           Vue 3 Web 控制台
client/        pi-agent 客户端与 daemon（npm 包 pifleet-agent-client）
scripts/       验收套件、数据库工具、平台启停脚本
docs/          接入指南、架构、数据模型、设计文档
```

## 测试

```bash
npm run typecheck        # tsc --noEmit
npm run test:unit        # service/id/auth 单测
npm run test:v2          # MCP2 + REST v2 + 事件 outbox 验收（需平台已启动）
npm run test:web         # Playwright Web 验收（需 TEST_USERNAME / TEST_PASSWORD）
npm test                 # 以上全部
```

## 文档

- [`docs/agent-onboarding.md`](docs/agent-onboarding.md) — 新设备从零接入全流程
- [`docs/design/architecture.md`](docs/design/architecture.md) — 架构与代码对应
- [`docs/design/data-model.md`](docs/design/data-model.md) — 表结构与 ID 约定
- [`AGENTS.md`](AGENTS.md) — 仓库协作约定（中文）

## 许可

agent 客户端（`client/`，npm 包 `pifleet-agent-client`）采用 MIT 许可。
