package com.kurobridge.paper;

import java.util.ArrayList;
import java.util.List;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.Logger;
import org.apache.logging.log4j.core.appender.AbstractAppender;

/**
 * vanilla 命令输出捕获器（v0.3.0，DEBT1-NOTES D1-04）。
 *
 * <p>背景：Paper 的 {@code VanillaCommandWrapper.getListener} 只接受内部 Craft* sender 类型，
 * 自定义 CommandSender 无法承接 vanilla 命令（抛 "Cannot make ... a vanilla command listener"）。
 * 因此 vanilla 命令回退真实 console sender 执行，其反馈必然经 DedicatedServer.sendMessage 落入
 * log4j 控制台流——本类在命令执行窗口内挂载一个收集型 appender 截取这些行。
 *
 * <p>精确性：只收 {@code Server thread}（命令在主线程同步执行，反馈由同一线程打出）在
 * attach/detach 窗口内的日志；异步线程（netty / IPC 读取 / spark 等）与窗口外日志均不收集。
 * Bukkit 命令路径走 CollectingCommandSender 直接收集（不经日志），两条路径互斥不重复。
 *
 * <p>线程契约：attach/detach 仅在 Bukkit 主线程调用；append 由 log4j 的日志线程回调
 * （主线程同步打日志时即主线程）。
 */
final class VanillaFeedbackCapture {
    /** Paper 服务端主线程名（vanilla 侧命名，跨 1.x 稳定）。 */
    private static final String SERVER_THREAD = "Server thread";

    private final List<String> lines = new ArrayList<>();
    private CapturingAppender appender;

    /** 挂载捕获 appender（root logger）。 */
    public void attach() {
        appender = new CapturingAppender(lines);
        ((Logger) LogManager.getRootLogger()).addAppender(appender);
    }

    /** 摘除 appender 并停用（幂等；未 attach 时为 no-op）。 */
    public void detach() {
        CapturingAppender current = appender;
        appender = null;
        if (current != null) {
            ((Logger) LogManager.getRootLogger()).removeAppender(current);
            current.stop();
        }
    }

    /** 已捕获的输出行（快照）。 */
    public List<String> collectedLines() {
        return List.copyOf(lines);
    }

    private static final class CapturingAppender extends AbstractAppender {
        private final List<String> lines;

        CapturingAppender(List<String> lines) {
            super(
                    "KuroBridgeVanillaFeedbackCapture",
                    null,
                    null,
                    true,
                    org.apache.logging.log4j.core.config.Property.EMPTY_ARRAY);
            this.lines = lines;
        }

        @Override
        public void append(LogEvent event) {
            if (!SERVER_THREAD.equals(event.getThreadName())) {
                return;
            }
            String message = event.getMessage().getFormattedMessage();
            if (!message.isEmpty()) {
                lines.add(message);
            }
        }
    }
}
