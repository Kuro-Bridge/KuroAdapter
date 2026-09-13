package com.kurobot.core;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/**
 * Node 子进程管理 + stdin/stdout JSON-lines IPC 客户端（ADR-010，关机路径决策 D-08）。
 *
 * <p>生命周期：
 * <ol>
 *   <li>{@link #start()}：拉起 {@code node <bundle>}（透传环境变量，可选注入
 *       {@code KUROBOT_STUB_PEER}），等待 ready 帧取得 WS 动态端口；进程提前退出或超时
 *       （默认 30s）时 future 异常完成。</li>
 *   <li>运行期：stdout / stderr 各由一个虚拟线程逐行读取（永不阻塞调用线程）；写 stdin
 *       在写锁下串行。{@link NodeIpcListener} 回调在读取线程上执行。</li>
 *   <li>{@link #shutdown(String)}：发 shutdown 帧 → 关 stdin（Node 侧 stdin EOF 自杀）→
 *       有界等待进程退出（默认 5s）→ {@code destroyForcibly()} 兜底；幂等。</li>
 * </ol>
 *
 * <p>请求-响应（{@link #broadcast(String)} / {@link #executeCommand(String)}）以 UUID 关联，
 * 默认 10s 超时、IPC 断开时异常完成。无法解析 / 未知类型的 stdout 行仅记告警并跳过，不会崩溃。
 * 所有日志经构造器注入的 {@code log} 消费者输出，格式为 {@code [NodeIpc][LEVEL] 消息}。
 */
public final class NodeIpc implements AutoCloseable {
    /** 透传给 Node 的 stub 协议端脚本路径环境变量（spike 阶段 Java 告知 Node stub 位置）。 */
    static final String STUB_PEER_ENV = "KUROBOT_STUB_PEER";

    private static final int LOG_PREVIEW_LIMIT = 200;

    private final String nodeExecutable;
    private final Path bundlePath;
    private final Path stubPath;
    private final NodeIpcListener listener;
    private final Consumer<String> log;
    private final ProcessFactory processFactory;
    private final ScheduledExecutorService scheduler;

    private final Object writeLock = new Object();
    private final ConcurrentMap<String, CompletableFuture<Void>> pending = new ConcurrentHashMap<>();
    private final CompletableFuture<Integer> startFuture = new CompletableFuture<>();
    private final AtomicBoolean spawnStarted = new AtomicBoolean();
    private final AtomicBoolean shutdownStarted = new AtomicBoolean();
    private final AtomicBoolean channelOpen = new AtomicBoolean();
    private final AtomicBoolean channelTornDown = new AtomicBoolean();
    private final AtomicBoolean readyReceived = new AtomicBoolean();

    private volatile Process process;
    private volatile Writer stdinWriter;
    private volatile Duration startTimeout = Duration.ofSeconds(30);
    private volatile Duration requestTimeout = Duration.ofSeconds(10);
    private volatile Duration shutdownGrace = Duration.ofSeconds(5);
    private volatile Duration shutdownForceWait = Duration.ofSeconds(2);
    private volatile Path workingDirectory;

    /**
     * @param nodeExecutable node 可执行文件路径
     * @param bundlePath esbuild 单文件 bundle 路径（作为 node 的唯一参数）
     * @param stubPath stub 协议端脚本路径；注入为 {@code KUROBOT_STUB_PEER}，传 null 表示不注入
     * @param listener Node 侧请求与 stderr 的回调（在读取线程上执行）
     * @param log 日志消费者（每行一条，已带级别前缀）
     */
    public NodeIpc(
            String nodeExecutable, Path bundlePath, Path stubPath, NodeIpcListener listener, Consumer<String> log) {
        this(nodeExecutable, bundlePath, stubPath, listener, log, ProcessFactory.system());
    }

    /** 全参构造（进程工厂可注入，供测试替身使用）。 */
    NodeIpc(
            String nodeExecutable,
            Path bundlePath,
            Path stubPath,
            NodeIpcListener listener,
            Consumer<String> log,
            ProcessFactory processFactory) {
        this.nodeExecutable = requireNonBlank(nodeExecutable, "nodeExecutable");
        this.bundlePath = Objects.requireNonNull(bundlePath, "bundlePath");
        this.stubPath = stubPath;
        this.listener = Objects.requireNonNull(listener, "listener");
        this.log = Objects.requireNonNull(log, "log");
        this.processFactory = Objects.requireNonNull(processFactory, "processFactory");
        this.scheduler = Executors.newSingleThreadScheduledExecutor(
                Thread.ofVirtual().name("kurobot-ipc-scheduler").factory());
    }

