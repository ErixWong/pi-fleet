#!/usr/bin/env bash
# pi-agent 交互式安装脚本
# 支持 Linux、macOS 和 WSL；Linux/启用 systemd 的 WSL 会自动注册服务。

set -euo pipefail
IFS=$'\n\t'

if [[ -t 1 ]]; then
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_BLUE=$'\033[36m'
  C_BOLD=$'\033[1m'
  C_RESET=$'\033[0m'
else
  C_GREEN='' C_YELLOW='' C_RED='' C_BLUE='' C_BOLD='' C_RESET=''
fi

info() {
  printf '%s[信息]%s %s\n' "$C_BLUE" "$C_RESET" "$*"
}

success() {
  printf '%s[完成]%s %s\n' "$C_GREEN" "$C_RESET" "$*"
}

warn() {
  printf '%s[提示]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2
}

die() {
  printf '%s[错误]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2
  exit 1
}

usage() {
  printf '用法：%s [--url <平台地址>] [--key <agent key>] [--name <主机名>]\n' "$0"
}

PLATFORM_URL=''
AGENT_KEY=''
AGENT_NAME=''

while (($# > 0)); do
  case "$1" in
    --url)
      (($# >= 2)) || die "--url 缺少参数"
      PLATFORM_URL=$2
      shift 2
      ;;
    --key)
      (($# >= 2)) || die "--key 缺少参数"
      AGENT_KEY=$2
      shift 2
      ;;
    --name)
      (($# >= 2)) || die "--name 缺少参数"
      AGENT_NAME=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "未知参数：$1"
      ;;
  esac
done

command -v pi >/dev/null 2>&1 || {
  warn "未检测到 pi CLI。pi 官方一键安装："
  case "$(uname -s)" in
    Linux|Darwin) echo "    curl -fsSL https://pi.dev/install.sh | sh" ;;
    *)            echo "    powershell -c \"irm https://pi.dev/install.ps1 | iex\"" ;;
  esac
  read -r -p "是否现在用官方脚本安装 pi？[y/N] " ans
  if [[ "$ans" =~ ^[Yy] ]]; then
    case "$(uname -s)" in
      Linux|Darwin)
        curl -fsSL https://pi.dev/install.sh | sh || die "官方安装脚本执行失败，请手动安装后重跑"
        ;;
      *)
        die "Windows 请先手动在 PowerShell 执行：powershell -c \"irm https://pi.dev/install.ps1 | iex\"，然后在 WSL 重跑本脚本"
        ;;
    esac
    # 官方脚本可能装到 ~/.local/bin 等非 PATH 目录，补上探测
    if ! command -v pi >/dev/null 2>&1; then
      for p in "$HOME/.local/bin/pi" "$HOME/bin/pi" "$HOME/.npm-global/bin/pi" /usr/local/bin/pi; do
        if [[ -x "$p" ]]; then
          export PATH="$(dirname "$p"):$PATH"
          break
        fi
      done
    fi
    command -v pi >/dev/null 2>&1 || die "pi 安装后仍不可用（PATH 不含 pi），请手动安装后重跑"
  else
    warn "请先安装 pi（官方命令见上），再重新运行本脚本"
    exit 1
  fi
}
NODE_BIN=$(command -v node) || die "未检测到 node，无法运行 agent-daemon.mjs"

if [[ -z "$PLATFORM_URL" ]]; then
  read -r -p "平台地址 [http://127.0.0.1:3000]：" PLATFORM_URL || die "读取平台地址失败"
  PLATFORM_URL=${PLATFORM_URL:-http://127.0.0.1:3000}
fi

if [[ -z "$AGENT_KEY" ]]; then
  if ! IFS= read -r -s -p "Agent key（必填，不回显）：" AGENT_KEY; then
    printf '\n'
    die "读取 agent key 失败"
  fi
  printf '\n'
fi

if [[ -z "$AGENT_NAME" ]]; then
  DEFAULT_NAME=$(hostname 2>/dev/null || uname -n)
  read -r -p "主机名 [$DEFAULT_NAME]：" AGENT_NAME || die "读取主机名失败"
  AGENT_NAME=${AGENT_NAME:-$DEFAULT_NAME}
fi

[[ -n "$PLATFORM_URL" ]] || die "平台地址不能为空"
[[ -n "$AGENT_KEY" ]] || die "agent key 不能为空"
[[ -n "$AGENT_NAME" ]] || die "主机名不能为空"

case "$PLATFORM_URL" in
  http://*|https://*) ;;
  *) die "平台地址必须以 http:// 或 https:// 开头" ;;
esac

case "$PLATFORM_URL$AGENT_KEY$AGENT_NAME" in
  *$'\n'*|*$'\r'*) die "平台地址、agent key 和主机名不能包含换行符" ;;
