package com.kurobot.core;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.junit.jupiter.api.Test;

/** NodeIpc 行为测试：假进程 + 帧管道模拟 Node，覆盖启动 / 请求 / 容错 / 关机全路径。 */
class NodeIpcTest {

    private static final Duration WAIT = Duration.ofSeconds(5);
    private static final int READY_PORT = 49152;

    private final ObjectMapper mapper = new ObjectMapper();
    private final List<String> logs = new CopyOnWriteArrayList<>();
    private final RecordingListener listener = new RecordingListener();

    // ---- 测试假件与辅助 ----

    private static final class RecordingListener implements NodeIpcListener {
        final CompletableFuture<Integer> ready = new CompletableFuture<>();
        final LinkedBlockingQueue<String> stderrLines = new LinkedBlockingQueue<>();
        final LinkedBlockingQueue<BroadcastCall> broadcastCalls = new LinkedBlockingQueue<>();
        final LinkedBlockingQueue<CommandCall> executeCalls = new LinkedBlockingQueue<>();

        @Override
        public void onReady(int wsPort) {
            ready.complete(wsPort);
        }

        @Override
        public void onBroadcast(String message, IpcResult result) {
            broadcastCalls.add(new BroadcastCall(message, result));
        }

        @Override
        public void onExecuteCommand(String command, IpcResult result) {
            executeCalls.add(new CommandCall(command, result));
        }

        @Override
        public void onStderrLine(String line) {
            stderrLines.add(line);
        }

        record BroadcastCall(String message, IpcResult result) {}

        record CommandCall(String command, IpcResult result) {}
    }

    private NodeIpc newIpc(FakeProcess process, Path stubPath) {
        NodeIpc ipc = new NodeIpc(
                "node", Path.of("bundle.mjs"), stubPath, listener, logs::add, (command, extraEnv, workingDirectory) -> {
                    process.command = List.copyOf(command);
                    process.extraEnv = Map.copyOf(extraEnv);
                    process.workingDirectory = workingDirectory;
                    return process;
                });
        ipc.setRequestTimeout(Duration.ofSeconds(5));
        ipc.setShutdownGrace(Duration.ofSeconds(2));
        ipc.setShutdownForceWait(Duration.ofMillis(300));
        return ipc;
    }

    private NodeIpc launchReady(FakeProcess process) throws Exception {
        NodeIpc ipc = newIpc(process, Path.of("stub.mjs"));
        CompletableFuture<Integer> future = ipc.start();
        process.stdout.write(readyFrame(READY_PORT));
        assertEquals(READY_PORT, future.get(5, TimeUnit.SECONDS));
        return ipc;
    }

    private String readyFrame(int port) {
        ObjectNode root = mapper.createObjectNode();
        root.putObject("header").put("type", "ready");
        root.putObject("body").put("wsPort", port);
        return root.toString();
    }

    private String requestFrame(String type, String id, String field, String value) {
        ObjectNode root = mapper.createObjectNode();
        ObjectNode header = root.putObject("header");
        header.put("type", type);
        header.put("id", id);
        root.putObject("body").put(field, value);
        return root.toString();
    }

    private String resultFrame(String type, String id, boolean ok, String error) {
        ObjectNode root = mapper.createObjectNode();
        ObjectNode header = root.putObject("header");
        header.put("type", type);
        header.put("id", id);
        ObjectNode body = root.putObject("body");
        body.put("ok", ok);
        if (error != null) {
            body.put("error", error);
        }
        return root.toString();
    }

    private JsonNode pollWrittenFrame(FakeProcess process) throws Exception {
        String line = process.stdin.pollLine(WAIT);
        assertNotNull(line, "NodeIpc 应已写入一行帧");
        return mapper.readTree(line);
    }

    private static long elapsedMillisSince(long beginNanos) {
        return Duration.ofNanos(System.nanoTime() - beginNanos).toMillis();
    }

    // ---- start() ----

    @Test
    void startCompletesWithWsPortAndPassesStubEnv() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = newIpc(process, Path.of("stub.mjs"));

        CompletableFuture<Integer> future = ipc.start();
        process.stdout.write(readyFrame(READY_PORT));

