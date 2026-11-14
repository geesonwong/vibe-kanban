#!/bin/bash
# Vibe Kanban 本地启动脚本（自源码构建版本 0.1.45）
# 用法：
#   ./scripts/run-local.sh            前台启动（Ctrl+C 停止）
#   ./scripts/run-local.sh --bg       后台启动，日志写 runtime/server.log
#   ./scripts/run-local.sh --stop     停止后台实例
#
# 说明：默认把 HOME 指向 runtime/home，使数据目录落在项目内
#      （~/Library/Application Support/ai.bloop.vibe-kanban 会被重定向到 runtime/home/Library/...）
#      若你用自己的 Terminal 直接跑且希望用真实 HOME，设置 VK_REAL_HOME=1

set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$PROJECT_DIR/runtime"
BIN="$PROJECT_DIR/target/release/server"
LOG="$RUNTIME_DIR/server.log"
PIDFILE="$RUNTIME_DIR/server.pid"

PORT="${VK_PORT:-3000}"
HOST="${VK_HOST:-127.0.0.1}"

mkdir -p "$RUNTIME_DIR" "$RUNTIME_DIR/home" "$RUNTIME_DIR/logs"

if [ ! -x "$BIN" ]; then
  echo "❌ 未找到可执行文件：$BIN"
  echo "   请先构建：cargo build --locked --release --bin server"
  exit 1
fi

# 数据目录重定向
if [ "${VK_REAL_HOME:-0}" != "1" ]; then
  export HOME="$RUNTIME_DIR/home"
fi

export HOST PORT
export RUST_LOG="${RUST_LOG:-info}"
# 让子进程（agent）能看到常见 CLI 路径
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

case "${1:-}" in
  --stop)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      kill "$(cat "$PIDFILE")" && echo "✅ 已停止（pid $(cat "$PIDFILE")）"
      rm -f "$PIDFILE"
    else
      echo "未发现运行中的实例"
    fi
    exit 0
    ;;
  --bg)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "已在运行（pid $(cat "$PIDFILE")），如需重启先 --stop"
      exit 0
    fi
    nohup "$BIN" >> "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    sleep 3
    if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "✅ 已后台启动：http://$HOST:$PORT  （pid $(cat "$PIDFILE")）"
      echo "   日志：$LOG"
    else
      echo "❌ 启动失败，日志末尾："
      tail -20 "$LOG"
      exit 1
    fi
    ;;
  *)
    echo "▶ 启动 Vibe Kanban：http://$HOST:$PORT"
    echo "  数据目录：$([ "${VK_REAL_HOME:-0}" = "1" ] && echo "真实 HOME" || echo "$RUNTIME_DIR/home")"
    exec "$BIN"
    ;;
esac