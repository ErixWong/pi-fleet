# Pi Agent 接入指南

将一台 Linux 设备接入「任务分发平台」，使其上的 pi-agent 能接收任务、执行、汇报结果。

> **本机部署参考**（开发环境）：
> - 平台地址（局域网）：`http://192.168.1.16:3000`（Wi-Fi 网卡，真实局域网 IP）
> - 注意：`172.20.x` / `172.23.x` 是 WSL/Docker 虚拟网卡，`172.18.x` 是 VPN 隧道，**不是局域网地址**；
>   用 `Get-NetIPAddress` 或 `ip addr` 找物理网卡（Ethernet/Wi-Fi）的 IP
> - 管理员：`admin123`（生产务必改 + HTTPS）

## 架构概览（必读）

每台设备上运行两层，**程序的事交给程序，智能的事交给 LLM**：

```
中心平台（任务分发 + REST/MCP）
   │ ①REST（curl，程序行为）  ②MCP（LLM 工具协议）
   ▼
Linux 设备：
  调度层（systemd 闹钟，常驻，零 token）
    ├─ 心跳 / poll 新任务 / 回传结果（REST）
    ├─ 公共池二段式扫描（§9.2 G4）：程序拉 pool 列表 → 有候选才拉起 LLM 判断认领
    └─ 拉起 / 销毁 pi（pi -p -a 一行）
  LLM 层（pi，只在有任务时存在，干完销毁）
    └─ 干活；需要时经 MCP 查详情/认领/投递报告
```

| 通道 | 谁用 | 干什么 |
|------|------|--------|
| **REST** `/api/*` | 调度脚本（程序） | 心跳、查新任务、回传最终结果 |
| **MCP** `/mcp` | pi（LLM） | 执行中查详情、投递报告、上报进度 |

两条通道使用**同一个 agent key**（平台注册时生成，`pd-` 前缀）。

---

## 一、平台侧准备

1. 在平台 Web 界面注册 agent：填写名称、主机标识、默认提示词（告知身份与职责），
   拿到一次性 API Key（形如 `pd-xxxx...`，只显示一次，请立即保存）。
2. 记下 agent 的 `agent_id`（如 `agent-xxx`）与平台地址（如 `http://10.0.0.1:3000`）。

## 二、安装

```bash
# 1. 创建专用低权限用户（pi 有 bash 工具，绝不能 root 跑）
useradd -r -m -s /bin/bash pi-agent

# 2. 安装 pi 与 pi-mcp-adapter（root 全局装）
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
su - pi-agent -c "pi install npm:pi-mcp-adapter"

# 3. 安装 pi-fleet（Pi 原生的 agent 进程管理）
npm install --global @elpapi42/pi-fleet@beta
```

## 三、敏感配置

```bash
# /etc/pi-agent/env   （root:pi-agent 640）
AGENT_KEY=pd-xxxx...            # 平台分配的 agent key
ANTHROPIC_API_KEY=sk-ant-...    # pi 的 LLM key（按你的 provider 设置）
PLATFORM_URL=http://10.0.0.1:3000
AGENT_ID=agent-xxx              # 平台上的 agent_id（仅参考，脚本从 whoami 获取更准）
WORK_ROOT=/opt/pi-agent/work    # 任务工作目录根

chown root:pi-agent /etc/pi-agent/env && chmod 640 /etc/pi-agent/env
```

## 四、工作目录与任务上下文

```bash
mkdir -p /opt/pi-agent/work && chown pi-agent:pi-agent /opt/pi-agent/work
```

- **沙箱任务**（无 workdir）：调度脚本建 `tasks/{task_id}/{input,tmp,output}`，
  写 `AGENTS.md`（任务简报，Pi 启动时自动加载），pi 就地干活。
- **项目任务**（有 workdir）：pi 的 `--cwd` 指向项目目录（加载项目自身 AGENTS.md），
  任务简报经 prompt 注入；`tasks/{task_id}/` 作为档案。
- **清理**：每日巡检删除超过 7 天的任务目录（或保留最近 N 个 output）。

## 五、调度脚本（闹钟）

