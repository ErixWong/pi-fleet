#!/usr/bin/env bash
# 启动任务分发平台：显式指定端口（默认 3200），直接 exec node（不套 sh -c），
# 把真实 node pid 写入 logs/platform.pid。
# 安全性（#63 验收修复）：
#   - 对 pid 文件加 flock 串行化启停，避免并发竞态。
#   - 启动前端口已被监听则报错退出（提示已有实例，不覆盖 pid 文件）。
#   - 启动成功后校验“正在监听端口的进程 pid == pid 文件里的 pid”，
#     不匹配视为异常，清理已启动进程并删 pid 文件后报错退出。
#   - 等待端口超时同样清理已启动进程并删 pid 文件。
# 用法: scripts/start-platform.sh [--build] [端口]
#   --build / -b   启动前先执行 npm run build
#   端口           监听端口，范围 1-65535，默认 3200；忽略环境变量 PORT（防污染）
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

BUILD=0
PORT_NUM=""
for arg in "$@"; do
  case "$arg" in
    -b|--build)
      BUILD=1
      ;;
    ''|*[!0-9]*)
      echo "未知参数: $arg（用法: start-platform.sh [--build] [端口]）" >&2
      exit 2
      ;;
    *)
      PORT_NUM="$arg"
      ;;
  esac
done
PORT_NUM="${PORT_NUM:-3200}"
# 先限格式（1-5 位数字且无前导零），再强制十进制比较：前导零输入（03200/09/010）
# 要么被 bash 按八进制解析（03200 变成 1664 静默错绑端口），要么直接报 base 错误，
# 超长数字同样触发算术异常，因此一律拒绝
if [[ ! "$PORT_NUM" =~ ^[1-9][0-9]{0,4}$ ]] || (( 10#$PORT_NUM < 1 || 10#$PORT_NUM > 65535 )); then
  echo "端口必须是 1-65535 的整数: $PORT_NUM" >&2
  exit 2
fi

# 仓库约定 node24 工具链优先；目录不存在时无害回退到系统 PATH
export PATH="$HOME/.local/node24/bin:$PATH"

# .env 由应用 dotenv 自加载；但 DB_NAME_NEW 只能来自环境，缺省按新库约定兜底
: "${DB_NAME_NEW:=erix}"
export DB_NAME_NEW

if [[ "$BUILD" == 1 ]]; then
  npm run build
fi

if [[ ! -f dist/src/index.js ]]; then
  echo "缺少 dist/src/index.js，请先 npm run build 或使用 --build" >&2
  exit 1
fi

mkdir -p logs

# flock 串行化启停：拿到锁之前不做任何状态变更
exec 9>logs/platform.pid.lock
flock 9

PID_FILE=logs/platform.pid

# 启动前检查：端口已被监听则报错退出，不覆盖 pid 文件
if command -v ss >/dev/null 2>&1 && ss -tln "sport = :$PORT_NUM" | grep -q LISTEN; then
  echo "端口 $PORT_NUM 已被其他进程监听，疑似已有实例在运行:" >&2
  ss -tlnp "sport = :$PORT_NUM" >&2
  echo "请先运行 scripts/stop-platform.sh $PORT_NUM 停止后再启动" >&2
  exit 1
fi

cleanup_failed_start() {
  echo "清理: 终止已启动进程 $1 并删除 $PID_FILE" >&2
  kill "$1" 2>/dev/null || true
  sleep 1
  kill -0 "$1" 2>/dev/null && kill -9 "$1" 2>/dev/null || true
  rm -f "$PID_FILE"
}

# 注意：必须关闭 fd 9（9>&-），否则 node 子进程继承锁 fd，锁会一直被平台进程持有，后续启停死锁
nohup env PORT="$PORT_NUM" node dist/src/index.js 9>&- >> logs/platform.log 2>&1 &
pid=$!
echo "$pid" > "$PID_FILE"

for _ in $(seq 1 40); do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "平台进程 $pid 提前退出，详见 logs/platform.log" >&2
    rm -f "$PID_FILE"
    exit 1
  fi
  if ss -tln "sport = :$PORT_NUM" | grep -q LISTEN; then
    # 校验监听者身份：正在监听端口的进程必须是刚启动的 node 进程
    listener_pid=$(ss -tlnp "sport = :$PORT_NUM" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)
    if [[ -z "$listener_pid" || "$listener_pid" != "$pid" ]]; then
      echo "异常: 监听端口 $PORT_NUM 的进程是 '${listener_pid:-未知}'，与启动的 pid $pid 不一致" >&2
      cleanup_failed_start "$pid"
      exit 1
    fi
    echo "平台已启动: pid=$pid 端口=$PORT_NUM"
    exit 0
  fi
  sleep 0.5
done
echo "等待端口 $PORT_NUM 监听超时" >&2
cleanup_failed_start "$pid"
exit 1
