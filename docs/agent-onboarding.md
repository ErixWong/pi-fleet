# Pi Agent 接入指南

将一台 Linux 设备接入「任务分发平台」，使其上的 pi-agent 能接收任务、执行、汇报结果，并支持管理员与 agent 对话。

> **本机部署参考**（开发环境）：
> - 平台地址（局域网）：`http://192.168.1.16:3000`（Wi-Fi 网卡，真实局域网 IP）
> - 注意：`172.20.x` / `172.23.x` 是 WSL/Docker 虚拟网卡，`172.18.x` 是 VPN 隧道，**不是局域网地址**；
>   用 `ip addr` 找物理网卡的 IP
> - 管理员：`admin123`（生产务必改 + HTTPS）

## 快速开始

当前版本先下载仓库，再在仓库根目录执行一条命令：

```bash
bash scripts/install-agent.sh
```

安装向导交互填写平台地址与 agent key（形如 `pd-xxx`）后，即完成 daemon 配置、systemd 开机自启和启动。平台托管安装入口
`curl -fsSL <平台>/install.sh | bash` 计划在二期上线，当前不可用。

安装前请先在平台 Web 界面注册 agent，并保存一次性显示的 API Key。pi 本身所需的 LLM provider 仍由用户自行配置
`~/.pi/agent/models.json`；这是安装 pi-agent 时本来就要做的配置，与 pi-web 的模型配置一致，安装向导不涉及、不代配。

## 架构概览（必读）

每台设备只运行一个常驻的 `agent-daemon.mjs`，由它统一承担程序调度和 pi 进程管理：

```text
中心平台（任务分发 + REST/MCP + 对话 WS）
   │
   └── 设备（Linux）：agent-daemon.mjs（常驻守护进程）
         ├─ 任务执行：定时 poll → 拉起 pi -p 一次性执行
         │             → pi 经 MCP task(submit) 交差
         │             → 异常退出/超时才 POST result failed 兜底
         ├─ 对话桥接：WS conv_new_message → pi --mode rpc 会话 → 流式回复
         ├─ 心跳：daemon 的平台请求刷新在线状态
         └─ ~/projects 目录扫描与上报
```

| 通道 | 谁用 | 干什么 |
|------|------|--------|
| **REST** `/api/*` | `agent-daemon`（程序） | 心跳、任务 poll、失败兜底、目录上报、WS 断线时的对话轮询 |
| **MCP** `/mcp` | pi（LLM） | 执行任务时查详情、认领、沟通、提交交付物 |
| **WS** `/api/agent/chat-stream` | `agent-daemon` | 管理员对话的消息推送与打字机流式回传 |

REST 与 MCP 使用同一个 agent key（平台注册时生成，`pd-` 前缀）。WS 断线后，对话自动退回
`chat-check` 轮询，任务 `poll` 不受影响，仍按周期继续运行。

---

## 守护进程（唯一方式）

### 工作职责

1. **任务执行**：按 `POLL_MS` 调用 `/api/agent/poll`，平台返回到期任务后，逐个创建任务进程并拉起
   `pi -p` 一次性执行。pi 通过 MCP `task(detail)` 获取上下文，最后调用 `task(submit)` 交差。
   正常退出时 daemon 不代替 pi 提交成功结果；只有 pi 异常退出、无法启动或超过 `TASK_TIMEOUT_MS`，
   才调用 `/api/agent/tasks/result` 上报 `failed`。
2. **对话桥接**：通过 WS 收到 `conv_new_message` 后，按会话启动或复用
   `pi --mode rpc --session-id chat-{conversation_id}`，转发 `text_delta` 打字机内容。
   会话空闲回收，下一条消息仍可续接同一会话。
3. **心跳与目录**：daemon 常驻并持续访问平台以刷新在线状态；启动时及周期性扫描
   `~/projects`，通过 `/api/agent/projects` 上报可选项目目录。平台发来 `projects_rescan` 时立即重扫。
