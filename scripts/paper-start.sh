# 启动 sandbox Paper 服务端（原型阶段 4，Git Bash 运行）
#
# stdin 注入形态：java 的 stdin 由 `tail -f cmd.in` 提供，之后向 cmd.in 追加行即转发给
# 控制台（stop-server.sh 用此优雅关服）。
#
# 关键坑（实测）：
#   1. cmd.in 残留上轮的 "stop" 会被新 tail -f 回放 → 服务器启动即被停。
#      → 启动前必须清空 cmd.in。
#   2. 遗留的 tail.exe 会与新 tail 抢读 cmd.in（行被旧进程吃掉）。
#      → 启动前清杀全部 tail.exe。
#   3. MSYS pid 跨 bash 会话不可靠 → pid 文件记录 Windows pid（/proc/$!/winpid）。
#
# 环境变量（KuroBot 插件读取）：
#   KUROBOT_NODE   node 绝对路径（缺省 mise 的 node——Java ProcessBuilder 解析 "node"
#                  拿到的是系统 PATH 的 v24，必须显式给绝对路径）
#   KUROBOT_BUNDLE embedded 引导层产物绝对路径
#
# 用法：bash scripts/paper-start.sh

set -euo pipefail

SANDBOX="$(cd "$(dirname "${BASH_SOURCE[0]}")/../sandbox" && pwd)"
SERVER="$SANDBOX/server"
REPO="$(cd "$SANDBOX/.." && pwd)"

JAR="$SERVER/paper.jar"
if [ ! -f "$JAR" ]; then
    echo "[sandbox] 缺少 $JAR（先完成 Paper 下载）" >&2
    exit 1
fi

# 坑 2：清杀遗留 tail（都是本沙盒的 stdin 供给进程）
taskkill //F //IM tail.exe >/dev/null 2>&1 || true

mkdir -p "$SERVER/plugins"
PLUGIN_JAR="$REPO/platforms/je/paper/build/libs/kurobot-0.1.0.jar"
if [ -f "$PLUGIN_JAR" ]; then
    cp -f "$PLUGIN_JAR" "$SERVER/plugins/kurobot.jar"
    echo "[sandbox] 已安装插件：$PLUGIN_JAR"
else
    echo "[sandbox] 警告：未找到 shadowJar（$PLUGIN_JAR），本次启动不含 KuroBot" >&2
fi

export KUROBOT_BUNDLE="${KUROBOT_BUNDLE:-$REPO/bridge/embedded/dist/index.mjs}"
export KUROBOT_NODE="${KUROBOT_NODE:-$(mise which node)}"

# 坑 1：清空旧输入（防止回放上轮 stop）
: > "$SERVER/cmd.in"
touch "$SERVER/console.log"

# 经 mise exec 拿 Java 25（PATH 直连是 21）
cd "$SERVER"
mise exec -- bash -c '
  tail -f cmd.in | java -Xmx2G -Dfile.encoding=UTF-8 -jar paper.jar nogui > console.log 2>&1 &
  MSYS_PID=$!
  # Windows pid 供跨会话的 stop-server.sh 使用
  cat "/proc/$MSYS_PID/winpid" > paper.pid 2>/dev/null || echo "$MSYS_PID" > paper.pid
'

echo "[sandbox] Paper 已后台启动（winpid=$(cat "$SERVER/paper.pid")），日志：$SERVER/console.log"
echo "[sandbox] KUROBOT_NODE=$KUROBOT_NODE"
echo "[sandbox] KUROBOT_BUNDLE=$KUROBOT_BUNDLE"
