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
# 环境变量（KuroBridge 插件读取，MVP 阶段二起插件 JAR 自含 Node 运行时，不再注入 node/bundle）：
#   KUROBRIDGE_STUB_PEER  stub 协议端脚本路径（测试件不进 JAR，缺省指向仓库内 stub）
#   KUROBRIDGE_NODE / KUROBRIDGE_BUNDLE  开发覆盖（设置后绕过 JAR 解压链，用环境指定的 node/bundle）
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
# 影子 JAR 名含版本号（paper/build.gradle.kts：kurobridge-${version}.jar）。版本单点在根
# package.json（ADR-034），此处不硬编码：glob 取最新产物，升版零改动（否则成为门禁外
# 的隐藏版本点，升版即静默降级为"无插件启动"）
PLUGIN_JAR=""
for candidate in "$REPO/platforms/je/paper/build/libs/"kurobridge-*.jar; do
    if [ -f "$candidate" ] && { [ -z "$PLUGIN_JAR" ] || [ "$candidate" -nt "$PLUGIN_JAR" ]; }; then
        PLUGIN_JAR="$candidate"
    fi
done
if [ -n "$PLUGIN_JAR" ]; then
    cp -f "$PLUGIN_JAR" "$SERVER/plugins/kurobridge.jar"
    echo "[sandbox] 已安装插件：$PLUGIN_JAR"
else
    echo "[sandbox] 警告：未找到 shadowJar（platforms/je/paper/build/libs/kurobridge-*.jar），本次启动不含 KuroBridge" >&2
fi

# stub 不进 JAR（测试件）：沙盒经仓库内路径注入；JAR 内自带 node.exe，无需 KUROBRIDGE_NODE
export KUROBRIDGE_STUB_PEER="${KUROBRIDGE_STUB_PEER:-$REPO/bridge/embedded/stub/peer.mjs}"

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
echo "[sandbox] KUROBRIDGE_STUB_PEER=$KUROBRIDGE_STUB_PEER"