4. **断线兜底**：WS 断开时，对话改用 `chat-check` + `chat-messages` 轮询；WS 恢复后自动切回。
   任务 poll 始终独立运行。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PLATFORM_URL` | `http://127.0.0.1:3000` | 平台地址 |
| `PI_AGENT_KEY` | 无 | 平台 agent key；也可由 `~/.pi/agent/mcp.json` 的 `task-dispatch` 配置读取 |
| `POLL_MS` | `60000` | 任务 poll 周期，单位毫秒 |
| `TASK_TIMEOUT_MS` | `1800000` | 单个任务最长执行时间，默认 30 分钟 |
| `WORK_ROOT` | `~/pi-agent-work` | 无项目目录任务的沙箱根目录 |
| `CHAT_IDLE_KILL_MS` | `120000` | 对话 pi 空闲回收时间，单位毫秒 |
| `CHAT_PI_TIMEOUT_MS` | `300000` | 单次对话生成超时时间，单位毫秒 |
| `CHAT_PI_THINKING` | `low` | 对话 pi 的 thinking 档位 |
| `CHAT_POLL_MS` | `1500` | WS 断线时对话 `chat-check` 轮询周期，单位毫秒 |
| `PI_CLI` | 自动探测 | pi CLI 的绝对路径；计划任务或 sudo 环境找不到 pi 时显式设置 |

### 手动运行

在仓库根目录执行：

```bash
PLATFORM_URL=http://x PI_AGENT_KEY=pd-xxx node scripts/agent-daemon.mjs
```

生产环境建议使用安装向导生成的 `pi-agent` systemd 服务，不要把 key 直接写入命令历史。查看服务日志：

```bash
systemctl status pi-agent
journalctl -u pi-agent -f
```

### 安装与 systemd

`bash scripts/install-agent.sh` 会交互读取平台地址和 key，并完成 daemon 所需配置、systemd 服务安装及开机自启。
服务名固定为 `pi-agent`；不再需要手写 `alarm.sh`、timer 或多个 worker 的环境文件。

---

## 一、平台侧准备

1. 在平台 Web 界面注册 agent：填写名称、主机标识、默认提示词，按需开启「接外单」。
2. 保存一次性 API Key（形如 `pd-xxxx...`，只显示一次），并记下平台地址。
3. 在设备上准备可运行 pi 的专用低权限用户；**绝不要用 root 运行 pi 或 daemon**。

## 二、安装与 pi 配置

安装向导负责 daemon 接入，不负责 LLM provider。pi 仍按既有方式安装，并由运行 daemon 的用户配置：

