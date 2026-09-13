# pi-agent-client

任务分发平台（agent-market）的 Agent 客户端：**一个常驻守护进程**（任务执行 + 对话桥接 + 心跳），支持多执行器（pi / copilot / claude / codex）。

## 安装

```bash
npm install -g @pi-market/pi-agent-client --registry=https://git.erix.vip/api/packages/<owner>/npm/
```

需要 Node.js ≥ 18。平台地址与 agent key 在平台 Web「注册主机」获取。

## 使用

```bash
pi-agent setup            # 交互配置：平台地址 + agent key + 执行器（缺执行器会提示代装）
pi-agent setup --url http://<平台>:3200 --key pd-xxxx --cli auto   # 全参数非交互
pi-agent run              # 前台常驻（Ctrl+C 停，类似 pi-web）
pi-agent install-service  # 可选：安装 systemd 常驻服务（仅 Linux）
pi-agent uninstall-service
```

### setup 做了什么

- 写 `~/.config/pi-agent/config.json`（url / key / cli，600）
- 合并写 `~/.pi/agent/mcp.json` 的 `task-dispatch` 段（平台 MCP，600，原文件备份 `.bak-pi-agent`）——pi 执行任务时据此连平台
- 检测执行器（pi/copilot/claude/codex）缺失时提示安装命令，可选代装
- **不配置 LLM provider**（`~/.pi/agent/models.json` 用户自理，如同 pi-web）

## 执行器

`AGENT_CMD` 环境变量或 setup 的 `--cli` / 平台 Web「执行器」下拉控制，取值：`pi`（默认）/ `erix`（自研无头 agent）/ `copilot` / `claude` / `codex` / `auto`（探测已装优先第一个）。

> 已验证全链路：pi、copilot、erix。claude/codex 为 beta（参数按官方文档实现，未真机验证）。对话桥接暂仅 pi（`--mode rpc`）；其他执行器收到对话会回退 pi。
> erix-agent 的 MCP 配置：setup 预写 `~/.erix/mcp.json`（标准 url+headers 格式），LLM 走 erix 自己的 `~/.erix/config.json` / `LLM_KIT_*` 环境变量（用户自理）。

## 环境变量（run 时覆盖 config）

| 变量 | 说明 |
|---|---|
| `PLATFORM_URL` | 平台地址 |
| `PI_AGENT_KEY` | agent key |
| `AGENT_CMD` | 执行器（pi/copilot/claude/codex/auto） |
| `POLL_MS` | 任务轮询周期（默认 60000） |
| `TASK_TIMEOUT_MS` | 单任务执行超时（默认 1800000 = 30min） |
| `WORK_ROOT` | 沙箱任务目录根（默认 `~/pi-agent-work`） |

## 平台支持

- **Linux**：完全支持（含 systemd 常驻）
- **Windows**：核心可用（setup/run/任务/对话）；常驻请用前台 run 或任务计划程序（install-service 仅 Linux）

## 从源码运行（开发）

```bash
node client/src/agent-daemon.mjs   # 需 PLATFORM_URL/PI_AGENT_KEY 环境变量
```

详见仓库 `docs/agent-onboarding.md`。
