# AGENTS.md — 任务分发平台

本仓库：任务分发反馈平台（Web + REST + MCP），管理多台 Linux 设备上的 pi-agent。

## 常用命令

```bash
npm run dev          # 开发：tsx 直接跑 src/index.ts（注意 Windows 端口残留问题）
npm run build        # 构建到 dist（tsc）
npm start            # 生产：node dist/src/index.js（前端已 build 到 web/dist 时自动托管）
npm run typecheck    # 类型检查
npm test             # 验收：MCP 全流程 + REST 端点 + Web UI（playwright；需服务运行 + 管理员 admin123 + web/dist 已构建）
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
│   ├── plans.ts       # 编排（orchestration.md）：plan/stage/task 三层 + 闸门 + 周期克隆
│   ├── attachments.ts # 附件系统（§3.7）：上传/去重/配额/clamd 扫描/下载权限/删除
│   ├── llm.ts        # LLM 审核/验收（§3.4）：多模型/多模态识图/价格标记/调用日志/故障降级
│   └── settings.ts    # 系统设置 KV（附件/LLM 用途映射/提示词，修改留痕 settings_history）
├── routes/
│   ├── api.ts         # 管理员 JSON API（含 visibility、验收打回、附件浏览/清理）
│   ├── agent.ts       # agent REST（heartbeat/poll/pool/claim/attachments/result/renew/reports）
│   ├── attach-shared.ts # 附件发送助手（文本内联预览/下载，RFC5987 文件名）
│   └── mcp.ts         # MCP StreamableHTTP（每会话独立 Server）
└── mcp/tools.ts       # MCP 工具（whoami + task 10 action + upload_attachment，createMcpServer 工厂）
web/                   # Vue3 + Vite + Bootstrap5 前端（任务/计划/设置三大页）
scripts/
├── cleanup-db.mjs       # 清理测试数据（保留 local-pi / local-pi-open）
├── rebuild-tasks.mjs    # tasks 表重建（本环境 ALTER 重建失败 errno 194，复制换表）
├── mcp-acceptance.mjs   # MCP 验收 94 用例（含第 9 节编排）
└── rest-acceptance.mjs  # REST 验收 33 用例
scripts/local-alarm.mjs  # 本地闹钟（二段式公共池扫描：程序拉列表→有候选才拉起 LLM 认领）
docs/agent-onboarding.md  # agent 接入指南（通用契约 + pi 参考实现两层）
```

## 编排（plan → stage → task，详见 docs/design/orchestration.md）

- **三层模型**：plan 可选（无 stage_id 的单发任务行为不变）；`plans` / `plan_stages` 表；tasks 新列 `origin(manual|periodic)`、`stage_id`、`series_id`、`content_hash`、`deliverable_visibility`
- **顺序闸门**：当前 stage = seq 最小未完成；非当前 stage 任务显式 `blocked`（不进 due/pool、不可认领）；stage 完成（全 done/cancelled，空 stage 跳过）→ 批量放行下一 stage（回帖 `[闸门放行]` + 前序 skipped 清单）；全 stage 完成 → plan `done`（只归档不删）
- **周期归 plan**：`recurrence: none|daily|weekly:d|hourly` + 错峰窗口（限单 stage）；序列克隆（series_id=首实例 id，定义字段复制 + content_hash 审核继承）；上一实例未终结 → 跳过本轮（回帖 `[周期]…跳过本轮`，防堆积）；visibility 变更强制重审
- **plan 人建**：管理员 Web/REST `POST /api/plans`（creator_agent_id=null，任务验收走管理端 resolve）；agent **不能**建 plan，但可 `task(create, stage_id=…)` 往现有 stage 追加任务（**限 plan 参与人**——在该 plan 发起/执行过任务，防借 creator 身份读取全量 plan 上下文；当前 stage 过门禁 / 未来 stage blocked / 已完成或空 stage 拒绝 / **周期 plan 禁止追加**）；无新增 MCP 工具
- **plan 上下文分级**：`task(detail)` 返回 `plan_context`——己方(creator **或 assignee 执行方**)全量（stage 位置/兄弟状态/前序终态摘要）；其余外部浏览者最小事实（无 plan 名，仅前序 stage 已完成 + 跳过数）
- **failed 处置**（管理端）：重开（attempts 清零，按落点回 open=private+assignee / active=public）/ 改派（直接落 open/active，attempts 清零）/ 取消（=跳过，不阻塞闸门）；交付物可见性三档（participants 默认 | account | public，改档留痕回帖）
- **时钟驱动**：`src/index.ts` 60s 周期跑 `runStageGates()` + `runPeriodicClones()`（与 LLM 扫描同拍）；管理端「立即扫描」`POST /api/settings/llm-scan` 一并驱动（响应含 audit/verify/plan 三块）
- Web：`/plans` 列表 + 创建树表单（阶段/任务动态增删）；`/plans/:planId` 树视图（当前 stage 高亮、后续置灰、stalled 标红、failed 处置按钮、交付物可见性下拉）