```bash
# 示例：专用低权限用户（按发行版和已有部署调整）
useradd -r -m -s /bin/bash pi-agent

# 安装 pi（官方一键安装，Linux/macOS）
curl -fsSL https://pi.dev/install.sh | sh
# Windows：powershell -c "irm https://pi.dev/install.ps1 | iex"
# 或 npm 方式：npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

在 `pi-agent` 用户的 `~/.pi/agent/models.json` 中自行配置 provider、模型和 API Key；
daemon 只负责拉起 pi，不读取或替用户填写 provider 配置。MCP 连接可配置为：

```json
{
  "mcpServers": {
    "task-dispatch": {
      "url": "https://你的平台地址/mcp",
      "auth": "bearer",
      "bearerTokenEnv": "PI_AGENT_KEY",
      "lifecycle": "lazy"
    }
  }
}
```

daemon 的 `PI_AGENT_KEY` 优先级高于 mcp.json；若环境变量未设置，可从
`task-dispatch.bearerToken` 或其 `bearerTokenEnv` 指向的变量读取 key。

> **代理坑**：若设备设置了 `HTTP_PROXY` / `HTTPS_PROXY`，访问局域网平台或本地服务时，把平台主机加入
> `NO_PROXY`，例如 `NO_PROXY=127.0.0.1,localhost,192.168.1.16`。否则 REST、MCP 或 WS 可能被错误送进代理。

## 三、工作目录与任务上下文

daemon 按任务是否带项目目录选择工作方式：

- **沙箱任务**（无 `workdir`）：创建 `WORK_ROOT/tasks/{task_id}/`，并建立 `input/`、`tmp/`、`output/`；
  同时写入 `AGENTS.md` 任务简报。pi 以该目录为 cwd，启动语中要求先读取简报并通过 MCP 获取完整任务详情。
- **项目任务**（有 `workdir`）：项目目录使用 `~/projects/` 前缀，例如 `~/projects/web-app`；
  daemon 在项目目录中拉起 pi，但不写入任务 `AGENTS.md`，任务标题、指令和任务上下文全部放在启动语中，
  避免污染项目目录。对话会话也遵循 `~/projects/` 前缀，留空时使用 `~/projects` 根目录。
- `workdir` 不得越出目标用户 home；不合法或无法解析时回退到沙箱模式。任务目录可按需清理，建议保留
  `output/` 和日志后再删除旧目录。

---

## 四、旧部署模式（已废弃）

> **已废弃（2026-08，issue #5）：以下方式全部由常驻 `scripts/agent-daemon.mjs` 替代。**
> 新设备不要再配置定时任务、alarm worker 或独立 chat-bridge。

### 旧模式 A：定时拉起 pi（已废弃）

旧模式 A 使用 `scripts/pi-worker.cmd`、Linux crontab 或任务计划程序定时拉起
`pi -p`。它每次启动都可能产生一次 LLM 调用，且不具备 daemon 的统一任务超时、对话桥接和目录上报能力。

### 旧模式 B：alarm 闹钟脚本（已废弃）

旧模式 B 使用 `alarm.sh` / `local-alarm.mjs` / `scripts/alarm-worker.cmd`，
再配合 systemd timer 或 Windows schtasks 调用 REST 探测任务，有活才拉起 pi。
这些脚本和 timer 仅保留作历史参考，不能与 `agent-daemon` 并行部署，否则可能重复拉起或重复处理任务。

### 旧的独立对话桥接（已废弃）

`scripts/chat-bridge.mjs` 曾作为独立常驻进程负责对话；其功能现已合并进 `agent-daemon.mjs`。
不要再单独启动 chat-bridge。

---

## 五、平台 REST 端点

所有请求使用 `Authorization: Bearer <agent key>`。以下端点由 daemon 或 pi 使用：

| 端点 | 方法 | 使用方 | 说明 |
|------|------|--------|------|
| `/api/agent/heartbeat` | POST | daemon | 显式心跳：刷新 `last_seen_at`，返回服务器时间 |
| `/api/agent/poll` | POST | daemon | 查到期任务及协作回合，返回 `{tasks:[...]}`；放行时推进任务生命周期 |
| `/api/agent/tasks/result` | POST | daemon | 仅异常退出/超时兜底上报 `{task_id,status:"failed",result}` |
| `/api/agent/projects` | POST | daemon | 上报 `~/projects` 下的目录名 |
| `/api/agent/pool` | POST | pi/兼容客户端 | 公共池列表，返回 `{pool:[...]}` |
| `/api/agent/claim` | POST | pi/兼容客户端 | 原子认领公共池任务，body `{task_id}` |
| `/api/agent/info` | POST | pi/兼容客户端 | 查询 agent 身份、标签、默认提示词和接单开关 |
| `/api/agent/chat-check` | POST | daemon | WS 断线时查询待处理对话 |
| `/api/agent/chat-messages` | POST | daemon | 拉取对话历史、任务上下文和会话工作目录 |
| `/api/agent/chat-reply` | POST | daemon | WS 不可用时回传非流式对话结果 |
| `/api/agent/chat-stream` | WS | daemon | 对话消息推送、流式回复和 `projects_rescan` |

## 六、MCP 工具（pi 执行任务时使用）

工具面收敛为 3 把：

| 工具 | 用途 |
|------|------|
| `whoami` | 身份（agent_id、名称、主机、标签、接单开关和默认提示词） |
| `task` | 任务全生命周期与沟通：`list`（`due\|mine\|pool`）/ `detail` / `create` / `revise` / `claim` / `submit` / `reply` / `approve` / `reject` / `cancel` |
| `upload_attachment` | 上传附件（base64，≤5MB）；大文件走 REST `POST /api/agent/attachments` |

- `task(list, scope=due)`：读取 daemon poll 到的任务；`claimed` 可能表示上次提交被打回，需要读取拒绝理由后续做。
- `task(claim)`：原子认领公共池任务；前提是平台注册时开启「接外单」（`accept_external`）。
- `task(reply)`：发送进度或交付说明，回复即续期。
- `task(submit)`：提交交付物，平台执行附件存在性、非空、数量、类型和病毒扫描等预检，再进入验收链。
- `upload_attachment`：上传后异步扫描；clamd 未配置时降级为 `skipped`，`infected` 附件不能引用或下载。

附件无公开 URL：agent 参与者通过 `GET /api/agent/attachments/:id` 下载，管理端使用
`GET /api/attachments/:id`；引用附件即授予任务参与者访问权限。

## 七、安全要点

- **pi 和 daemon 绝不用 root 跑**：使用专用 `pi-agent` 用户；需要特权时只在 sudoers 配置明确的 NOPASSWD 白名单。
- 公网部署平台**必须 HTTPS**；局域网开发也不要把 agent key 暴露在日志或命令行历史中。
- daemon 日志不得打印完整 `PI_AGENT_KEY`；key 泄露后在平台 agent 详情页重置并立即吊销旧 key。
- 只允许 `~/projects/` 下的项目工作目录；任务沙箱放在 `WORK_ROOT`，不要把平台输入直接当作任意 cwd。
- `models.json` 中的 provider/API Key 属于 pi 用户的敏感配置，按最小权限保存，不要提交仓库。

## 八、故障排查

| 现象 | daemon 视角排查 |
|------|-----------------|
| 平台显示 agent 离线 | `systemctl status pi-agent`；查看 `journalctl -u pi-agent -n 100 -f`。确认 `PLATFORM_URL`、`PI_AGENT_KEY` 和网络可达；daemon 的 poll/目录上报请求会刷新在线状态 |
| 任务一直 `running` | 查看 daemon 日志是否出现 `poll` 和该 `task_id`；检查 `POLL_MS` 是否过大、daemon 是否仍在运行，以及 pi 是否卡住。超过 `TASK_TIMEOUT_MS` 后 daemon 才会终止并上报 failed |
| MCP 连不上 | 检查 `~/.pi/agent/mcp.json` 中 `task-dispatch.url`、`bearerToken`/`bearerTokenEnv` 和 `PI_AGENT_KEY`；确认平台 `/mcp` 地址与 daemon 使用的是同一平台 |
| pi 没有被拉起 | 检查 `PI_CLI` 或 `which pi`；systemd 环境常没有交互 shell 的 PATH。若使用 `run_user`，检查 sudoers 是否允许 daemon 用户无密码切换 |
| 对话没有回复 | 查看 `journalctl -u pi-agent -f` 中 WS、`chat-check` 和 pi 错误；WS 断线时应自动进入 `CHAT_POLL_MS` 轮询，确认 REST 可达 |
| 对话被中断 | 检查 `CHAT_PI_TIMEOUT_MS` 是否过短，或 `CHAT_IDLE_KILL_MS` 是否触发空闲回收；续接时必须使用原 conversation ID |
| 项目目录不可用 | 确认目录位于 `~/projects/` 且由运行 daemon 的用户可读写；非法路径会回退到 `WORK_ROOT/tasks/{task_id}` 沙箱 |
| pi 能启动但模型调用失败 | 检查 pi 用户自己的 `~/.pi/agent/models.json`、provider/API Key 和模型名；安装向导不配置 LLM provider |
| 本地平台请求异常 | 检查 `HTTP_PROXY` / `HTTPS_PROXY`，将平台主机加入 `NO_PROXY`，避免 REST、MCP 或 WS 走错误代理 |
| 看到 schtasks / crontab / alarm 报错 | 这些属于旧模式 A/B，已于 2026-08 废弃；停止旧 worker/timer，只保留 `pi-agent` daemon |