esac

while [[ "$PLATFORM_URL" == */ ]]; do
  PLATFORM_URL=${PLATFORM_URL%/}
done
MCP_URL="${PLATFORM_URL}/mcp"

CURRENT_USER=$(id -un)
CURRENT_UID=$(id -u)
HAS_PRIVILEGE=0
PRIVILEGE_CMD=()

if (( CURRENT_UID == 0 )); then
  HAS_PRIVILEGE=1
elif command -v sudo >/dev/null 2>&1; then
  HAS_PRIVILEGE=1
  PRIVILEGE_CMD=(sudo)
fi

run_privileged() {
  if (( HAS_PRIVILEGE )); then
    "${PRIVILEGE_CMD[@]}" "$@"
  else
    "$@"
  fi
}

if (( CURRENT_UID == 0 )); then
  TARGET_USER='pi-agent'
  if ! id "$TARGET_USER" >/dev/null 2>&1; then
    command -v useradd >/dev/null 2>&1 || die "root 模式需要 useradd 创建 pi-agent 用户"
    info "创建低权限用户 pi-agent"
    useradd -r -m -s /bin/bash "$TARGET_USER"
  else
    info "低权限用户 pi-agent 已存在，跳过创建"
  fi
  TARGET_HOME=$(getent passwd "$TARGET_USER" 2>/dev/null | awk -F: 'NR == 1 { print $6 }')
  [[ -n "$TARGET_HOME" ]] || die "无法取得 pi-agent 的 home 目录"
else
  TARGET_USER=$CURRENT_USER
  TARGET_HOME=${HOME:?当前用户的 HOME 未设置}
fi

if (( HAS_PRIVILEGE )); then
  INSTALL_DIR='/opt/pi-agent'
else
  INSTALL_DIR="$TARGET_HOME/.local/share/pi-agent"
fi
DAEMON_PATH="$INSTALL_DIR/agent-daemon.mjs"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DAEMON_SOURCE="$SCRIPT_DIR/agent-daemon.mjs"
[[ -f "$DAEMON_SOURCE" ]] || die "找不到守护进程：$DAEMON_SOURCE"

info "安装 agent-daemon.mjs 到 $DAEMON_PATH"
run_privileged mkdir -p "$INSTALL_DIR"
run_privileged install -m 755 "$DAEMON_SOURCE" "$DAEMON_PATH"

# 通过环境变量传值，避免把 agent key 拼进 su 的命令行或日志。
NODE_WRITE_CODE='
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const input = process.env.MCP_URL && process.env.MCP_KEY
  ? []
  : fs.readFileSync(0, "utf8").split("\0");
const url = process.env.MCP_URL || input[0];
const key = process.env.MCP_KEY || input[1];
if (!url || !key) throw new Error("缺少 mcp 配置参数");

const dir = path.join(os.homedir(), ".pi", "agent");
const target = path.join(dir, "mcp.json");
const backup = path.join(dir, "mcp.json.bak-agent");
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

let config = {};
if (fs.existsSync(target)) {
  fs.copyFileSync(target, backup);
  fs.chmodSync(backup, 0o600);
  try {
    config = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    throw new Error(`已有 mcp.json 不是有效 JSON，原文件已备份到 ${backup}：${error.message}`);
  }
}
if (!config || typeof config !== "object" || Array.isArray(config)) {
  throw new Error("已有 mcp.json 顶层结构不是 JSON 对象");
}
if (!config.mcpServers) config.mcpServers = {};
if (typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
  throw new Error("已有 mcp.json 的 mcpServers 不是对象");
}

config.mcpServers["task-dispatch"] = {
  ...(config.mcpServers["task-dispatch"] &&
    typeof config.mcpServers["task-dispatch"] === "object" &&
    !Array.isArray(config.mcpServers["task-dispatch"])
    ? config.mcpServers["task-dispatch"]
    : {}),
  url: `${url}/mcp`,
  auth: "bearer",
  bearerToken: key,
  lifecycle: "lazy",
};

const temp = `${target}.tmp-${process.pid}`;
fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(temp, 0o600);
fs.renameSync(temp, target);
fs.chmodSync(target, 0o600);
console.log(`已写入 ${target}`);
'