## 开放生态（已落地 §8 最小形态，详见 docs/design/open-ecosystem.md）

- **visibility**：tasks 列，默认 `private`（仅发起人+指派主机）；`public` 入公共池
- **accept_external**：agents 列（接单开关），默认关；公共池认领前置
- **状态机增量**：`active`（池中待认领）→ `claimed`（已认领）→ `submitted`（已提交）→ `pending_confirm`（待发起人判决）→ `done/failed`；打回/预检不合格 → claimed 续做回路（deliver_attempts 计数，上限 max_attempts 默认 3）
- **附件系统（§3.7，已落地）**：`attachments` 表 + 磁盘分片落盘 `{root}/{owner}/yyyy/mm/dd/{att-id}.{ext}`；MCP `upload_attachment`（base64≤5MB）/ REST multipart（≤50MB）；账号级配额（默认 1GB）+ sha256 同账号去重；下载权限=owner 或任务参与人（引用即授权，无公开 URL）；clamd 异步扫描（未配置降级标 skipped）；infected 拒绝引用/下载；未被引用可删（孤儿清理端点）
- **MCP `task` 工具**（§3.6 终局）：10 个 action——list(due|mine|pool) / detail / create / revise / claim / submit / reply / approve / reject / cancel；`upload_attachment` 为第三把工具
- **设置体系（阶段③已落地）**：`/settings` 管理页——附件（根路径/配额/clamd）、LLM **provider → 多模型**（llm_providers：base_url/api_key 在 provider 级共享；llm_models 挂在 provider 下，含 model/多模态 vision/价格标记/启用；旧行自动迁移归并）、用途映射（审核/验收模型，auto=有图自动选多模态）、提示词编辑（留痕 settings_history：改人/改时/前值）、调用日志（llm_calls：provider/模型/用途/tokens/价格）
- **LLM 门禁（§3.4）**：配置模型后 发布→pending_audit（LLM 审核描述清晰度+验收方案可操作性）→active/rejected（可 task(revise) 重交）；提交预检通过→submitted（LLM 验收，含图片自动走多模态识图）→pending_confirm/续做；未配置/调用失败 → 降级仅程序校验并标记"未经 LLM 审核/验收"（不阻塞）
- **验收双层**：平台程序预检（附件存在性/非空/数量/类型/扫描，LLM 验收未接入时降级标记"未经 LLM 验收"）→ 发起人判决（验收权跟随发起权）
- **生命周期回收**（scheduler）：running 超 2h→failed；公共池 claimed 超 2h→回 active（回帖记录）；pending_confirm 超 7 天→自动 done
- **表空间注意**：本环境 MariaDB 对 tasks/messages/reports/deliverables 做 ALTER 重建必失败（errno 194，历史遗留）。
  tasks 枚举/结构变更走 `scripts/rebuild-tasks.mjs` 复制换表（读 .env 凭据、fail-fast、旧表保留为 tasks_bak 验证后手工删；从表 FK 会失败属已知，应用不依赖）；reports 无法重建（删除/重建型迁移不可用）

## 关键约定

- **业务逻辑只写一份**：新功能先放 `src/service/tasks.ts` / `market.ts`，REST 和 MCP 都调它
- **时间**：Node 侧生成本地字符串，数据库不做时间判断
- **BIGINT 是字符串**：连接池配置了 bigNumberStrings，id 字段是字符串类型
- **Windows 端口残留**：`npm run dev`（tsx）停止时子进程可能残留占 3000 端口，
  重启前先 `Get-NetTCPConnection -LocalPort 3000 | 杀进程`；生产用 `node dist` 无此问题
- **测试数据**：验收脚本会创建 test-agent-* 与 T-* 任务，属正常现象；`npm test` 当前 158 用例（MCP 104 + REST 33 + Web UI 21，Web UI 走 playwright chromium，覆盖编排树表单/树视图/可见性改档/failed 处置/设置页），第 9 节覆盖编排全链路（含周期克隆闭环/首实例身份/闸门/plan 上下文分级）
- **legacy scheduled 并存**：旧入口 `POST /api/tasks kind='scheduled'`（tasks.ts 原地推进 next_due_at，无 plan）与新周期 plan（克隆）**双机制并存**，旧入口已标废弃、后续移除（见 orchestration.md §九迁移口径）

## 配置（.env）

```
PORT=3000
DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME   # MariaDB 连接
SESSION_SECRET                                # 会话密钥（生产必须改）
```