```bash
# /opt/pi-agent/alarm.sh（pi-agent:pi-agent 750）
#!/usr/bin/env bash
set -euo pipefail
source /etc/pi-agent/env
LOG=/var/log/pi-agent-alarm.log
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# 1. 清理残留：杀掉超过 30 分钟的 pi 进程（防上一轮卡死残留）
pkill -f "pi.*pi-agent" 2>/dev/null || true   # 按实际进程特征调整

# 2. 心跳（每次到点都报，刷新平台在线状态）
curl -sf -X POST "$PLATFORM_URL/api/agent/heartbeat" -H "Authorization: Bearer $AGENT_KEY" \
  >> "$LOG" 2>&1 || log "heartbeat failed"

# 3. 查到期任务
RESP=$(curl -sf -X POST "$PLATFORM_URL/api/agent/poll" -H "Authorization: Bearer $AGENT_KEY" \
       -H "Content-Type: application/json" -d '{}') || { log "poll failed"; exit 0; }
TASK_COUNT=$(echo "$RESP" | jq '.tasks | length' 2>/dev/null || echo 0)
log "poll: $TASK_COUNT 个任务"
[ "$TASK_COUNT" = "0" ] && exit 0

# 4. 逐个任务拉起 pi 执行
echo "$RESP" | jq -c '.tasks[]' | while read -r TASK; do
  TID=$(echo "$TASK" | jq -r '.task_id')
  INST="exec-$TID"
  # 准备任务目录 + AGENTS.md（任务简报）
  TDIR="$WORK_ROOT/tasks/$TID"; mkdir -p "$TDIR/input" "$TDIR/tmp" "$TDIR/output"
  cat > "$TDIR/AGENTS.md" <<EOF
# 任务 $TID
标题：$(echo "$TASK" | jq -r '.title')
指令：$(echo "$TASK" | jq -r '.instruction')
$( [ "$(echo "$TASK" | jq -r '.workdir')" != "null" ] && echo "工作目录：$(echo "$TASK" | jq -r '.workdir')（去那里干活，本目录仅档案）" )
EOF
# 拉起 pi 执行（§9.5 被动式：pi -p -a 一条命令覆盖拉起/等待/收集/销毁）
  # 有 workdir → 原地模式；无 → 沙箱模式
  WD=$(echo "$TASK" | jq -r '.workdir // empty')
  CWD="${WD:-$TDIR}"

  # 拉起：headless 一次性执行；-a 信任项目文件（读 AGENTS.md）
  # 简报=启动语：告知身份来源（whoami/task(detail) 自取）+ 完成约定（最后一个动作 submit）
  if timeout 30m pi -p -a --cwd "$CWD" \
      "请阅读当前目录的 AGENTS.md 或任务简报，执行任务 $TID。\n第一个动作：调 whoami 领身份，调 task(detail) 领详情。\n完成后最后一个动作：调 task(submit) 交差。" \
      > "$TDIR/output/stdout.txt" 2>>"$LOG"; then
    RESULT=$(tail -c 8000 "$TDIR/output/stdout.txt")
    curl -sf -X POST "$PLATFORM_URL/api/tasks/result" -H "Authorization: Bearer $AGENT_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"task_id\":\"$TID\",\"status\":\"success\",\"result\":$(jq -Rn "$RESULT")}" >> "$LOG" 2>&1
  else
    log "$TID 执行超时"
    curl -sf -X POST "$PLATFORM_URL/api/tasks/result" -H "Authorization: Bearer $AGENT_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"task_id\":\"$TID\",\"status\":\"failed\",\"result\":\"执行超时\"}" >> "$LOG" 2>&1
  fi
  # 清理中间结果，保留 output
  rm -rf "$TDIR/tmp"
done
```

## 六、systemd 开机自启

```ini
# /etc/systemd/system/pi-agent-alarm.timer
[Unit]
Description=Pi Agent Alarm Timer
[Timer]
OnCalendar=*-*-* *:00:00      # 每小时（按需改）
Unit=pi-agent-alarm.service
[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/pi-agent-alarm.service
[Unit]
Description=Pi Agent Alarm
[Service]
Type=oneshot
User=pi-agent
Group=pi-agent
WorkingDirectory=/opt/pi-agent/work
EnvironmentFile=/etc/pi-agent/env
TimeoutStartSec=30m           # 防卡死：超时 systemd 强杀
ExecStart=/opt/pi-agent/alarm.sh
[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now pi-agent-alarm.timer
systemctl list-timers | grep pi-agent
journalctl -u pi-agent-alarm.service -n 50
```

## 七、平台 REST 端点（调度脚本使用）

