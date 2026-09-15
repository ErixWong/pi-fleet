# @pi-market/pi-agent-client

`pi-agent` 是运行在 Linux 主机上的 pi 任务执行守护进程（Node.js >= 18）。
它只使用 v2 协议：daemon 轮询任务，pi 通过 MCP 读取上下文、认领并提交交付物。

## 安装与注册

1. 平台管理员在目标账号中创建 host principal，并为它创建包含
   `task:read`、`task:claim`、`task:submit` 的 API key。
2. 在执行 pi 的主机上安装客户端和 pi：

   ```bash
   npm install -g @pi-market/pi-agent-client
   ```

3. 只需配置一次平台地址和管理员签发的 key：

   ```bash
   pi-agent setup --key=<key> --url=https://platform.example
   ```

   `--url` 可省略，默认 `http://127.0.0.1:3000`。setup 不创建账号、主机或
   API key；这些注册操作必须由平台管理员完成。

## 运行

前台运行：

```bash
pi-agent run
```

Linux 上安装 systemd 服务：

```bash
sudo pi-agent install-service
sudo systemctl status pi-agent
sudo journalctl -u pi-agent -f
```

卸载服务：

```bash
sudo pi-agent uninstall-service
```

## setup 写入的配置

- `~/.config/pi-agent/config.json`：平台 URL 和 API key（权限 `600`）。
- `~/.pi/agent/mcp.json`：合并 `task-dispatch` MCP server，URL 为
  `<platform>/mcp2`，原文件备份为 `mcp.json.bak-pi-agent`。daemon 每次启动都会
  幂等同步这个条目，保留其他 MCP server，并在平台地址或 key 变化后自动更新。

pi 的模型/provider 配置仍由用户自行维护。daemon 不运行专用心跳；每次带
Bearer key 的任务列表请求会自动刷新主机活跃时间。

## v2 任务协议

- daemon 使用 `GET /api/v2/tasks?view=due&page_size=N`，请求带
  `Authorization: Bearer <key>`。
- 每个返回任务由一个 pi 进程处理。pi 使用 MCP `post(detail)` 获取完整上下文，
  必要时使用 `task(claim)`，完成后使用 `task(submit)` 提交交付物。
- pi 正常退出后 daemon 会校验任务状态；如果 pi 已通过 MCP 提交则保持正常路径，
  如果仍为 `claimed`，daemon 会收集沙箱产物并调用
  `POST /api/v2/tasks/:id/submit` 兜底提交。pi 异常退出或超过 `TASK_TIMEOUT_MS`
  时仍按失败预检路径提交 `{ "deliverables": [], "message": "..." }`，触发平台
  失败预检和重试计数。

可选环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PLATFORM_URL` | setup 中的 URL | 覆盖平台地址 |
| `PI_AGENT_KEY` | setup 中的 key | 覆盖 API key |
| `POLL_MS` | `60000` | 任务轮询间隔（毫秒） |
| `CHANNEL_POLL_MS` | `5000` | 一对一主机对话轮询间隔（毫秒） |
| `CHANNEL_TIMEOUT_MS` | `300000` | 单次主机对话 pi 超时（毫秒） |
| `CHANNEL_MAX_CONCURRENCY` | `2` | 同时运行的不同通道 pi 实例上限 |
| `CHANNEL_STATE_PATH` | `~/.config/pi-agent/channels-state.json` | 通道消息游标持久化路径 |
| `TASK_PAGE_SIZE` | `20` | 每次请求任务数（最大 200） |
| `TASK_TIMEOUT_MS` | `1800000` | 单任务超时（毫秒） |
| `WORK_ROOT` | `~/pi-agent-work` | 无指定 workdir 时的沙箱根目录 |
| `PI_CLI` | 自动探测 `pi` | pi CLI 的绝对路径 |

Windows 可使用 `pi-agent run` 前台运行；`install-service` 仅适用于 Linux
systemd。
