# AGENTS.md — 任务分发平台

本仓库：任务分发反馈平台（Web + REST + MCP），管理多台 Linux 设备上的 pi-agent。

## 常用命令

```bash
npm run dev          # 开发：tsx 直接跑 src/index.ts（注意 Windows 端口残留问题）
npm run build        # 构建到 dist（tsc）
npm start            # 生产：node dist/src/index.js（前端已 build 到 web/dist 时自动托管）
npm run typecheck    # 类型检查
npm test             # 全量验收（scripts/test-all.mjs）：MCP + REST + Web UI（playwright）串行；需服务运行 + 管理员 admin123 + web/dist 已构建；自动临时禁用/恢复已配置的真实 LLM provider（验收假设未配置环境，避免 pending_audit 干扰与真实 API 调用）
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
├── ws-server.ts       # 对话实时通道：/api/agent/chat-stream（Bearer，agent 桥接器连；管理端浏览器 300ms 轮询渲染打字机）
├── service/
│   ├── tasks.ts       # ★ 共享业务层（REST 与 MCP 共用）：会话/交付物/回合
│   ├── chat.ts        # 独立对话（conversations + chat_messages）：建对话/收发/流式写入/回合检测（streaming 标记打字机）
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
scripts/chat-bridge.mjs # 对话桥接器（常驻）：连平台 WS + pi --mode rpc 子进程（--session-id 续接/空闲 kill）+ 流式转发 + 断线兜底轮询
scripts/pi-worker.cmd     # 模式 A worker（Windows 计划任务定时拉起 pi -p 纯 MCP 接活，无脚本无环境变量 key；见 docs/agent-onboarding.md 部署模式）
docs/agent-onboarding.md  # agent 接入指南（通用契约 + pi 参考实现两层）
```

## 编排（plan → stage → task，详见 docs/design/orchestration.md）

- **三层模型**：plan 可选（无 stage_id 的单发任务行为不变）；`plans` / `plan_stages` 表；tasks 新列 `origin(manual|periodic)`、`stage_id`、`series_id`、`content_hash`、`deliverable_visibility`
- **顺序闸门**：当前 stage = seq 最小未完成；非当前 stage 任务显式 `blocked`（不进 due/pool、不可认领）；stage 完成（全 done/cancelled，空 stage 跳过）→ 批量放行下一 stage（回帖 `[闸门放行]` + 前序 skipped 清单）；全 stage 完成 → plan `done`（只归档不删）
- **周期归 plan**：`recurrence: none|daily|weekly:d|hourly` + 错峰窗口（限单 stage）；序列克隆（series_id=首实例 id，定义字段复制 + content_hash 审核继承）；上一实例未终结 → 跳过本轮（回帖 `[周期]…跳过本轮`，防堆积）；visibility 变更强制重审
- **plan 人建**：管理员 Web/REST `POST /api/plans`（creator_agent_id=null，任务验收走管理端 resolve）；agent **不能**建 plan，但可 `task(create, stage_id=…)` 往现有 stage 追加任务（**限 plan 参与人**——在该 plan 发起/执行过任务，防借 creator 身份读取全量 plan 上下文；当前 stage 过门禁 / 未来 stage blocked / 已完成或空 stage 拒绝 / **周期 plan 禁止追加**）；无新增 MCP 工具
- **plan 上下文分级**：`task(detail)` 返回 `plan_context`——己方(creator **或 assignee 执行方**)全量（stage 位置/兄弟状态/前序终态摘要）；其余外部浏览者最小事实（无 plan 名，仅前序 stage 已完成 + 跳过数）
- **failed 处置**（管理端）：重开（attempts 清零，按落点回 open=private+assignee / active=public）/ 改派（直接落 open/active，attempts 清零）/ 取消（=跳过，不阻塞闸门）；交付物可见性三档（participants 默认 | account | public，改档留痕回帖）
- **重开任务扩展**（POST /api/tasks/:id/reopen，2026-08-15）：状态白名单 failed/done/cancelled/resolved 皆可重开（done/cancelled/resolved 用于补充信息——恢复 agent 回帖通道 postMessageToTask 仅限 open/claimed）；留痕回帖区分「尝试次数清零」/「管理员重开（原 {状态}，补充信息）」；前端任务详情页终态显示「重开任务（补充信息）」按钮（confirm 后调用并刷新）
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
- **测试数据**：验收脚本会创建 test-agent-* 与 T-* 任务，属正常现象；`npm test`（scripts/test-all.mjs）当前 162 用例 = MCP 108 + REST 33 + Web UI 21（playwright chromium，覆盖编排树表单/树视图/可见性改档/failed 处置/设置页）；跑前自动临时禁用已配置的真实 LLM provider（验收假设未配置环境），跑完恢复；第 9 节覆盖编排全链路（含周期克隆闭环/首实例身份/闸门/plan 上下文分级）
- **legacy scheduled 并存**：旧入口 `POST /api/tasks kind='scheduled'`（tasks.ts 原地推进 next_due_at，无 plan）与新周期 plan（克隆）**双机制并存**，旧入口已标废弃、后续移除（见 orchestration.md §九迁移口径）

## 分页组件（web/src/components/Pagination.vue）

