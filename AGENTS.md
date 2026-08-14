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
├── index.ts           # 入口：挂载 API/MCP/agent 路由 + 定时生命周期回收（超时/认领回流/自动确认）
├── config.ts          # 环境配置（.env）
├── db.ts              # MariaDB 连接池 + 幂等 schema
├── auth.ts            # 管理员 scrypt + agent key(Bearer, sha256) + AsyncLocalStorage
├── scheduler.ts       # 错峰窗口计算 + 生命周期回收
├── service/
│   ├── tasks.ts       # ★ 共享业务层（REST 与 MCP 共用）：会话/交付物/回合
│   ├── market.ts      # 开放生态市场语义：公共池/原子认领/验收链路（§3.2/§3.3/§3.6）
│   ├── attachments.ts # 附件系统（§3.7）：上传/去重/配额/clamd 扫描/下载权限/删除
│   ├── llm.ts        # LLM 审核/验收（§3.4）：多模型/多模态识图/价格标记/调用日志/故障降级
│   └── settings.ts    # 系统设置 KV（附件/LLM 用途映射/提示词，修改留痕 settings_history）
├── routes/
│   ├── api.ts         # 管理员 JSON API（含 visibility、验收打回、附件浏览/清理）
│   ├── agent.ts       # agent REST（heartbeat/poll/pool/claim/attachments/result/renew/reports）
│   ├── attach-shared.ts # 附件发送助手（文本内联预览/下载，RFC5987 文件名）
│   └── mcp.ts         # MCP StreamableHTTP（每会话独立 Server）
└── mcp/tools.ts       # MCP 工具（whoami + task 10 action + upload_attachment，createMcpServer 工厂）
web/                   # Vue3 + Vite + Bootstrap5 前端
scripts/local-alarm.mjs  # 本地闹钟（二段式公共池扫描：程序拉列表→有候选才拉起 LLM 认领）
docs/agent-onboarding.md  # agent 接入指南（通用契约 + pi 参考实现两层）
```

## 开放生态（已落地 §8 最小形态，详见 docs/design/open-ecosystem.md）

- **visibility**：tasks 列，默认 `private`（仅发起人+指派主机）；`public` 入公共池
- **accept_external**：agents 列（接单开关），默认关；公共池认领前置
- **状态机增量**：`active`（池中待认领）→ `claimed`（已认领）→ `submitted`（已提交）→ `pending_confirm`（待发起人判决）→ `done/failed`；打回/预检不合格 → claimed 续做回路（deliver_attempts 计数，上限 max_attempts 默认 3）
- **附件系统（§3.7，已落地）**：`attachments` 表 + 磁盘分片落盘 `{root}/{owner}/yyyy/mm/dd/{att-id}.{ext}`；MCP `upload_attachment`（base64≤5MB）/ REST multipart（≤50MB）；账号级配额（默认 1GB）+ sha256 同账号去重；下载权限=owner 或任务参与人（引用即授权，无公开 URL）；clamd 异步扫描（未配置降级标 skipped）；infected 拒绝引用/下载；未被引用可删（孤儿清理端点）
- **MCP `task` 工具**（§3.6 终局）：10 个 action——list(due|mine|pool) / detail / create / revise / claim / submit / reply / approve / reject / cancel；`upload_attachment` 为第三把工具
- **设置体系（阶段③已落地）**：`/settings` 管理页——附件（根路径/配额/clamd）、LLM 多模型（llm_models：base_url/model/key/多模态 vision/价格标记/启用）、用途映射（审核/验收模型，auto=有图自动选多模态）、提示词编辑（留痕 settings_history：改人/改时/前值）、调用日志（llm_calls：模型/用途/tokens/价格）
- **LLM 门禁（§3.4）**：配置模型后 发布→pending_audit（LLM 审核描述清晰度+验收方案可操作性）→active/rejected（可 task(revise) 重交）；提交预检通过→submitted（LLM 验收，含图片自动走多模态识图）→pending_confirm/续做；未配置/调用失败 → 降级仅程序校验并标记"未经 LLM 审核/验收"（不阻塞）
- **验收双层**：平台程序预检（附件存在性/非空/数量/类型/扫描，LLM 验收未接入时降级标记"未经 LLM 验收"）→ 发起人判决（验收权跟随发起权）
- **生命周期回收**（scheduler）：running 超 2h→failed；公共池 claimed 超 2h→回 active（回帖记录）；pending_confirm 超 7 天→自动 done

## 关键约定

- **业务逻辑只写一份**：新功能先放 `src/service/tasks.ts` / `market.ts`，REST 和 MCP 都调它
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
