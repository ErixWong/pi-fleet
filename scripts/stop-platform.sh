#!/usr/bin/env bash
# 停止任务分发平台：按 logs/platform.pid 杀真实进程及其子进程；
# pid 文件缺失或进程已死时，按端口 ss -tlnp 兜底找占用进程并杀掉；最后校验端口释放。
# 用法: scripts/stop-platform.sh [端口]（默认 3200）
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT_NUM="${1:-3200}"
PID_FILE=logs/platform.pid

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
    kill_tree "$pid"
    killed+=("$pid")
  fi
  rm -f "$PID_FILE"
fi

# 兜底：端口仍被占用时直接找监听进程（兼容 pid 文件里是 wrapper pid 的历史残留）
for pid in $(port_pids); do
  # node 进程 comm 可能显示为 MainThread，按命令行参数识别平台进程
  if ! ps -o args= -p "$pid" 2>/dev/null | grep -q 'dist/src/index\.js'; then
    continue
  fi
  case " ${killed[*]:-} " in
    *" $pid "*) ;;
    *) kill_tree "$pid"; killed+=("$pid") ;;
  esac
done

# 等待进程退出与端口释放，必要时升级 SIGKILL
for _ in $(seq 1 20); do
  alive=0
  for pid in "${killed[@]:-}"; do
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && alive=1
  done
  [[ "$alive" == 0 ]] && ! ss -tln "sport = :$PORT_NUM" | grep -q LISTEN && break
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

if ss -tln "sport = :$PORT_NUM" | grep -q LISTEN; then
  echo "端口 $PORT_NUM 仍被占用:" >&2
  ss -tlnp "sport = :$PORT_NUM" >&2
  exit 1
fi
echo "平台已停止: 端口 $PORT_NUM 已释放（killed:${killed[*]:- 无}）"
