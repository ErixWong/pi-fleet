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

- **及时提交 + 提醒 push**：完成一个功能/修复（跑完验收后）就 git commit（message 用中文详细概括：`feat:`/`fix:` 前缀 + 要点列表），并**明确提醒用户 push 到远程仓库**；不要攒一堆改动到最后才提交
- **大变更先与用户确认 issue/PR**：涉及架构调整、破坏性变更、多模块重构、或用户明确要求走评审流程的大变更——**先与用户确认**是否需要：① 建 issue（记录需求/设计/验收口径）② 建 PR（分支提交走评审）③ 直接 push main；用户确认后再动手，不擅自创建；小变更（bugfix/小功能）直接提交 main 即可
- **业务逻辑只写一份**：新功能先放 `src/service/tasks.ts` / `market.ts`，REST 和 MCP 都调它
- **时间**：Node 侧生成本地字符串，数据库不做时间判断
- **BIGINT 是字符串**：连接池配置了 bigNumberStrings，id 字段是字符串类型
- **Windows 端口残留**：`npm run dev`（tsx）停止时子进程可能残留占 3000 端口，
  重启前先 `Get-NetTCPConnection -LocalPort 3000 | 杀进程`；生产用 `node dist` 无此问题
- **测试数据**：验收脚本会创建 test-agent-* 与 T-* 任务，属正常现象；`npm test`（scripts/test-all.mjs）当前 160 用例 = MCP 101 + REST 38 + Web UI 21（playwright chromium，覆盖编排树表单/树视图/可见性改档/failed 处置/设置页）；跑前自动临时禁用已配置的真实 LLM provider（验收假设未配置环境），跑完恢复；第 9 节覆盖编排全链路（含周期克隆闭环/首实例身份/闸门/plan 上下文分级）；三个脚本各自也带 LLM 禁用/恢复包装
- **legacy scheduled 已移除**：2026-08-15 表重建后 `kind/schedule_cron/next_due_at` 列与旧入口 `POST /api/tasks kind='scheduled'` 一并删除；定时一律由 stage 的 `recurrence` 属性负责（stage 生成器按期克隆，见编排 §三）

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

## 独立对话通道（管理员 ↔ agent，2026-08-15 落地；任务发起 + 任务上下文注入；多会话 2026-08-16）

- **语义**：任务外沟通走独立对话（conversations + chat_messages），不污染任务消息流（任务内 reply 保留用于执行沟通）；`messages` 表已改名 **`task_messages`**
- **入口**：任务**详情页**右上角「与 agent 对话」按钮（有指派 agent 才显示）→ 详情缩到 8/12，右侧 4/12 对话面板，头部显示「agent 名 #id + T-xxx · 标题 · 状态」；任务列表页不放对话按钮
- **多会话模型（2026-08-16）**：一个主机可有**多个会话**，每个会话独立绑定 `name` + `workdir`（~/projects 下子目录）+ `run_user`（运行 pi 的用户）；`conversations` 新增 `name/workdir/run_user` 列，`agent_projects` 表缓存主机 `~/projects` 目录列表（bridge 启动即上报 + 5 分钟周期 + WS `projects_rescan` 触发立即上报）
- **表**：`conversations`（agent 对象/task_id 业务串 T-xxx 可选/name/workdir/run_user/status open|archived）+ `chat_messages`（sender_role admin|agent + streaming 打字机标记）；`conversation_id` 业务串 conv-<8hex（主机会话）/ conv-task-{taskId}（任务会话）>
- **管理端 API**（src/routes/api.ts）：`POST /api/conversations`（带 task_id → 任务对话固定 conv-task-{taskId} 复用；不带 → **主机会话多会话**：带 name/workdir/run_user 任一即新建，全空为纯「对话」入口复用最近 open 主机会话）、`GET /api/agents/:id/conversations`（列表）、`GET /api/conversations/:id`（单查）、`POST .../rename`、`POST .../run-user`、`GET /api/agents/:id/projects`、`POST /api/agents/:id/projects-rescan`、`GET .../messages`（正序分页）、`GET .../messages/since?since_id=`（**`id >=` 含等号**——streaming 行 id 不变内容累积，`>=` 让打字机增量可重复拉到，前端按 id 去重合并）、`POST .../messages`（落库 + WS 推 agent 桥接器，**带 task 上下文 + workdir/run_user/name**）、`POST .../archive`
- **agent API**（src/routes/agent.ts）：`chat-check`（零副作用回合检测）、`chat-messages`（历史 + **任务上下文 getTaskContext**，归属校验）、`chat-reply`（非流式落库）、`POST /api/agent/projects`（**目录上报** dirs 数组，Bearer）
- **WS**（src/ws-server.ts）：`/api/agent/chat-stream` Bearer 认证；平台推 `conv_new_message`（含 task/workdir/run_user/name）+ `projects_rescan`；桥接器回推 `conv_stream_start/conv_stream/conv_stream_end`；管理端浏览器不连 WS，300ms 轮询 since
- **桥接器**（scripts/chat-bridge.mjs，常驻）：收到消息拉起 pi `--mode rpc --session-id chat-{convId}`（**跨进程续接验证过**）→ **prompt 注入【任务上下文】**（buildPrompt）→ 转发 text_delta 打字机 → agent_end 落库；空闲 120s kill；WS 断线退回 1.5s chat-check 轮询（chat-messages 拉任务上下文 + 不流式回复）；启动 `node scripts/chat-bridge.mjs`（key 从 ~/.pi/agent/mcp.json 读，PLATFORM_URL 覆盖）
- **工作目录**：conversations.workdir（发起时传或 `POST /conversations/:id/workdir` 设置）；**远程 pi 在该路径下启动**——bridge spawn 时 cwd=workdir（自动 mkdir）+ `--name` 让远端 `pi -r` 可识别会话；**安全限制：平台只允许 `~/projects/` 开头**（isSafeWorkdir），bridge 在主机上 resolve 后校验必须以 home 为前缀否则忽略
- **运行用户**：conversations.run_user；空=bridge 当前用户；非空且≠当前用户 → bridge 用 `sudo -n -u <user> -H -- node ...` 切换（**需 sudoers 白名单**，`-H` 让 HOME/pi sessions 随该用户）；**失败路径**：pi 进程异常退出（code≠0 且无回复）→ 自动回帖错误提示（含 sudoers 提醒）
- **前端**：TaskDetail.vue「与 agent 对话」+ ChatPanel.vue（任务上下文头部/气泡 markdown/300ms 轮询打字机/全屏模式 workdir 输入 + **目录下拉 chips**）+ ChatPage.vue（`/chat/:agentId` 默认入口、`/chat/:agentId/:convId` 直接打开指定会话）+ AgentDetail.vue **会话管理卡片**（列所有会话：名/目录/用户/最后消息 + 打开/重命名/运行用户/归档 + **新建会话弹窗**：名称 + 目录下拉（来自 bridge 上报）+ 可选 run_user）
- **验收**：多会话端到端验证过：两会话并行（不同 workdir 各自拉起 pi、记忆隔离）+ 会话续接（同 convId 再发消息 pi 记得上文）+ run_user 失败回帖 + 多主机目录隔离；npm test 162 全过；对话隔离：不进 task_messages、任务 reply 不触发对话