    /**
     * 拉起 node bundle 并等待 ready 帧。
     *
     * @return future 以 ready 帧中的 wsPort 正常完成；进程提前退出 / 拉起失败 / 超时（默认
     *     30s）时以 {@link IpcException} 或 {@link TimeoutException} 异常完成。重复调用返回同一 future。
     */
    public CompletableFuture<Integer> start() {
        if (spawnStarted.compareAndSet(false, true)) {
            spawn();
        }
        return startFuture;
    }

    /** 发送游戏聊天事件（事件帧无 id）。线程安全；通道不可用时仅记告警并丢弃。 */
    public void sendGameChat(String playerName, String content) {
        Objects.requireNonNull(playerName, "playerName");
        Objects.requireNonNull(content, "content");
        if (playerName.isEmpty() || content.isEmpty()) {
            logWarn("game_chat 的 playerName/content 不能为空，丢弃该事件");
            return;
        }
        if (unavailable("game_chat 事件")) {
            return;
        }
        writeFrame(IpcFrameCodec.encodeGameChat(playerName, content));
    }

    /** 发送广播请求并等待 broadcast_result；默认 10s 超时 / IPC 断开时异常完成。 */
    public CompletableFuture<Void> broadcast(String message) {
        Objects.requireNonNull(message, "message");
        return sendRequest(IpcFrameCodec.TYPE_BROADCAST, "message", message);
    }

    /** 发送执行命令请求并等待 execute_command_result；默认 10s 超时 / IPC 断开时异常完成。 */
    public CompletableFuture<Void> executeCommand(String command) {
        Objects.requireNonNull(command, "command");
        return sendRequest(IpcFrameCodec.TYPE_EXECUTE_COMMAND, "command", command);
    }

    /**
     * 关闭 IPC：发 shutdown 帧 → 关 stdin → 有界等待进程退出 → destroyForcibly 兜底。
     * 幂等：重复调用立即返回。在途请求与未完成的 start 均异常完成。
     *
     * @param reason 关机原因（写入 shutdown 帧；空白时以 "unspecified" 兜底）
     */
    public void shutdown(String reason) {
        if (!shutdownStarted.compareAndSet(false, true)) {
            return;
        }
        String safeReason = (reason == null || reason.isBlank()) ? "unspecified" : reason;
        if (channelOpen.get()) {
            writeFrame(IpcFrameCodec.encodeShutdown(safeReason));
            closeStdin();
        }
        waitForExitBounded();
        tearDownChannel("shutdown(" + safeReason + ")");
        scheduler.shutdownNow();
        logInfo("Node IPC 已关闭：" + safeReason);
    }

    /** {@link #shutdown(String)} 的 AutoCloseable 形式（原因固定为 {@code NodeIpc.close()}）。 */
    @Override
    public void close() {
        shutdown("NodeIpc.close()");
    }

    // ---- 测试钩子（包内可见）：缩短超时以便测试有界行为 ----

    void setStartTimeout(Duration timeout) {
        this.startTimeout = Objects.requireNonNull(timeout, "timeout");
    }

    void setRequestTimeout(Duration timeout) {
        this.requestTimeout = Objects.requireNonNull(timeout, "timeout");
    }

    void setShutdownGrace(Duration grace) {
        this.shutdownGrace = Objects.requireNonNull(grace, "grace");
    }

    void setShutdownForceWait(Duration wait) {
        this.shutdownForceWait = Objects.requireNonNull(wait, "wait");
    }

    /**
     * 子进程工作目录（须在 {@link #start()} 前调用）。null/缺省 = 继承当前进程目录
     * （生产形态：Paper 以服务器根目录运行，Node 侧据此定位 plugins/kurobot/config.json；
     * 集成测试用它把子进程指到带配置的临时目录）。
     */
    void setWorkingDirectory(Path directory) {
        this.workingDirectory = Objects.requireNonNull(directory, "directory");
    }

    // ---- 启动 ----

    private void spawn() {
        if (shutdownStarted.get()) {
            startFuture.completeExceptionally(new IpcException("NodeIpc 已 shutdown，无法启动"));
            return;
        }
        List<String> command = List.of(nodeExecutable, bundlePath.toString());
        Map<String, String> extraEnv = new HashMap<>();
        if (stubPath != null) {
            extraEnv.put(STUB_PEER_ENV, stubPath.toString());
        }
        Process spawned;
        try {
            spawned = processFactory.start(command, extraEnv, workingDirectory);
        } catch (IOException | RuntimeException e) {
            startFuture.completeExceptionally(new IpcException("拉起 Node 进程失败：" + e.getMessage(), e));
            return;
        }
        process = spawned;
        stdinWriter = new BufferedWriter(new OutputStreamWriter(spawned.getOutputStream(), StandardCharsets.UTF_8));
        channelOpen.set(true);
        logInfo("Node 进程已拉起：" + command);
        Thread.ofVirtual().name("kurobot-ipc-stdout").start(this::readStdoutLoop);
        Thread.ofVirtual().name("kurobot-ipc-stderr").start(this::readStderrLoop);
        Duration timeout = startTimeout;
        scheduler.schedule(this::onStartTimeout, timeout.toMillis(), TimeUnit.MILLISECONDS);
    }