shell_quote() {
  local value=$1
  value=${value//\'/\'\\\'\'}
  printf "'%s'" "$value"
}

write_mcp_config() {
  if [[ "$TARGET_USER" == "$CURRENT_USER" ]]; then
    MCP_URL="$PLATFORM_URL" MCP_KEY="$AGENT_KEY" HOME="$TARGET_HOME" \
      NODE_WRITE_CODE="$NODE_WRITE_CODE" "$NODE_BIN" -e "$NODE_WRITE_CODE"
  else
    printf '%s\0%s' "$PLATFORM_URL" "$AGENT_KEY" |
      su - "$TARGET_USER" -c "$NODE_BIN -e $(shell_quote "$NODE_WRITE_CODE")"
  fi
}

info "合并 $TARGET_HOME/.pi/agent/mcp.json（仅更新 task-dispatch）"
write_mcp_config

MODELS_PATH="$TARGET_HOME/.pi/agent/models.json"
if [[ ! -f "$MODELS_PATH" ]]; then
  printf '%s%sLLM provider 未配置：请自行配置 pi 的 models.json（装 pi-agent 本来就要做的），否则 agent 无法干活%s\n' \
    "$C_BOLD" "$C_RED" "$C_RESET" >&2
else
  success "检测到 LLM provider 配置：$MODELS_PATH"
fi

# systemd 对引号、反斜杠、百分号和环境变量字符有自己的解析规则。
systemd_quote() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//\$/\\\$}
  value=${value//\`/\\\`}
  value=${value//%/%%}
  printf '"%s"' "$value"
}

UNIT_TMP=''
cleanup() {
  [[ -z "$UNIT_TMP" ]] || rm -f -- "$UNIT_TMP"
}
trap cleanup EXIT

SYSTEMD_UNIT='/etc/systemd/system/pi-agent.service'
if command -v systemctl >/dev/null 2>&1 && (( HAS_PRIVILEGE )); then
  UNIT_TMP=$(mktemp "${TMPDIR:-/tmp}/pi-agent.service.XXXXXX")
  {
    printf '[Unit]\n'
    printf 'Description=pi agent task-dispatch daemon\n'
    printf 'After=network-online.target\nWants=network-online.target\n\n'
    printf '[Service]\n'
    printf 'Type=simple\n'
    printf 'User=%s\n' "$TARGET_USER"
    printf 'WorkingDirectory=%s\n' "$(systemd_quote "$TARGET_HOME")"
    printf 'Environment=PLATFORM_URL=%s\n' "$(systemd_quote "$PLATFORM_URL")"
    printf 'Environment=PI_AGENT_KEY=%s\n' "$(systemd_quote "$AGENT_KEY")"
    printf 'Environment=AGENT_NAME=%s\n' "$(systemd_quote "$AGENT_NAME")"
    printf 'ExecStart=/usr/bin/env node %s\n' "$(systemd_quote "$DAEMON_PATH")"
    printf 'Restart=always\nRestartSec=5\n\n'
    printf '[Install]\nWantedBy=multi-user.target\n'
  } >"$UNIT_TMP"
  run_privileged mkdir -p "$(dirname "$SYSTEMD_UNIT")"
  run_privileged install -m 600 "$UNIT_TMP" "$SYSTEMD_UNIT" ||
    die "写入 $SYSTEMD_UNIT 失败，请确认有 sudo/root 权限"
  success "已写入 systemd unit：$SYSTEMD_UNIT"

  if [[ -d /run/systemd/system ]]; then
    info "重新加载并启动 pi-agent 服务（需要 sudo 时会提示）"
    run_privileged systemctl daemon-reload
    run_privileged systemctl enable --now pi-agent.service
    sleep 3
    if run_privileged systemctl is-active --quiet pi-agent.service; then
      success "pi-agent 服务状态：active"
      run_privileged journalctl -u pi-agent.service -n 10 --no-pager || true
    else
      printf '%s%spi-agent 启动失败，最近日志如下：%s\n' "$C_BOLD" "$C_RED" "$C_RESET" >&2
      run_privileged journalctl -u pi-agent.service -n 10 --no-pager || true
      warn "请根据日志排查 pi CLI、models.json、平台地址和 agent key"
      exit 1
    fi
  else
    warn "检测到 systemctl，但 systemd 当前未运行；unit 已写入，启用 systemd 后执行：systemctl daemon-reload && systemctl enable --now pi-agent"
  fi
elif command -v systemctl >/dev/null 2>&1; then
  warn "检测到 systemd，但当前用户没有 sudo/root；未写入 $SYSTEMD_UNIT，请使用 sudo 重新运行以启用常驻服务"
else
  warn "未检测到 systemd。配置和守护进程已安装；macOS/未启用 systemd 的 WSL 请自行使用 node 启动 $DAEMON_PATH"
fi

KEY_PREVIEW=${AGENT_KEY:0:8}
printf '\n%s%s安装结果摘要%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
printf '平台地址：%s\n' "$PLATFORM_URL"
printf 'Agent key：%s…\n' "$KEY_PREVIEW"
printf '目标用户：%s (%s)\n' "$TARGET_USER" "$TARGET_HOME"
printf '日志查看：journalctl -u pi-agent -f\n'
