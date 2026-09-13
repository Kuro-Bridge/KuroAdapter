package com.kurobot.paper;

import com.kurobot.KuroBotPlugin;
import com.kurobot.core.IpcResult;
import com.kurobot.core.NodeIpcListener;
import net.kyori.adventure.text.Component;
import org.bukkit.Bukkit;

/**
 * Node 侧请求的 Bukkit 桥接（实现 :core 的 {@link NodeIpcListener}）。
 *
 * <p><b>线程契约：全部回调在 :core 的 IPC 读取虚拟线程（kurobot-ipc-stdout /
 * kurobot-ipc-stderr）上被调用</b>，不在 Bukkit 主线程。硬约束「IPC 永不阻塞主线程」：本类
 * 只把 Bukkit API 操作经 {@code runTask} 调度回主线程（入队即返回）；broadcast 调度后立即
 * 回执，execute_command（v0.3.0）改为在主线程任务内执行完命令、以收集型 CommandSender 的
 * 输出行回执 {@link IpcResult}（Node 侧等待真实执行完成，调度/执行失败显式 error）。回执在
 * 通道已关闭时由 :core 忽略。本类零业务——转发规则、权限语义等决策都在 Node 侧
 * （AGENTS.md 硬约束 2）。
 */
public final class NodeRequestHandler implements NodeIpcListener {
    private final KuroBotPlugin plugin;

    public NodeRequestHandler(KuroBotPlugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public void onReady(int wsPort, boolean autoRestart) {
        // 就绪主日志与汇总行由主类的 onNodeReady 打印（含 autoRestart 看护开关的消费）
        plugin.onNodeReady(wsPort, autoRestart);
    }

    @Override
    public void onBroadcast(String message, IpcResult result) {
        try {
            Bukkit.getScheduler().runTask(plugin, () -> Bukkit.broadcast(Component.text(message)));
        } catch (RuntimeException e) {
            // 插件已 disable 等导致调度失败：显式回执失败，避免 Node 侧等到超时
            result.error("调度广播到主线程失败：" + e.getMessage());
            return;
        }
        result.ok(); // 广播调度后即回执 ok
    }

    @Override
    public void onExecuteCommand(String command, IpcResult result) {
        CollectingCommandSender sender = new CollectingCommandSender();
        try {
            Bukkit.getScheduler().runTask(plugin, () -> {
                try {
                    Bukkit.dispatchCommand(sender, command);
                } catch (RuntimeException e) {
                    // 命令本身抛异常（插件命令 bug 等）：显式回执失败，避免 Node 侧等到超时
                    result.error("命令执行异常：" + e.getMessage());
                    return;
                }
                result.ok(sender.collectedLines());
            });
        } catch (RuntimeException e) {
            // 插件已 disable 等导致调度失败：显式回执失败，避免 Node 侧等到超时
            result.error("调度命令执行到主线程失败：" + e.getMessage());
        }
        // 回执时序（v0.3.0）：主线程任务执行完才 ok（Node 等待真实执行完成）；主线程卡死
        // 超过请求超时（10s）由 Node 侧既有 IPC 超时兜底
    }

    @Override
    public void onStderrLine(String line) {
        // Node 侧日志行自带 [KuroBot][node][LEVEL] 前缀（bridge/embedded 的 logger），原样中继
        plugin.getLogger().info(line);
    }

    @Override
    public void onProcessExited(Integer exitCode, String cause) {
        // 看护决策在 :core NodeSupervisor（重启/放弃）；此处仅留下宿主可观测的记录
        plugin.getLogger().info(() -> "Node 进程退出通知：exit=" + (exitCode == null ? "未知" : exitCode) + "，原因=" + cause);
    }
}
