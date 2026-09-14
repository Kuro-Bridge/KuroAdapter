package com.kurobridge.core;

import java.util.ArrayDeque;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/**
 * Node 进程看护器（DEBT-2）：异常退出后按退避自动重启，失败密集时放弃——宿主进程管理职责
 * （AGENTS.md 硬约束 3），零业务、零 Bukkit API。
 *
 * <p>状态机：{@code running → restarting → running → …}，终态两个：
 * {@code stopped}（{@link #stop(String)}，onDisable 停看护 + 优雅关停当前实例）与
 * {@code given-up}（放弃终态：滑动窗口内累计失败达上限，SEVERE 提示手动恢复路径）。
 *
 * <p>失败的两个来源去重后等价处理：start future 异常完成（拉起失败/ready 前断开/超时）与
 * {@link NodeIpcListener#onProcessExited}（ready 后异常退出）——每次尝试只处理一次。
 * 重启经 {@link NodeIpcFactory} 新建实例（NodeIpc 一次性设计，start 只能成功一次）；
 * 成功 ready 即归零连续失败计数（进程稳定运行视为恢复），但窗口内的失败时间戳保留
 * （「累计」而非「连续」）。autoRestart=false 时仅记日志不重启。
 *
 * <p>日志经注入的 {@code log} 消费者输出，格式 {@code [NodeSupervisor][LEVEL] 消息}；
 * 放弃终态用 SEVERE 级别前缀，宿主（:paper）据前缀分流到对应日志级别。
 */
public final class NodeSupervisor {

    /** 每次重启新建 NodeIpc（参数由宿主闭包固化；listener 参数传看护器包装后的观察者）。 */
    @FunctionalInterface
    public interface NodeIpcFactory {
        NodeIpc create(NodeIpcListener observedListener);
    }

    /**
     * 延迟调度器（退避重启用）：:paper 给 ScheduledExecutorService 适配，测试给手动实现。
     * 返回取消句柄（幂等，停止看护时取消挂起的重启）；实现不得在调用线程内同步执行 task。
     */
    @FunctionalInterface
    public interface DelayScheduler {
        Runnable schedule(long delayMs, Runnable task);
    }

    /**
     * 看护参数（{@link #defaults()} 为生产缺省值；测试经 record 副本缩短窗口/退避）。
     *
     * @param autoRestart 自动重启开关初值（ready 上报后可被 {@code setAutoRestart} 更新）
     * @param backoffDelaysMs 退避档位（毫秒），按连续失败次数取值，越界取末档封顶
     * @param failureWindowMs 放弃判定的滑动窗口毫秒
     * @param maxFailuresInWindow 窗口内累计失败达到该次数即放弃
     * @param clock 毫秒时钟（可注入，测试用）
     */
    public record Options(
            boolean autoRestart,
            List<Long> backoffDelaysMs,
            long failureWindowMs,
            int maxFailuresInWindow,
            LongSupplier clock) {

        public static Options defaults() {
            return new Options(true, List.of(1_000L, 5_000L, 15_000L), 10 * 60_000L, 3, System::currentTimeMillis);
        }
    }

    private final NodeIpcFactory factory;
    private final NodeIpcListener userListener;
    private final Consumer<String> log;
    private final DelayScheduler scheduler;
    private final Options options;

    private final AtomicBoolean stopped = new AtomicBoolean();
    private final AtomicBoolean givenUp = new AtomicBoolean();
    private final AtomicBoolean attemptActive = new AtomicBoolean();
    /** 失败时间戳滑动窗口（synchronized(this) 保护）。 */
    private final ArrayDeque<Long> failureTimestamps = new ArrayDeque<>();

    private volatile int consecutiveFailures;
    private volatile NodeIpc current;
    private volatile Runnable pendingRestartCancel;
    /**
     * 宿主自动重启开关：初值取 {@link Options#autoRestart}，ready 帧上报后经
     * {@link #setAutoRestart(boolean)} 更新（业务配置 SSOT 在 Node 侧，Java 只消费宿主参数）。
     */
    private volatile boolean autoRestart;

    public NodeSupervisor(
            NodeIpcFactory factory,
            NodeIpcListener listener,
            Consumer<String> log,
            DelayScheduler scheduler,
            Options options) {
        this.factory = Objects.requireNonNull(factory, "factory");
        this.userListener = Objects.requireNonNull(listener, "listener");
        this.log = Objects.requireNonNull(log, "log");
        this.scheduler = Objects.requireNonNull(scheduler, "scheduler");
        this.options = Objects.requireNonNull(options, "options");
        this.autoRestart = options.autoRestart();
    }

    /** 更新自动重启开关（ready.autoRestart 上报回调；volatile 单写多读，最后一次为准）。 */
    public void setAutoRestart(boolean autoRestart) {
        this.autoRestart = autoRestart;
    }

    /** 首次拉起并进入看护。重复调用无效果（重启由看护器内部驱动）。 */
    public void start() {
        spawnAttempt();
    }

