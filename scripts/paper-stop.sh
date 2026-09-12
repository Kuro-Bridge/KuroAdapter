# 停止 sandbox Paper 服务端（向 cmd.in 追加 stop，等待进程退出；超时强杀）
# 用法：bash scripts/paper-stop.sh

set -euo pipefail

SERVER="$(cd "$(dirname "${BASH_SOURCE[0]}")/../sandbox/server" && pwd)"
PID_FILE="$SERVER/paper.pid"
LOG="$SERVER/console.log"

# pid 文件记录的是 Windows pid（start-server.sh 经 /proc/<pid>/winpid 取得）
alive() {
    [ -f "$PID_FILE" ] && tasklist //FI "PID eq $(cat "$PID_FILE")" 2>/dev/null | grep -qi "java.exe"
}

if ! alive; then
    echo "[sandbox] Paper 未在运行（无匹配 pid）"
    # 仍清一下残留的 stdin 供给进程
    taskkill //F //IM tail.exe >/dev/null 2>&1 || true
    exit 0
fi

PID="$(cat "$PID_FILE")"
echo "stop" >> "$SERVER/cmd.in"

for _ in $(seq 1 120); do
    if ! alive; then
        echo "[sandbox] Paper 已优雅退出（winpid=$PID）"
        taskkill //F //IM tail.exe >/dev/null 2>&1 || true
        exit 0
    fi
    sleep 1
done

echo "[sandbox] 120s 未退出，强杀 winpid=$PID" >&2
taskkill //F //PID "$PID" >/dev/null 2>&1 || true
taskkill //F //IM tail.exe >/dev/null 2>&1 || true
tail -5 "$LOG" 2>/dev/null || true
exit 1
