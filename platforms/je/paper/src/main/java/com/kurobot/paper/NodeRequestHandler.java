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
 * 只把 Bukkit API 操作经 {@code runTask} 调度回主线程（入队即返回），随后立即回执
 * {@link IpcResult}；回执在通道已关闭时由 :core 忽略。本类零业务——转发规则、权限语义等
 * 决策都在 Node 侧（AGENTS.md 硬约束 2）。
 */
public final class NodeRequestHandler implements NodeIpcListener {
    private final KuroBotPlugin plugin;

    public NodeRequestHandler(KuroBotPlugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public void onReady(int wsPort) {
        // 就绪主日志由主类的 start future 回调打印；此处仅记录回调到达（同一线程，紧邻其后）
        plugin.getLogger().info(() -> "[KuroBot] onReady 回调到达：wsPort=" + wsPort);
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
        try {
            Bukkit.getScheduler().runTask(plugin, () -> Bukkit.dispatchCommand(Bukkit.getConsoleSender(), command));
        } catch (RuntimeException e) {
            result.error("调度命令执行到主线程失败：" + e.getMessage());
            return;
        }
        result.ok(); // 已调度回主线程执行即回执 ok（命令本身的成功与否由命令语义决定）
    }

    @Override
    public void onStderrLine(String line) {
        // Node 侧日志行自带 [KuroBot][node][LEVEL] 前缀（bridge/embedded 的 logger），原样中继
        plugin.getLogger().info(line);
    }
}