        assertEquals(READY_PORT, future.get(5, TimeUnit.SECONDS));
        assertSame(future, ipc.start(), "重复 start 返回同一 future");
        assertEquals(READY_PORT, listener.ready.get(5, TimeUnit.SECONDS));
        assertEquals(List.of("node", "bundle.mjs"), process.command);
        assertEquals(Path.of("stub.mjs").toString(), process.extraEnv.get(NodeIpc.STUB_PEER_ENV));
        ipc.shutdown("done");
    }

    @Test
    void startWithoutStubPathOmitsEnv() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = newIpc(process, null);

        CompletableFuture<Integer> future = ipc.start();
        process.stdout.write(readyFrame(23456));

        assertEquals(23456, future.get(5, TimeUnit.SECONDS));
        assertFalse(process.extraEnv.containsKey(NodeIpc.STUB_PEER_ENV));
        ipc.shutdown("done");
    }

    @Test
    void startFailsWhenProcessExitsBeforeReady() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = newIpc(process, null);

        CompletableFuture<Integer> future = ipc.start();
        process.exit(1);

        ExecutionException failure = assertThrows(ExecutionException.class, () -> future.get(5, TimeUnit.SECONDS));
        assertTrue(failure.getCause() instanceof IpcException);
        assertTrue(
                failure.getCause().getMessage().contains("ready"),
                failure.getCause().getMessage());
        ipc.shutdown("done");
    }

    @Test
    void startTimesOutWithoutReadyFrame() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = newIpc(process, null);
        ipc.setStartTimeout(Duration.ofMillis(150));

        CompletableFuture<Integer> future = ipc.start();

        ExecutionException failure = assertThrows(ExecutionException.class, () -> future.get(5, TimeUnit.SECONDS));
        assertTrue(
                failure.getCause() instanceof TimeoutException,
                failure.getCause().toString());
        ipc.shutdown("done");
    }

    // ---- broadcast() / executeCommand()（Java → Node 请求）----

    @Test
    void broadcastRoundTripOkIncludingUtf8() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = launchReady(process);

        CompletableFuture<Void> sent = ipc.broadcast("你好，<&>\"world\"");
        JsonNode frame = pollWrittenFrame(process);
        assertEquals("broadcast", frame.path("header").path("type").asText());
        String id = frame.path("header").path("id").asText();
        assertDoesNotThrow(() -> UUID.fromString(id));
        assertEquals("你好，<&>\"world\"", frame.path("body").path("message").asText());

        process.stdout.write(resultFrame("broadcast_result", id, true, null));
        sent.get(5, TimeUnit.SECONDS);
        ipc.shutdown("done");
    }

    @Test
    void broadcastErrorResultFailsFuture() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = launchReady(process);

        CompletableFuture<Void> sent = ipc.broadcast("hello");
        String id = pollWrittenFrame(process).path("header").path("id").asText();

        process.stdout.write(resultFrame("broadcast_result", id, false, "denied by rule"));
        ExecutionException failure = assertThrows(ExecutionException.class, () -> sent.get(5, TimeUnit.SECONDS));
        assertTrue(failure.getCause() instanceof IpcException);
        assertTrue(failure.getCause().getMessage().contains("denied by rule"));
        ipc.shutdown("done");
    }

    @Test
    void broadcastTimesOutWhenNoResultArrives() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = launchReady(process);
        ipc.setRequestTimeout(Duration.ofMillis(150));

        CompletableFuture<Void> sent = ipc.broadcast("slow");

        ExecutionException failure = assertThrows(ExecutionException.class, () -> sent.get(5, TimeUnit.SECONDS));
        assertTrue(
                failure.getCause() instanceof TimeoutException,
                failure.getCause().toString());
        ipc.shutdown("done");
    }

    @Test
    void executeCommandRoundTripOk() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = launchReady(process);

        CompletableFuture<Void> sent = ipc.executeCommand("whitelist list");
        JsonNode frame = pollWrittenFrame(process);
        assertEquals("execute_command", frame.path("header").path("type").asText());
        String id = frame.path("header").path("id").asText();
        assertEquals("whitelist list", frame.path("body").path("command").asText());

        process.stdout.write(resultFrame("execute_command_result", id, true, null));
        sent.get(5, TimeUnit.SECONDS);
        ipc.shutdown("done");
    }

    // ---- Node → Java 请求（listener 回调）----

    @Test
    void incomingBroadcastRequestInvokesListenerAndOkResult() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = launchReady(process);

        String id = "11111111-2222-3333-4444-555555555555";
        process.stdout.write(requestFrame("broadcast", id, "message", "全服公告"));

        RecordingListener.BroadcastCall call = listener.broadcastCalls.poll(5, TimeUnit.SECONDS);
        assertNotNull(call, "onBroadcast 应被调用");
        assertEquals("全服公告", call.message());
        call.result().ok();

        JsonNode frame = pollWrittenFrame(process);
        assertEquals("broadcast_result", frame.path("header").path("type").asText());
        assertEquals(id, frame.path("header").path("id").asText());
        assertTrue(frame.path("body").path("ok").asBoolean());
        assertFalse(frame.path("body").has("error"));
        ipc.shutdown("done");
    }

    @Test
    void incomingExecuteCommandInvokesListenerAndErrorResult() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = launchReady(process);

        String id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        process.stdout.write(requestFrame("execute_command", id, "command", "stop"));

        RecordingListener.CommandCall call = listener.executeCalls.poll(5, TimeUnit.SECONDS);
        assertNotNull(call, "onExecuteCommand 应被调用");
        assertEquals("stop", call.command());
        call.result().error("no permission");

        JsonNode frame = pollWrittenFrame(process);
        assertEquals("execute_command_result", frame.path("header").path("type").asText());
        assertEquals(id, frame.path("header").path("id").asText());
        assertFalse(frame.path("body").path("ok").asBoolean());
        assertEquals("no permission", frame.path("body").path("error").asText());
        ipc.shutdown("done");
    }

    // ---- 事件发送 ----

    @Test
    void gameChatSendsEventFrameWithoutId() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = launchReady(process);

        assertTrue(ipc.sendGameChat("Steve", "hello world"), "通道可用时应返回 true");

        JsonNode frame = pollWrittenFrame(process);
        assertEquals("game_chat", frame.path("header").path("type").asText());
        assertFalse(frame.path("header").has("id"), "事件帧严禁携带 id");
        assertEquals("Steve", frame.path("body").path("playerName").asText());
        assertEquals("hello world", frame.path("body").path("content").asText());
        ipc.shutdown("done");
    }

    @Test
    void playerJoinQuitAndStatusSendEventFramesWithoutId() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = launchReady(process);

        assertTrue(ipc.sendPlayerJoin("Alex"), "通道可用时应返回 true");
        JsonNode join = pollWrittenFrame(process);
        assertEquals("player_join", join.path("header").path("type").asText());
        assertFalse(join.path("header").has("id"), "事件帧严禁携带 id");
        assertEquals("Alex", join.path("body").path("playerName").asText());

        assertTrue(ipc.sendPlayerQuit("Alex"), "通道可用时应返回 true");
        JsonNode quit = pollWrittenFrame(process);
        assertEquals("player_quit", quit.path("header").path("type").asText());
        assertFalse(quit.path("header").has("id"), "事件帧严禁携带 id");
        assertEquals("Alex", quit.path("body").path("playerName").asText());

        assertTrue(ipc.sendStatus(19.5, 3, 12345L), "通道可用时应返回 true");
        JsonNode status = pollWrittenFrame(process);
        assertEquals("status", status.path("header").path("type").asText());
        assertFalse(status.path("header").has("id"), "事件帧严禁携带 id");
        assertEquals(19.5, status.path("body").path("tps").asDouble(), 0.0);
        assertEquals(3, status.path("body").path("onlinePlayers").asInt());
        assertEquals(12345L, status.path("body").path("uptimeSeconds").asLong());
        ipc.shutdown("done");
    }

    @Test
    void eventSendsAreDroppedWithWarningWhenChannelUnavailable() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = newIpc(process, null); // 未 start：通道不可用

        assertFalse(ipc.sendPlayerJoin("Alex"), "通道不可用应返回 false");
        assertFalse(ipc.sendPlayerQuit("Alex"), "通道不可用应返回 false");
        assertFalse(ipc.sendStatus(20.0, 1, 60L), "通道不可用应返回 false");
        assertFalse(ipc.sendGameChat("Alex", "no channel"), "通道不可用应返回 false");
        assertFalse(ipc.sendPlayerJoin(""), "空 playerName 应返回 false");
        assertTrue(
                logs.stream().anyMatch(line -> line.contains("[WARN]") && line.contains("IPC 通道不可用")), "通道不可用丢弃应有告警日志");
        assertTrue(
                logs.stream().anyMatch(line -> line.contains("[WARN]") && line.contains("playerName 不能为空")),
                "参数非法丢弃应有告警日志");
        ipc.shutdown("never started");
    }

    @Test
    void sendStatusRejectsNegativeMetrics() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = launchReady(process);

        assertFalse(ipc.sendStatus(-0.1, 1, 60L), "负 tps 应丢弃");
        assertFalse(ipc.sendStatus(20.0, -1, 60L), "负 onlinePlayers 应丢弃");
        assertFalse(ipc.sendStatus(20.0, 1, -1L), "负 uptimeSeconds 应丢弃");
        assertTrue(logs.stream().anyMatch(line -> line.contains("[WARN]") && line.contains("不能为负")), "非法指标应有告警日志");
        assertNull(process.stdin.pollLine(Duration.ofMillis(300)), "非法 status 不得写出任何帧");
        ipc.shutdown("done");
    }

    // ---- 容错：坏行跳过 / stderr 中继 ----

    @Test
    void unknownAndMalformedLinesAreSkippedWithoutCrash() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = launchReady(process);
        String id = "99999999-8888-7777-6666-555555555555";

        process.stdout.write("not json at all");
        process.stdout.write("{\"header\":{\"type\":\"mystery\"},\"body\":{}}");
        process.stdout.write("{}");
        process.stdout.write("[1,2,3]");
        process.stdout.write("{\"header\":{\"type\":\"ready\",\"id\":\"" + id + "\"},\"body\":{\"wsPort\":1}}");
        process.stdout.write(requestFrame("broadcast", id, "message", ""));

        // 读取循环必须仍然存活：广播可正常往返
        CompletableFuture<Void> sent = ipc.broadcast("still alive");
        String requestId = pollWrittenFrame(process).path("header").path("id").asText();
        process.stdout.write(resultFrame("broadcast_result", requestId, true, null));
        sent.get(5, TimeUnit.SECONDS);

        assertNull(listener.broadcastCalls.poll(300, TimeUnit.MILLISECONDS), "非法 broadcast 不得触发回调");
        assertTrue(logs.stream().anyMatch(line -> line.contains("[WARN]")), "坏行应有告警日志");
        ipc.shutdown("done");
    }

    @Test
    void stderrLinesAreRelayedToListener() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = launchReady(process);

        process.stderr.write("[KuroBot][node][info] booted");

        assertEquals("[KuroBot][node][info] booted", listener.stderrLines.poll(5, TimeUnit.SECONDS));
        ipc.shutdown("done");
    }

    // ---- shutdown() ----

    @Test
    void shutdownIsGracefulAndIdempotent() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = launchReady(process);
        CompletableFuture<Void> orphan = ipc.broadcast("left hanging");

        long begin = System.nanoTime();
        ipc.shutdown("test-stop");
        ipc.shutdown("重复调用应立即返回");
        long elapsedMs = elapsedMillisSince(begin);

        assertTrue(elapsedMs < 3000, "shutdown 应有界快速返回，实际 " + elapsedMs + "ms");
        JsonNode inFlight = pollWrittenFrame(process);
        assertEquals("broadcast", inFlight.path("header").path("type").asText(), "在途请求先落盘");
        JsonNode frame = pollWrittenFrame(process);
        assertEquals("shutdown", frame.path("header").path("type").asText());
        assertFalse(frame.path("header").has("id"));
        assertEquals("test-stop", frame.path("body").path("reason").asText());
        assertTrue(process.stdin.isClosed(), "stdin 应已关闭");
        assertFalse(process.isAlive(), "假进程应经 stdin EOF 正常退出");
        assertThrows(ExecutionException.class, () -> orphan.get(5, TimeUnit.SECONDS), "在途请求应被失败");
    }

    @Test
    void shutdownForciblyTerminatesStubbornProcess() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = launchReady(process);
        process.setStubborn(true);
        ipc.setShutdownGrace(Duration.ofMillis(150));
        ipc.setShutdownForceWait(Duration.ofMillis(150));

        long begin = System.nanoTime();
        ipc.shutdown("force");
        long elapsedMs = elapsedMillisSince(begin);

        assertTrue(elapsedMs < 5000, "shutdown 对僵尸进程也应有界返回，实际 " + elapsedMs + "ms");
        assertEquals(
                "shutdown",
                pollWrittenFrame(process).path("header").path("type").asText(),
                "destroy 前仍应尽力发出 shutdown 帧");
    }

    // ---- 边界：未启动 / close() ----

    @Test
    void requestsBeforeStartFailFast() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = newIpc(process, null);

        CompletableFuture<Void> sent = ipc.broadcast("too early");
        assertTrue(sent.isCompletedExceptionally(), "未启动时请求应立即异常完成");
        assertThrows(ExecutionException.class, () -> sent.get(1, TimeUnit.SECONDS));

        ipc.sendGameChat("Alex", "no channel yet"); // 仅告警，不抛不崩（返回值此处不关心）
        assertFalse(ipc.sendPlayerJoin("Alex"), "无通道时事件发送应返回 false");
        ipc.shutdown("never started");
    }

    @Test
    void closeDelegatesToShutdown() throws Exception {
        FakeProcess process = new FakeProcess();
        NodeIpc ipc = launchReady(process);

        ipc.close(); // AutoCloseable 形式委托到 shutdown

        assertTrue(process.stdin.isClosed());
        JsonNode frame = pollWrittenFrame(process);
        assertEquals("shutdown", frame.path("header").path("type").asText());
        assertEquals("NodeIpc.close()", frame.path("body").path("reason").asText());
    }
}
