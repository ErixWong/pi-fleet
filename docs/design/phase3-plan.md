# 期 3 计划归档

本文是 issue #23 步 4 之前的历史实施计划，不再作为运行契约。计划中的双库并行、
迁移脚本、旧 `/api`、旧 `/mcp`、session 管理员、对话、编排和 LLM 门禁均已删除，
历史迁移不在本仓库重跑。

当前实现以以下文档和代码为准：

- `AGENTS.md`：命令、架构、已删除面和 schema 约定；
- `docs/design/architecture.md`：v2 service、REST 和 MCP2 分层；
- `docs/agent-onboarding.md`：pi-agent 的 `/api/v2` 与 `/mcp2` 协议；
- `src/db/schema.ts`：唯一新模型表定义；
- `scripts/*-v2.mjs`：REST、MCP2 和事件验收。

旧库在本步不 drop；删除和归档属于后续独立步骤。
