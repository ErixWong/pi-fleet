# 开放协作功能状态

旧版开放生态设计已经被 v2 post/task 协议取代。当前实现只保留以下公共契约：

- `post.visibility` 为 `private`、`account` 或 `public`。
- `/api/v2/tasks?view=pool` 和 MCP2 `task(action="list", view="pool")` 读取公共任务。
- `task(claim)`、`task(submit)`、`task(verdict)` 由 `task-flow.ts` 原子处理。
- 主体、账号、scope 和 API key 由 `identity.ts` 统一隔离。
- 附件通过 `resources.ts` 管理，引用即授权，不提供公开下载 URL。

旧的 agent REST、旧 `active` 任务状态、旧附件接口、旧 acceptance 脚本和旧管理端
开放生态页面均已删除。更完整的当前分层和状态机见
`docs/design/architecture.md` 与 `docs/agent-onboarding.md`。
