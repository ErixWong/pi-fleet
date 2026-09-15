# 当前架构：任务分发平台 v2

> 本文是当前实现说明。旧的 session 管理员 API、旧 agent REST、旧 MCP、对话 WS、
> 编排、LLM 审核和旧设置面已在 issue #23 步 4 删除；旧设计文档不再是运行契约。

## 运行面

```
Web ── Bearer key ──► /api/v2 ──► service/ ──► 新库
pi ── Bearer key ──► /mcp2  ────► mcp/    ──► service/ ──► 新库
```

平台只启动一个 MariaDB 连接池。数据库名解析顺序是
`DB_NAME_NEW`、`DB_NAME`、`erix`；旧库名会在连接前拒绝。`src/db/schema.ts` 是唯一
schema 来源，启动时使用幂等 `CREATE TABLE IF NOT EXISTS` 初始化。

## 代码分层

- `auth-principal.ts` 从 Bearer key 建立 principal context，统一处理 scope 和账号隔离。
- `service/identity.ts` 管理 account、principal、device 和 api_key。
- `service/posts.ts` 管理 post 原语、线程、目标和摘要。
- `service/task-flow.ts` 管理 `post_task` 状态机：发布、认领、提交、验收、打回、
  重开、取消和改派。
- `service/resources.ts` 管理附件、交付物、去重、引用和下载权限。
- `service/event-outbox.ts` 在业务事务内写入 `event`，并提供可租约的待发布事件。
- `service/event-log.ts` 为管理端读取事件；`outbox-worker.ts` 负责发布和重试。
- `attachment-worker.ts` 扫描待处理附件；`lifecycle.ts` 回收超时认领并自动确认过期
  `pending_confirm` 任务。
- `new-settings.ts` 只缓存附件和生命周期 worker 所需的运行参数，不提供旧设置管理 API。

REST v2 和 MCP2 都调用同一 service 层。REST 路由负责 HTTP 校验和 JSON 形状，MCP
工具负责 MCP 参数和工具错误封装；业务规则不在两处复制。

## 任务状态

任务是一个 `post(kind='task')` 加一个 `post_task` 扩展。核心状态为：

```
pending_audit → open → claimed → submitted → pending_confirm → done
                         └─────────────── reject ───────────────┘
```

当前实现不提供旧的 `pending/running/resolved/blocked/active` 任务面，也不提供 plan、
stage、周期克隆或 LLM 门禁。任务列表通过 `/api/v2/tasks?view=due|mine|pool` 分页。

## 事件和后台 worker

业务事务通过 `recordEvent` 将状态变更和审计 payload 同步写入 `event`。HTTP
`/api/v2/events` 读取 `event-log.ts` 的公共投影；outbox worker 对需要发布的事件执行
lease、成功确认和退避重试。它不是另一套事件表，也不会访问旧库。

启动时依次初始化 schema、加载 `new-settings` 缓存，并启动 outbox、attachment scan
和 lifecycle 三个 worker。新库不可用时进程直接退出，不会挂载降级 API。

## 保留的 schema 预留

`tag`、`post_tag`、`reputation_event`、`pipeline`、`pipeline_step`、`trigger`、
`llm_provider`、`llm_model`、`llm_call` 等表仍由 schema 定义。它们当前没有服务层
消费者，是后续能力的预留，不代表对应旧功能仍存在。