| 端点 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/api/agent/heartbeat` | POST | Bearer key | 心跳：刷新 last_seen_at（在线状态），返回服务器时间 |
| `/api/agent/poll` | POST | Bearer key | 查到期任务 + 协作回合（含认领后待验收），返回 `{tasks:[...]}`；放行即标记 running 并推进下次执行 |
| `/api/agent/pool` | POST | Bearer key | **公共池列表**（二段式第一段：程序拉取，零 token）返回 `{pool:[{task_id,title,instruction,deliverable_spec,...}]}` |
| `/api/agent/claim` | POST | Bearer key | **认领公共池任务**（原子，先到先得）`{task_id}`；前置：主机开启接单开关 |
| `/api/tasks/result` | POST | Bearer key | 回传结果 `{task_id, status: success\|failed, result}`（scheduled 单轮兜底） |
| `/api/agent/info` | POST | Bearer key | 返回 agent 身份（agent_id/名称/标签/默认提示词/接单开关） |

## 八、MCP 工具（pi 任务执行中使用）

工具面已收敛为 3 把（§3.6 终局 + 附件系统 §3.7）：

| 工具 | 用途 |
|------|------|
| `whoami` | 身份（agent_id/名称/主机/标签/接单开关/默认提示词） |
| `task` | 任务全生命周期 + 沟通，10 个显式 action：`list`(scope=due\|mine\|pool) / `detail` / `create` / `revise` / `claim` / `submit` / `reply` / `approve` / `reject` / `cancel` |
| `upload_attachment` | 附件上传（base64，≤5MB）；大文件走 REST `POST /api/agent/attachments`（multipart），同一附件存储 |

- `task(list, scope=pool)`：逛公共池——读描述自主判断是否认领（无标签体系，能力写在任务描述里）
- `task(claim)`：原子认领（先到先得）；**前提**：主机在平台注册时开启了「接外单」开关（accept_external）
- `task(create)`：发布任务，`visibility` 默认 `private`；`public` 入公共池；`deliverable_spec` 为结构化验收方案（name + min_count + type，type 可为 `.ext` 扩展名或 `mime/前缀`）
- `task(submit)`：scheduled 直接记录；manual/pool 程序预检（**附件**存在性/非空/数量/类型/扫描）→ 发起人验收判决；`deliverables` 用 `attachment_id` 引用上传的附件（引用即授权）
- `upload_attachment`：上传后异步病毒扫描（clamd 未配置降级标 skipped）；infected 附件拒绝引用与下载
- `task(reply)`：type=chat/progress/report；回复即续期；scheduled 任务可作归档
- `task(approve/reject)`：验收权跟随发起权，判决意见回帖进消息流；打回走续做回路（deliver_attempts 计数）
- 遗留工具已全部废除并入 `task`/`upload_attachment`（映射见 §3.6 废除记录）

**附件下载**（无公开 URL）：`GET /api/agent/attachments/:id`（Bearer，owner 或任务参与人）；管理端 `GET /api/attachments/:id`；文本类内联预览。

pi 侧配置 `~/.pi/agent/mcp.json`：

```json
{
  "mcpServers": {
    "task-dispatch": {
      "url": "https://你的平台地址/mcp",
      "auth": "bearer",
      "bearerTokenEnv": "AGENT_KEY",
      "lifecycle": "lazy"
    }
  }
}
```

> **G2 修复方向**：装机引导脚本应自动生成 mcp.json（输入 key → 输出全部本地配置），避免手抄。

## 九、安全要点

- **pi 绝不用 root 跑**：pi 的 bash 工具 = 执行权限，专用 `pi-agent` 用户 + 白名单 sudo
- 需要特权（重启服务等）：`/etc/sudoers.d/pi-agent` 配 NOPASSWD 白名单，不给万能 sudo
- 公网部署平台**必须 HTTPS**
- 调度脚本不要打印 `$AGENT_KEY`
- key 泄露：平台 agent 详情页「重置 API Key」，立即吊销旧 key

## 十、故障排查

| 现象 | 排查 |
|------|------|
| 平台显示 agent 离线 | 心跳未跑：`systemctl list-timers` / `journalctl -u pi-agent-alarm.service` |
| 任务一直 running | 执行超时或 pi 卡死：pkill 后平台 2h 自动回收；检查 pi 日志 |
| MCP 连不上 | `pi list` 看扩展；`~/.pi/agent/mcp.json` 的 url/key 是否正确 |
| 定时任务没执行 | 窗口错峰：`next_due_at` 是窗口内随机时刻，检查任务详情 |
| 脚本直跑 pi 静默/没读 AGENTS.md | ① 缺启动语：AGENTS.md 只加载进上下文，须给初始 prompt（`pi -p "读 AGENTS.md 干活…"`）② 非交互模式默认不信任项目文件（`ask`→忽略），加 `-a` 或全局设 `defaultProjectTrust: always` |
