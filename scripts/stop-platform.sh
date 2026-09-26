#!/usr/bin/env bash
# 停止任务分发平台：按 logs/platform.pid 杀真实进程及其子进程。
# 安全性（#63 验收修复）：
#   - 杀任何 pid 前先校验 /proc/<pid>/cmdline 含 dist/src/index.js 且 cwd 是本仓库，
#     防止 pid 复用误杀无关进程；pid 文件指向的进程身份不符时不杀，走端口兜底。
#   - 端口兜底同样校验 cmdline+cwd 后才杀。
#   - ss 不可用时退化为 kill 后检查进程存活，不误判“端口已释放”。
# 用法: scripts/stop-platform.sh [端口]（默认 3200）
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT_NUM="${1:-3200}"
PID_FILE=logs/platform.pid
REPO_ROOT="$(pwd)"

have_ss() { command -v ss >/dev/null 2>&1; }

# 进程身份校验：必须是本仓库的 node dist/src/index.js
is_platform_pid() {
  local pid=$1
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q 'dist/src/index\.js' || return 1
  [[ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" == "$REPO_ROOT" ]]
}

kill_tree() {
  local pid=$1
  local child
  for child in $(ps -o pid= --ppid "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

port_pids() {
  ss -tlnp "sport = :$PORT_NUM" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true
}

killed=()

if [[ -f "$PID_FILE" ]]; then
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if [[ -n "${pid// /}" ]] && kill -0 "$pid" 2>/dev/null; then
    if is_platform_pid "$pid"; then
      kill_tree "$pid"
      killed+=("$pid")
    else
      echo "警告: pid 文件指向的进程 $pid 不是本平台进程（cmdline/cwd 校验失败），不杀，改走端口兜底" >&2
    fi
  fi
  rm -f "$PID_FILE"
fi

# 兜底：端口仍被占用时找监听进程（同样校验身份后才杀）
if have_ss; then
  for pid in $(port_pids); do
    if ! is_platform_pid "$pid"; then
      continue
    fi
    case " ${killed[*]:-} " in
      *" $pid "*) ;;
      *) kill_tree "$pid"; killed+=("$pid") ;;
    esac
  done
fi

# 等待进程退出与端口释放，必要时升级 SIGKILL
for _ in $(seq 1 20); do
  alive=0
  for pid in "${killed[@]:-}"; do
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && alive=1
  done
  if [[ "$alive" == 0 ]]; then
    if have_ss; then
      ss -tln "sport = :$PORT_NUM" | grep -q LISTEN || break
    else
      break
    fi
  fi
  sleep 0.5
done

remaining=""
for pid in "${killed[@]:-}"; do
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && remaining="$remaining $pid"
done
if [[ -n "$remaining" ]]; then
  for pid in $remaining; do kill -9 "$pid" 2>/dev/null || true; done
  sleep 1
fi

# 最终校验：ss 可用时以端口为准；ss 不可用时退化为检查被杀进程是否存活
if have_ss; then
  if ss -tln "sport = :$PORT_NUM" | grep -q LISTEN; then
    echo "端口 $PORT_NUM 仍被占用:" >&2
    ss -tlnp "sport = :$PORT_NUM" >&2
    exit 1
  fi
else
  for pid in "${killed[@]:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "进程 $pid 在 SIGKILL 后仍存活（ss 不可用，无法按端口复核）" >&2
      exit 1
    fi
  done
fi
echo "平台已停止: 端口 $PORT_NUM 已释放（killed:${killed[*]:- 无}）"
