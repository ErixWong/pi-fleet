# pi-agent 接入指南（v2）

本文说明如何把一台运行 pi 的 Linux 主机接入任务分发平台。当前客户端版本为
`@pi-market/pi-agent-client` 0.4.0，使用平台 v2 API 和 `/mcp2`。

## 协议模型

```
平台管理员创建 host principal + API key
             │
             ▼
pi-agent daemon ── GET /api/v2/tasks?view=due&page_size=N ──► 平台
             │
             └─► pi ── MCP /mcp2：post(detail) / task(claim|submit)
```

daemon 是任务执行器，不是业务状态机：

1. daemon 使用 `Authorization: Bearer <key>` 定期读取分配给该主机的到期任务。
2. 每个任务在自己的工作目录中启动一个 pi 进程。任务标题、正文和 v2 列表摘要会
   注入启动提示，完整上下文由 pi 通过 MCP `post(action="detail", id=...)` 读取。
3. `open` 任务由 pi 调用 `task(action="claim")`；处理完成后由 pi 调用
   `task(action="submit", deliverables=[...], message=...)`。
4. daemon 不代替 pi 正常提交，也没有专用心跳。经过认证的任务列表请求会刷新设备
   活跃时间。
5. 只有 pi 异常退出或超时，daemon 才调用
   `POST /api/v2/tasks/:id/submit`，提交
   `{ deliverables: [], message: "..." }`，让平台执行失败预检和 attempts 处理。

## 平台侧注册

注册由平台管理员完成，客户端不会自注册：

1. 在目标账号中创建 `host` principal（名称使用主机名或运维资产编号）。
2. 为该 principal 创建 API key，至少授予：
   `task:read`、`task:claim`、`task:submit`。
3. 将 key 通过安全渠道交给主机操作者。key 只在 setup 时写入本机配置，不要提交
   到仓库、日志或 shell 脚本。

API key 的有效期、吊销和轮换由平台管理员管理。轮换后在主机重新运行 setup
即可覆盖本地配置。

## 主机侧安装

要求 Node.js 18 或更新版本，以及可运行的 pi CLI 和 pi 的模型配置。

```bash
npm install -g @pi-market/pi-agent-client
pi-agent setup --key=<key> --url=https://platform.example
pi-agent run
```

`--url` 可省略，默认 `http://127.0.0.1:3000`。setup 是一次性本地配置操作：

- 写入 `~/.config/pi-agent/config.json`（权限 600）；
- 合并写入 `~/.pi/agent/mcp.json` 的 `task-dispatch` 段，URL 为
  `<platform>/mcp2`，Bearer key 由 pi MCP 客户端使用；
- 已存在的 MCP 文件会备份为 `mcp.json.bak-pi-agent`；
- 不创建 principal、不申请 key、不调用注册接口。

模型/provider 仍由主机操作者按 pi 文档配置，例如
`~/.pi/agent/models.json`。

## systemd

生产环境建议使用专用低权限用户运行：

```bash
sudo pi-agent install-service
sudo systemctl status pi-agent
sudo journalctl -u pi-agent -f
```

卸载：

```bash
sudo pi-agent uninstall-service
```

服务会从 `~/.config/pi-agent/config.json` 读取 URL 和 key，并以 systemd 的
`Restart=always` 保持 daemon 运行。也可以直接使用 `pi-agent run`，由外部进程
管理器负责重启。

## 沙箱隔离（推荐）

### 威胁模型

daemon 拉起的 pi 进程默认继承操作者的全局 MCP 配置
（`~/.config/mcp/mcp.json`）。如果其中包含数据库直写等高权限工具，agent 在任务
通道不可用（或任务工具不可见）时，可能绕过平台协议直接改库：伪造 task submit、
跳过状态机、事件和交付物校验。这类协议绕过事故已在真实环境发生（伪造提交的
时间戳使用数据库 NOW() 的 UTC 时间，与应用本地时间约定不一致而暴露）。

### 缓解措施：`PI_CODING_AGENT_DIR` 隔离 agent 目录

