#!/usr/bin/env bash
# 启动任务分发平台：显式指定端口（默认 3200），直接 exec node（不套 sh -c），
# 把真实 node pid 写入 logs/platform.pid。
# 用法: scripts/start-platform.sh [--build] [端口]
#   --build / -b   启动前先执行 npm run build
#   端口           监听端口，默认 3200；忽略环境变量 PORT（防污染）
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
nohup env PORT="$PORT_NUM" node dist/src/index.js >> logs/platform.log 2>&1 &
pid=$!
echo "$pid" > logs/platform.pid

for _ in $(seq 1 40); do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "平台进程 $pid 提前退出，详见 logs/platform.log" >&2
    exit 1
  fi
  if ss -tln "sport = :$PORT_NUM" | grep -q LISTEN; then
    echo "平台已启动: pid=$pid 端口=$PORT_NUM"
    exit 0
  fi
  sleep 0.5
done
echo "等待端口 $PORT_NUM 监听超时" >&2
exit 1