## 主机失联检测（心跳徽标）

- agent 每次带 key 请求（poll/heartbeat 等）刷新 `agents.last_seen_at`（auth.ts）
- **失联判定（只读标记，不自动禁用）**：`last_seen_at` 为空（从未连接）或超过 `agent_offline_after_min` 分钟（settings KV，默认 30）未心跳 → 后端在 `/api/agents`、`/api/agents/:id`、`/api/stats` 响应中附 `offline` 标记（列表/详情/仪表盘同时返回 `offline_after_min` 供前端提示）
- 前端：Agent 列表/详情显示红色「失联」徽标（title 提示阈值与最近活跃时间）；仪表盘「启用主机」卡显示 `· N 失联`；agent 恢复心跳后自动变回在线（无需手动操作）

## docker 多主机测试环境（/docker/pi-hosts，2026-08-16）

本地多主机测试：3 个 docker 容器模拟 3 台远端主机（node + pi + chat-bridge + sshd），用于多会话/多主机/run_user 端到端验证。**不进仓库，属本地基础设施**（/docker 约定）。

- **镜像**：`pi-market/pi-host:0.1`（Dockerfile 在 `/docker/pi-hosts/build/`）——node:22-slim + pi CLI（COPY 自本机 npm 全局包）+ openssh-server + sudo；用户 `app`（bridge 运行者，uid 1000）+ `pi-agent`（run_user 测试）；sudoers 允许 app 无密码 sudo（测试 run_user 切换）
- **编排**：`/docker/pi-hosts/docker-compose.yml`——3 个 service（host-1/2/3），端口 **2201/2202/2203 → 22**（SSH）；bridge 脚本与 node_modules 挂载自 `~/projects/pi-market`（改代码即生效，无需重建镜像）；`~/projects` 各挂 `/docker/pi-hosts/host-N/projects`（持久化，各 3 个子目录：web-app/blog/api-gateway、data-etl/reports/warehouse、ml-pipeline/docs/experiments）
- **pi 模型配置**：`/docker/pi-hosts/conf/{models,settings}.json`（含 relay key，从本机 ~/.pi/agent 拷出），容器 entrypoint 拷到 app/pi-agent 的 ~/.pi/agent/
- **启动**：`cd /docker/pi-hosts && docker compose up -d`（先注册 3 个 agent 拿 key 填 .env）；SSH 登录 `ssh app@127.0.0.1 -p 2201`（root/app 密码 `pi-host`）
- **平台 agent**：docker主机-1（id 13）/ docker主机-2（id 14）/ docker主机-3（id 15），各上报 3 个目录；**bridge 的 run_user 修复**（spawnPiProcess→piInvocation 绝对路径解析）由此环境实测（pi-agent 用户回复验证）
- **改 bridge 后**：`docker restart pi-host-N`（脚本 ro 挂载实时生效）

## 配置（.env）

```
PORT=3000
DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME   # MariaDB 连接
SESSION_SECRET                                # 会话密钥（生产必须改）
```
