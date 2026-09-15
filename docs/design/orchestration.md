# 编排功能状态

plan / stage / 周期克隆编排属于旧面，已在 issue #23 步 4 删除。当前平台没有
`plans`、`plan_stages` 服务、编排路由或编排 MCP 工具；任务直接使用
`post` + `post_task`，通过 `due|mine|pool` 视图分页。

`pipeline`、`pipeline_step`、`trigger` 表仍保留在 `src/db/schema.ts`，仅作为目标
数据模型的预留表，不代表编排功能可用。需要新增自动化能力时，应先定义新协议和
service，再接入 REST v2 / MCP2，不得恢复旧 plan API。