    /**
     * 停止看护（onDisable）：取消挂起的重启、优雅关停当前实例（幂等）。放弃终态下调用
     * 同样安全（回收半启动实例）。
     */
    public void stop(String reason) {
        stopped.set(true);
        Runnable cancel = pendingRestartCancel;
        if (cancel != null) {
            cancel.run();
        }
        NodeIpc cur = current;
        if (cur != null) {
            cur.shutdown(reason);
        }
        logInfo("看护已停止：" + reason);
    }

    /** 当前看护中的实例；无实例（未 start/放弃后已回收）为 null。 */
    public NodeIpc currentIpc() {
        return current;
    }

    /** 是否已进入放弃终态（:paper 可据此调整 /kurobridge send 的报错文案）。 */
    public boolean isGivenUp() {
        return givenUp.get();
    }

    /**
     * 退避间隔（纯函数，可 JUnit 直接断言）：第 n 次连续失败取 {@code backoffDelaysMs[n-1]}，
     * 越界取末档封顶；n &lt; 1 视为 1。
     */
    public static long backoffDelayMs(int consecutiveFailures, List<Long> backoffDelaysMs) {
        int index = Math.max(0, Math.min(consecutiveFailures - 1, backoffDelaysMs.size() - 1));
        return backoffDelaysMs.get(index);
    }

    // ---- 内部 ----

    private void spawnAttempt() {
        if (stopped.get() || givenUp.get()) {
            return;
        }
        attemptActive.set(true);
        NodeIpc created = factory.create(observedListener);
        current = created;
        created.start().whenComplete((wsPort, error) -> {
            if (error == null) {
                consecutiveFailures = 0;
                logInfo("Node 进程就绪（wsPort=" + wsPort + "），看护中");
                return;
            }
            handleAttemptFailure("启动失败（" + describeThrowable(error) + "）");
        });
    }

    private void handleAttemptFailure(String cause) {
        if (stopped.get() || givenUp.get()) {
            return;
        }
        if (!attemptActive.compareAndSet(true, false)) {
            return; // 同一次尝试的失败已处理（start 失败与退出通知只取其一）
        }
        consecutiveFailures++;
        long now = options.clock().getAsLong();
        int windowCount;
        synchronized (failureTimestamps) {
            pruneWindow(now);
            failureTimestamps.addLast(now);
            windowCount = failureTimestamps.size();
        }
        if (windowCount >= options.maxFailuresInWindow()) {
            givenUp.set(true);
            logSevere("放弃自动重启：" + options.failureWindowMs() / 1000 + "s 窗口内累计失败 " + windowCount + " 次（上限 "
                    + options.maxFailuresInWindow() + "）——" + cause);
            logSevere("手动恢复路径：修复问题后重启服务器，或 /reload confirm 重载插件");
            return;
        }
        if (!this.autoRestart) {
            logWarn("Node 进程退出且 autoRestart=false，不重启：" + cause);
            return;
        }
        long delay = backoffDelayMs(consecutiveFailures, options.backoffDelaysMs());
        logWarn("Node 进程异常退出（" + cause + "），" + delay + "ms 后自动重启（连续第 " + consecutiveFailures + " 次 / 窗口内第 "
                + windowCount + " 次）");
        pendingRestartCancel = scheduler.schedule(delay, this::spawnAttempt);
    }

    /** 清理窗口外的旧失败时间戳。须持有 failureTimestamps 监视器。 */
    private void pruneWindow(long now) {
        long windowStart = now - options.failureWindowMs();
        while (!failureTimestamps.isEmpty() && failureTimestamps.peekFirst() < windowStart) {
            failureTimestamps.removeFirst();
        }
    }

    /** 观察者：业务回调直通 userListener，退出通知先做看护记账再直通。 */
    private final NodeIpcListener observedListener = new NodeIpcListener() {
        @Override
        public void onReady(int wsPort, boolean autoRestart) {
            userListener.onReady(wsPort, autoRestart);
        }

        @Override
        public void onBroadcast(String message, IpcResult result) {
            userListener.onBroadcast(message, result);
        }

        @Override
        public void onExecuteCommand(String command, IpcResult result) {
            userListener.onExecuteCommand(command, result);
        }

        @Override
        public void onStderrLine(String line) {
            userListener.onStderrLine(line);
        }

        @Override
        public void onProcessExited(Integer exitCode, String cause) {
            handleAttemptFailure(describeExit(exitCode, cause));
            userListener.onProcessExited(exitCode, cause);
        }
    };

    private static String describeExit(Integer exitCode, String cause) {
        return "进程退出（exit=" + (exitCode == null ? "未知" : exitCode) + "，" + cause + "）";
    }

    private static String describeThrowable(Throwable error) {
        Throwable cause = error.getCause() != null ? error.getCause() : error;
        return cause.getMessage() != null ? cause.getMessage() : cause.toString();
    }

    private void logInfo(String message) {
        log.accept("[NodeSupervisor][INFO] " + message);
    }

    private void logWarn(String message) {
        log.accept("[NodeSupervisor][WARN] " + message);
    }

    private void logSevere(String message) {
        log.accept("[NodeSupervisor][SEVERE] " + message);
    }
}