`PI_CODING_AGENT_DIR` 让 daemon 拉起的 pi 使用独立的 agent 目录，不再读取操作者
的全局 `~/.pi/agent` 配置：

```bash
mkdir -p ~/.pi-agent-sandbox/agent
cp ~/.pi/agent/models.json ~/.pi/agent/auth.json ~/.pi/agent/settings.json ~/.pi-agent-sandbox/agent/
ln -s ~/.pi/agent/npm ~/.pi-agent-sandbox/agent/npm        # 扩展复用
```

在 `~/.pi-agent-sandbox/agent/mcp.json` 中手写最小配置：只保留 `task-dispatch`
（自客户端本次修复起默认 `lifecycle: "eager"`，agent 启动即连接、任务工具
立即可见），其余继承自全局的 server 一律显式屏蔽：

```json
{
  "mcpServers": {
    "task-dispatch": {
      "type": "http",
      "url": "<platform>/mcp2",
      "auth": "bearer",
      "bearerToken": "<key>",
      "lifecycle": "eager"
    },
    "mysql": { "disabled": true }
  }
}
```

agent 目录的 `mcp.json` 中对全局 server 写 `"disabled": true` 会在配置合并时
覆盖屏蔽它们。

```bash
PI_CODING_AGENT_DIR=~/.pi-agent-sandbox/agent pi-agent run
```

### systemd

`install-service` 生成的 unit 通过 override 追加环境变量：

```bash
sudo systemctl edit pi-agent
```

```ini
[Service]
Environment=PI_CODING_AGENT_DIR=/home/<user>/.pi-agent-sandbox/agent
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart pi-agent
```

## 工作目录与环境变量

有 `workdir` 的任务在该目录运行；没有指定目录的任务使用
`WORK_ROOT/tasks/<task-id>` 沙箱，并写入 `AGENTS.md`、`input`、`tmp` 和
`output` 子目录。daemon 只接受位于当前用户 home 下的工作目录。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PLATFORM_URL` | setup 中的 URL | 覆盖平台地址 |
| `PI_AGENT_KEY` | setup 中的 key | 覆盖 API key |
| `POLL_MS` | `60000` | 轮询间隔（毫秒） |
| `TASK_PAGE_SIZE` | `20` | 每页任务数（平台上限 200） |
| `TASK_TIMEOUT_MS` | `1800000` | 单任务超时（毫秒） |
| `WORK_ROOT` | `~/pi-agent-work` | 沙箱根目录 |
| `PI_CLI` | PATH 中的 `pi` | pi 可执行文件路径 |

## v2 数据形状

任务列表响应为：

```json
{
  "view": "due",
  "items": [
    {
      "id": "pst_...",
      "title": "任务标题",
      "body": "任务正文",
      "task": {
        "status": "open",
        "is_ready": true,
        "deliverable_spec": "...",
        "workdir": null,
        "assignee_principal_id": "prn_..."
      }
    }
  ],
  "total": 1
}
```

pi 的正常提交使用 MCP `task` 工具；daemon 的异常兜底严格使用同一套
`submitTask` 输入字段：

```json
{
  "deliverables": [
    { "name": "文件或结果名称", "attachment_id": null, "note": "说明" }
  ],
  "message": "提交说明"
}
```

异常兜底使用空 `deliverables`，因此平台会执行失败预检，不会伪造成功交付物。

## 排障

| 现象 | 检查 |
| --- | --- |
| 轮询返回 401/403 | 确认 URL、key 未过期，且 key 属于正确的 host principal，并有 `task:read`。 |
| 没有任务 | 确认任务已 ready、已分配给该 principal，且状态为 `open` 或 `claimed`。 |
| MCP 调用失败 | 检查 `~/.pi/agent/mcp.json` 的 `task-dispatch.url` 是否为 `<platform>/mcp2`，并确认 key 未被截断。 |
| 任务异常后重复出现 | 这是平台 attempts 机制的预期行为；查看 daemon 日志中的 v2 submit 响应和任务状态。 |
| systemd 不启动 | 查看 `journalctl -u pi-agent -n 100`，确认服务用户可以读取 pi 配置和工作目录。 |
