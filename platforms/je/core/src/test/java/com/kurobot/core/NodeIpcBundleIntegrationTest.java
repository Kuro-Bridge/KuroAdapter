package com.kurobot.core;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

/**
 * TS↔Java 真管道集成测试（原型阶段 3 建立，MVP 阶段一起随业务升级）：用真实 node 子进程 +
 * 真实 embedded bundle（含 stub 孙进程）验证 IPC 环，不需要 Paper。
 *
 * <p>链路：Java(NodeIpc) → stdin JSON-lines → node(bootstrap + core + 绑定表) →
 * stub 孙进程 → WS 握手 → 平台消息（绑定频道）回 Java(onBroadcast) → Java 回执 result →
 * Java 发 game_chat → 按绑定频道 fan-out → stub stderr 打印「收到游戏聊天」→
 * 经 onStderrLine 中继回 Java 断言。
 *
 * <p>配置：MVP 阶段一起 Node 侧读 {@code plugins/kurobot/config.json}（相对子进程 cwd）
 * 做绑定过滤——本测试把子进程 cwd 指到 {@link TempDir} 并预置绑定 stub 频道（"stub-channel"），
 * 空绑定会把 stub 消息丢弃导致用例失败。
 *
 * <p>前置：`mise exec -- pnpm -r build` 已产出 bundle（未构建时本测试自动跳过，不失败）；
 * node 需在 PATH（经 mise exec 运行 Gradle 即满足）。
 */
class NodeIpcBundleIntegrationTest {

    /** Gradle 测试工作目录因版本/调用方式而异（:core 或 platforms/je），多基准探测。 */
    private static final Path BUNDLE = resolveRepoRelative("bridge/embedded/dist/index.mjs");

    private static final Path STUB = resolveRepoRelative("bridge/embedded/stub/peer.mjs");

    /** stub 协议端的固定频道（peer.mjs 的 STUB_CHANNEL）。 */
    private static final String STUB_CHANNEL = "stub-channel";

    private static Path resolveRepoRelative(String relative) {
        for (String base : new String[] {".", "..", "../..", "../../.."}) {
            Path candidate = Path.of(base).resolve(relative).normalize().toAbsolutePath();
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
        }
        return Path.of(relative);
    }

    private final LinkedBlockingQueue<String> stderrLines = new LinkedBlockingQueue<>();
    private final List<String> log = new CopyOnWriteArrayList<>();

    @Test
    @Timeout(60)
    void realBundleRoundTrip(@TempDir Path serverRoot) throws Exception {
        Assumptions.assumeTrue(
                Files.isRegularFile(BUNDLE),
                "embedded bundle 未构建，跳过（先 pnpm -r build）；wd=" + Path.of("").toAbsolutePath() + " bundle=" + BUNDLE);
        Assumptions.assumeTrue(Files.isRegularFile(STUB), "stub 脚本缺失");
        writeBoundConfig(serverRoot);

        RecordingHandler handler = new RecordingHandler();
        NodeIpc ipc = new NodeIpc("node", BUNDLE.toRealPath(), STUB.toRealPath(), handler, log::add);
        ipc.setWorkingDirectory(serverRoot);
        try {
            // 1) ready：WS 动态端口
            int wsPort = ipc.start().get(15, TimeUnit.SECONDS);
            assertTrue(wsPort > 0, "ready 应携带正端口，实际 " + wsPort);

            // 2) stub 握手后会主动发一条平台消息 → onBroadcast
            NodeIpcListenerBroadcastCall call = handler.broadcastCalls.poll(15, TimeUnit.SECONDS);
            assertTrue(call != null, "应收到 stub 的 broadcast 请求");
            assertTrue(call.message().contains("stub 协议端"), "消息内容异常：" + call.message);
            call.result().ok();

            // 3) 游戏 → 平台：Java 发 game_chat，stub 的 stderr 应打印游戏聊天
            //（断言用 channel 无关子串——v0.2 起 stub 日志携带 [channel] 前缀，频道值随阶段演进）
            ipc.sendGameChat("IntegrationTest", "来自 Java 的问候");
            assertTrue(
                    awaitStderrLineContaining("<IntegrationTest> 来自 Java 的问候", Duration.ofSeconds(15)),
                    "stub 应通过 stderr 中继收到游戏聊天，实际收到：" + stderrLines);

            // 4) 在途请求结算验证（平台消息的 result ok 不应悬挂）
            assertTrue(call.resultAnswered(), "result 应恰好回执一次");
        } finally {
            ipc.shutdown("integration test done");
        }
    }

    /** 在临时服务器根目录预置绑定 stub 频道的配置（Node 侧 ConfigStore 读取）。 */
    private static void writeBoundConfig(Path serverRoot) throws IOException {
        Path configDir = serverRoot.resolve("plugins").resolve("kurobot");
        Files.createDirectories(configDir);
        Files.writeString(
                configDir.resolve("config.json"),
                "{\"channels\":[\"" + STUB_CHANNEL + "\"]}\n");
    }

    /** 轮询 stderr 队列直到出现包含目标文本的行（超时返回 false）。 */
    private boolean awaitStderrLineContaining(String expected, Duration timeout) throws InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            String line = stderrLines.poll(500, TimeUnit.MILLISECONDS);
            if (line != null && line.contains(expected)) {
                return true;
            }
        }
        return false;
    }

    private final class RecordingHandler implements NodeIpcListener {
        final LinkedBlockingQueue<NodeIpcListenerBroadcastCall> broadcastCalls = new LinkedBlockingQueue<>();

        @Override
        public void onReady(int wsPort) {
            // 主断言走 start() future；此处无需处理
        }

        @Override
        public void onBroadcast(String message, IpcResult result) {
            broadcastCalls.add(new NodeIpcListenerBroadcastCall(message, result));
        }

        @Override
        public void onExecuteCommand(String command, IpcResult result) {
            result.error("集成测试不执行命令：" + command);
        }

        @Override
        public void onStderrLine(String line) {
            stderrLines.add(line);
        }
    }

    /** onBroadcast 的一次调用（消息 + 回执），resultAnswered 供回执后验证。 */
    private static final class NodeIpcListenerBroadcastCall {
        private final String message;
        private final IpcResult result;
        private final CompletableFuture<Void> answered = new CompletableFuture<>();

        NodeIpcListenerBroadcastCall(String message, IpcResult result) {
            this.message = message;
            this.result = new IpcResult() {
                @Override
                public void ok() {
                    result.ok();
                    answered.complete(null);
                }

                @Override
                public void error(String error) {
                    result.error(error);
                    answered.complete(null);
                }
            };
        }

        String message() {
            return message;
        }

        IpcResult result() {
            return result;
        }

        boolean resultAnswered() {
            try {
                answered.get(1, TimeUnit.SECONDS);
                return true;
            } catch (Exception e) {
                return false;
            }
        }
    }
}
