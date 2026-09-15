# AGENTS.md — 任务分发平台

本仓库是任务分发反馈平台（Web + REST v2 + MCP2），管理账号、主体、任务、交付物和
Linux 主机上的 pi-agent。Issue #23 步 4 完成后，平台只认新数据结构和新数据库；旧模型、
旧路由、旧 MCP、旧会话与旧调度代码均已删除。

## 常用命令

```bash
npm run dev          # 开发：tsx 运行 src/index.ts
npm run build        # tsc + web Vite build
npm start            # 生产：node dist/src/index.js
npm run typecheck    # TypeScript 类型检查
npm run test:unit    # 新模型单元测试
npm run test:v2      # MCP2、REST v2、事件 outbox 验收
npm run test:web     # Playwright Web v2 验收
npm test             # test:unit + test:v2 + test:web
npm run db:backup -- --database erix [--out <path>]  # 备份结构和数据
npm run db-rebuild -- --database erix               # 清空并重建 25 张表
npm run db-verify -- --database erix                # 校验新库结构
npm run create-admin -- --database erix --username <name> --account-name <name>  # 密码用 ADMIN_PASSWORD
```

`test:v2` 与 `test:web` 要求平台已启动并连接新库。Web 验收不会把账号密码写入仓库，
运行前必须设置 `TEST_USERNAME`、`TEST_PASSWORD`，可选 `TEST_ACCOUNT_NAME` 和
`TEST_BASE`。`DB_NAME_NEW` 优先于 `DB_NAME`，默认库名为 `erix`；若解析到旧库名，
连接池会在建立连接前失败。生产环境应显式设置 `DB_NAME_NEW`。

新库初始化流程：先执行 `npm run db:backup -- --database <name>` 保存可恢复备份，
再执行 `npm run db-rebuild -- --database <name>`，然后用
`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`ADMIN_ACCOUNT_NAME` 环境变量（或命令行参数）
执行 `npm run create-admin`。管理员登录成功后，再从 Web 或 REST v2 注册主机并保存
一次性主机 key。备份工具默认写入 `~/backups/<db>-<YYYYMMDD-HHMMSS>.sql`，
也可通过 `--out <path>` 指定文件；备份包含 `SHOW CREATE TABLE` 结构和逐行数据
`INSERT`，不依赖 `mysqldump`。

## 架构速览

```
src/
├── index.ts                 # 仅初始化新 schema、挂载 /api/v2、/mcp2 和静态 Web
├── config.ts                # 端口与唯一新库连接配置
├── id.ts                    # 新模型字符串 ID
├── auth-principal.ts        # Bearer API key、scope、AsyncLocalStorage principal
├── db/
│   ├── pool.ts              # 新库连接池、事务、schema 初始化
│   └── schema.ts            # 新模型表定义（包括暂未使用的扩展表）
├── service/
│   ├── identity.ts          # account/principal/device/api_key
│   ├── posts.ts             # post、线程、目标和摘要
│   ├── resources.ts         # attachment、deliverable 与权限
│   ├── task-flow.ts         # task 状态机、认领、提交、验收和重开
│   ├── event-outbox.ts      # 事务内事件写入和 outbox lease
│   ├── event-log.ts         # 事件日志查询展示
│   ├── outbox-worker.ts     # outbox 发布 worker
│   ├── attachment-worker.ts # clamd/降级附件扫描 worker
│   ├── lifecycle.ts         # claim 回收、pending_confirm 自动确认
│   └── new-settings.ts      # 附件和生命周期运行参数缓存
├── mcp/
│   ├── index.ts             # MCP2 server 工厂
│   ├── identity-tools.ts    # whoami/key 相关工具
│   ├── post-tools.ts        # post 工具
│   ├── task-tools.ts        # task 工具
│   └── resource-tools.ts    # attachment 工具
└── routes/
    ├── mcp.ts               # 仅 Streamable HTTP /mcp2
    └── v2/                  # /api/v2 REST 路由
```

`client/` 使用 `/api/v2` 和 `/mcp2`，`web/` 使用 Bearer key 登录和 `/api/v2`。
平台启动只保留 schema 初始化、outbox worker、attachment worker 和 lifecycle worker；
新 settings 缓存初始化是这些 worker 所需的运行参数加载，不是旧管理设置面。

## 新模型约定

- 数据库只通过 `src/db/pool.ts` 访问，业务代码不得创建旧库连接。
- 时间由 Node 生成本地 `YYYY-MM-DD HH:mm:ss` 字符串，SQL 不负责业务时间判断。
- 主键是 `newId(prefix)` 生成的字符串，连接池使用 `dateStrings`。
- 业务写入先进入 `service/`，REST 与 MCP2 只做鉴权、参数转换和出参适配。
- 主体鉴权使用 `Authorization: Bearer <api-key>`；scope 不足时按资源不存在返回。
- `/api/v2/attachments` 和 MCP2 attachment 工具共享 `resources.ts` 的权限与元数据，
  HTTP 下载助手已内联在 v2 路由中。
- `event-outbox.ts` 在业务事务中写入 `event`，`event-log.ts` 读取同一事件表给管理
 端展示，`outbox-worker.ts` 负责发布/重试；三者不是旧 events 服务的双写关系。

## 已删除、不可再引用的旧面

旧 session/scrypt 管理员鉴权、旧 `db.ts` 和 `task_dispatch` 业务连接池、旧
`/api` 管理员 REST、`/api/agent`、`/mcp`、对话 WS、旧 MCP tools、旧任务/市场/计划/
聊天/LLM/附件/事件/设置/标签 service，以及旧迁移、清理、模拟和验收脚本都不再存在。

对话、编排、LLM 审核/验收、旧设置管理页、标签业务和旧 agent REST 不属于当前产品
协议。前端的旧页面路径由 SPA fallback 回到可用入口，但不会重新提供旧 API。

## Schema 说明

不要在本步修改 `src/db/schema.ts`。`tag`、`post_tag`、`reputation_event`、
`pipeline`、`pipeline_step`、`trigger`、`llm_provider`、`llm_model`、`llm_call`
等表按目标数据模型保留，即使当前没有对应业务服务；它们是后续能力的 schema 预留，
不是旧面消费者。

## 验收和改动纪律

- Web 验收覆盖登录、Dashboard 摘要、任务筛选/分页、任务详情九键契约、一次性主机
  key 和已删除前端路由的可用回落。
- v2 验收脚本只连接 `DB_NAME_NEW`（或新库默认值），不得比较、读取或写入旧库。
- 修改 schema 时先同步 `db-rebuild` / `db-verify`；本步骤保持 schema 原样。
- 完成功能或修复并通过验收后提交一次中文 `feat:`/`fix:` commit，并提醒推送远程。