    private void onStartTimeout() {
        if (startFuture.isDone()) {
            return;
        }
        startFuture.completeExceptionally(new TimeoutException("等待 ready 帧超时（" + startTimeout.toMillis() + "ms）"));
        Process current = process;
        if (current != null) {
            current.destroyForcibly();
        }
    }

    // ---- 读取循环（虚拟线程）----

    private void readStdoutLoop() {
        try (BufferedReader reader =
                new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = reader.readLine()) != null; ) {
                String trimmed = line.trim();
                if (!trimmed.isEmpty()) {
                    handleLine(trimmed);
                }
            }
        } catch (IOException e) {
            logWarn("stdout 读取异常：" + e.getMessage());
        } finally {
            tearDownChannel("stdout EOF");
        }
    }

    private void readStderrLoop() {
        try (BufferedReader reader =
                new BufferedReader(new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = reader.readLine()) != null; ) {
                try {
                    listener.onStderrLine(line);
                } catch (RuntimeException e) {
                    logWarn("onStderrLine 回调抛出异常，已忽略：" + e);
                }
            }
        } catch (IOException e) {
            logWarn("stderr 读取异常：" + e.getMessage());
        }
    }

    private void handleLine(String line) {
        Optional<InboundFrame> decoded = IpcFrameCodec.decode(line);
        if (decoded.isEmpty()) {
            logWarn("跳过无法解析/未知的 IPC 行：" + preview(line));
            return;
        }
        dispatch(decoded.get());
    }

    private void dispatch(InboundFrame frame) {
        switch (frame) {
            case InboundFrame.Ready ready -> handleReady(ready.wsPort());
            case InboundFrame.Request request -> handleRequest(request);
            case InboundFrame.Result result -> settleResult(result);
        }
    }

    private void handleReady(int wsPort) {
        if (!readyReceived.compareAndSet(false, true)) {
            logWarn("忽略重复的 ready 帧：wsPort=" + wsPort);
            return;
        }
        logInfo("Node ready：wsPort=" + wsPort);
        startFuture.complete(wsPort);
        notifyListener("onReady", () -> listener.onReady(wsPort));
    }

    private void handleRequest(InboundFrame.Request request) {
        String resultType = IpcFrameCodec.TYPE_BROADCAST.equals(request.type())
                ? IpcFrameCodec.TYPE_BROADCAST_RESULT
                : IpcFrameCodec.TYPE_EXECUTE_COMMAND_RESULT;
        IpcResult result = resultSink(resultType, request.id());
        if (IpcFrameCodec.TYPE_BROADCAST.equals(request.type())) {
            notifyListener("onBroadcast", () -> listener.onBroadcast(request.payload(), result));
        } else {
            notifyListener("onExecuteCommand", () -> listener.onExecuteCommand(request.payload(), result));
        }
    }

    private void notifyListener(String method, Runnable notification) {
        try {
            notification.run();
        } catch (RuntimeException e) {
            logWarn(method + " 回调抛出异常，已忽略：" + e);
        }
    }

    private IpcResult resultSink(String type, String id) {
        return new IpcResult() {
            private final AtomicBoolean answered = new AtomicBoolean();

            @Override
            public void ok() {
                respond(true, null);
            }

            @Override
            public void error(String error) {
                respond(false, error);
            }

            private void respond(boolean ok, String error) {
                if (!answered.compareAndSet(false, true)) {
                    logWarn(type + " 的 IpcResult 被重复调用，忽略后续调用");
                    return;
                }
                String safeError = (error == null || error.isEmpty()) ? "unspecified" : error;
                writeFrame(IpcFrameCodec.encodeResult(type, id, ok, safeError));
            }
        };
    }

    private void settleResult(InboundFrame.Result result) {
        CompletableFuture<Void> future = pending.remove(result.id());
        if (future == null) {
            logWarn("收到无在途请求的响应，忽略：type=" + result.type() + " id=" + result.id());
            return;
        }
        if (result.ok()) {
            future.complete(null);
            return;
        }
        future.completeExceptionally(new IpcException(result.type() + " 失败：" + result.error()));
    }

    // ---- 请求发送 ----

    private CompletableFuture<Void> sendRequest(String type, String field, String value) {
        if (value.isEmpty()) {
            return CompletableFuture.failedFuture(new IllegalArgumentException(type + " 的 " + field + " 不能为空"));
        }
        if (unavailable(type + " 请求")) {
            return CompletableFuture.failedFuture(new IpcException("IPC 通道不可用，无法发送 " + type));
        }
        String id = UUID.randomUUID().toString();
        CompletableFuture<Void> future = new CompletableFuture<>();
        pending.put(id, future);
        String frame = IpcFrameCodec.TYPE_BROADCAST.equals(type)
                ? IpcFrameCodec.encodeBroadcastRequest(id, value)
                : IpcFrameCodec.encodeExecuteCommandRequest(id, value);
        if (!writeFrame(frame)) {
            pending.remove(id);
            future.completeExceptionally(new IpcException("IPC 写入失败，" + type + " 未发出"));
            return future;
        }
        Duration timeout = requestTimeout;
        scheduler.schedule(
                () -> {
                    CompletableFuture<Void> expired = pending.remove(id);
                    if (expired != null) {
                        expired.completeExceptionally(
                                new TimeoutException(type + " 响应超时（" + timeout.toMillis() + "ms）"));
                    }
                },
                timeout.toMillis(),
                TimeUnit.MILLISECONDS);
        return future;
    }

    private boolean unavailable(String what) {
        if (shutdownStarted.get() || !channelOpen.get()) {
            logWarn("IPC 通道不可用，丢弃 " + what);
            return true;
        }
        return false;
    }

    // ---- 写入与关机 ----

    private boolean writeFrame(String json) {
        synchronized (writeLock) {
            Writer writer = stdinWriter;
            if (writer == null || !channelOpen.get()) {
                logWarn("IPC 通道已关闭，丢弃出帧");
                return false;
            }
            try {
                writer.write(json);
                writer.write("\n");
                writer.flush();
                return true;
            } catch (IOException e) {
                logWarn("写入 stdin 失败，IPC 通道视为断开：" + e.getMessage());
                tearDownChannel("stdin 写入失败");
                return false;
            }
        }
    }

    private void closeStdin() {
        synchronized (writeLock) {
            channelOpen.set(false);
            Writer writer = stdinWriter;
            if (writer == null) {
                return;
            }
            stdinWriter = null;
            try {
                writer.close();
            } catch (IOException e) {
                logWarn("关闭 stdin 失败：" + e.getMessage());
            }
        }
    }

    private void waitForExitBounded() {
        Process current = process;
        if (current == null) {
            return;
        }
        try {
            if (current.waitFor(shutdownGrace.toMillis(), TimeUnit.MILLISECONDS)) {
                return;
            }
            logInfo("Node 进程在 " + shutdownGrace.toMillis() + "ms 内未退出，destroyForcibly 兜底");
            current.destroyForcibly();
            if (!current.waitFor(shutdownForceWait.toMillis(), TimeUnit.MILLISECONDS)) {
                logWarn("destroyForcibly 后 Node 进程仍未退出，放弃等待");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            current.destroyForcibly();
        }
    }

    /** 通道终结（幂等）：关 stdin、失败 start future 与全部在途请求。可从任意线程调用。 */
    private void tearDownChannel(String cause) {
        if (!channelTornDown.compareAndSet(false, true)) {
            return;
        }
        channelOpen.set(false);
        closeStdin();
        String exitSuffix = describeExit();
        if (!startFuture.isDone()) {
            startFuture.completeExceptionally(new IpcException("Node 进程在 ready 前断开（" + cause + exitSuffix + "）"));
        }
        IpcException failure = new IpcException("IPC 通道已关闭（" + cause + exitSuffix + "）");
        for (Map.Entry<String, CompletableFuture<Void>> entry : pending.entrySet()) {
            if (pending.remove(entry.getKey(), entry.getValue())) {
                entry.getValue().completeExceptionally(failure);
            }
        }
    }

    private String describeExit() {
        Process current = process;
        if (current == null) {
            return "";
        }
        try {
            return current.isAlive() ? "" : "，exit=" + current.exitValue();
        } catch (RuntimeException e) {
            return "";
        }
    }

    // ---- 杂项 ----

    private static String requireNonBlank(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " 不能为空白");
        }
        return value;
    }

    private static String preview(String line) {
        return line.length() <= LOG_PREVIEW_LIMIT ? line : line.substring(0, LOG_PREVIEW_LIMIT) + "...";
    }

    private void logInfo(String message) {
        log.accept("[NodeIpc][INFO] " + message);
    }

    private void logWarn(String message) {
        log.accept("[NodeIpc][WARN] " + message);
    }
}