通用 Bootstrap 分页条，系统中的列表统一用它。后端分页接口约定：`?page=&page_size=` 参数，响应 `{ ...items, total, page, page_size }`（`total` 总条数）。

```html
<!-- 用法：total 总条数；v-model:page 当前页；@change 翻页后重新拉数据 -->
<Pagination :total="total" v-model:page="page" :page-size="20" @change="load" />
```

```js
const page = ref(1);
const total = ref(0);
async function load() {
  const data = await api.tasks({ page: page.value, page_size: 20 }); // 或 api.plans(page, 20) / api.agents(page, 20)
  items.value = data.items ?? data.tasks ?? data.plans ?? data.agents;
  total.value = data.total ?? 0;
}
```

要点：
- 组件内部计算总页数，`totalPages <= 1` 时不渲染；页码超 7 个自动折叠成 `1 … 5 6 7 … 20`
- 翻页时组件先 `emit('update:page')` 再 `emit('change')`，`@change` 里直接读最新 `page` 请求后端
- **过滤/搜索条件变化必须重置页码**（否则可能停在超出范围的页）：`page = 1; load()`
- 已接入列表：任务页 / 计划页 / Agent 页 / Agent 详情任务表 / 任务详情消息流（messages_page）/ 设置页日志 tab（activity/llm-calls/history）；Dashboard 摘要卡与 PlanDetail 树视图不分页
- 后端统一用 `src/routes/api.ts` 的 `pageParams(req.query)` 解析分页参数（page 默认 1，page_size 默认 20 上限 200）

## 独立对话通道（管理员 ↔ agent，2026-08-15 落地；任务发起 + 任务上下文注入）

- **语义**：任务外沟通走独立对话（conversations + chat_messages），不污染任务消息流（任务内 reply 保留用于执行沟通）；`messages` 表已改名 **`task_messages`**
- **入口**：任务**详情页**右上角「与 agent 对话」按钮（有指派 agent 才显示）→ 详情缩到 8/12，右侧 4/12 对话面板，头部显示「agent 名 #id + T-xxx · 标题 · 状态」；任务列表页不放对话按钮
- **表**：`conversations`（agent 对象/task_id 业务串 T-xxx 可选/status open|archived）+ `chat_messages`（sender_role admin|agent + streaming 打字机标记）；`conversation_id` 业务串 conv-<8hex>
- **管理端 API**（src/routes/api.ts）：`GET/POST /api/conversations`（带 task_id → 只复用该任务 open 对话，没有就新建；不带 → 复用同 agent open，幂等）、`GET .../messages`（正序分页）、`GET .../messages/since?since_id=`（**`id >=` 含等号**——streaming 行 id 不变内容累积，`>=` 让打字机增量可重复拉到，前端按 id 去重合并）、`POST .../messages`（落库 + WS 推 agent 桥接器，**带 task 上下文**）、`POST .../archive`
- **agent API**（src/routes/agent.ts）：`chat-check`（零副作用回合检测）、`chat-messages`（历史 + **任务上下文 getTaskContext**，归属校验）、`chat-reply`（非流式落库）
- **WS**（src/ws-server.ts）：`/api/agent/chat-stream` Bearer 认证；平台推 `conv_new_message`（含 task）；桥接器回推 `conv_stream_start/conv_stream/conv_stream_end`；管理端浏览器不连 WS，300ms 轮询 since
- **桥接器**（scripts/chat-bridge.mjs，常驻）：收到消息拉起 pi `--mode rpc --session-id chat-{convId}`（**跨进程续接验证过**）→ **prompt 注入【任务上下文】**（任务 ID/标题/状态/指令摘要，buildPrompt）→ 转发 text_delta 打字机 → agent_end 落库；空闲 120s kill；WS 断线退回 1.5s chat-check 轮询（chat-messages 拉任务上下文 + 不流式回复）；启动 `node scripts/chat-bridge.mjs`（key 从 ~/.pi/agent/mcp.json 读）
- **前端**：TaskDetail.vue「与 agent 对话」按钮 + ChatPanel.vue（任务上下文头部/气泡 markdown/时间戳/300ms 轮询打字机/textarea Enter 发送/归档）；Tasks.vue 列表无对话入口
- **验收**：playwright 冒烟（work/chat-detail-smoke.mjs，详情页发起→上下文→7.4s 回复）+ npm test 162 全过；对话隔离：不进 task_messages、任务 reply 不触发对话

## 主机失联检测（心跳徽标）

- agent 每次带 key 请求（poll/heartbeat 等）刷新 `agents.last_seen_at`（auth.ts）
- **失联判定（只读标记，不自动禁用）**：`last_seen_at` 为空（从未连接）或超过 `agent_offline_after_min` 分钟（settings KV，默认 30）未心跳 → 后端在 `/api/agents`、`/api/agents/:id`、`/api/stats` 响应中附 `offline` 标记（列表/详情/仪表盘同时返回 `offline_after_min` 供前端提示）
- 前端：Agent 列表/详情显示红色「失联」徽标（title 提示阈值与最近活跃时间）；仪表盘「启用主机」卡显示 `· N 失联`；agent 恢复心跳后自动变回在线（无需手动操作）

## 配置（.env）

```
PORT=3000
DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME   # MariaDB 连接
SESSION_SECRET                                # 会话密钥（生产必须改）
```
