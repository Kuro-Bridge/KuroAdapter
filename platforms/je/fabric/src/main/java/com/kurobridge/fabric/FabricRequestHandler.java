package com.kurobridge.fabric;

import com.kurobridge.core.IpcResult;
import com.kurobridge.core.NodeIpcListener;
import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.text.Text;

/**
 * Node 侧请求的 Fabric 桥接（实现 :core 的 {@link NodeIpcListener}）。
 *
 * <p><b>线程契约：全部回调在 :core 的 IPC 读取虚拟线程（kurobridge-ipc-stdout /
 * kurobridge-ipc-stderr）上被调用</b>，不在服务端主线程。硬约束「IPC 永不阻塞主线程」：
 * 本类只把 MC API 操作经 {@code server.execute} 调度回主线程（入队即返回）；broadcast 调度
 * 后立即回执，execute_command 在主线程任务内执行完命令、以收集型 CommandOutput 的输出行
 * 回执 {@link IpcResult}（Node 侧等待真实执行完成，调度/执行失败显式 error）。回执在通道
 * 已关闭时由 :core 忽略。本类零业务——转发规则等决策都在 Node 侧（AGENTS.md 硬约束 2）。
 *
 * <p>与 paper 的差异（docs/design.md §4）：fabric 无 Craft* 类型包装层，自定义
 * CommandOutput 原生可用——vanilla 命令不需要「回退真实 console + log4j appender 截流」
 * 的回执路径（paper VanillaFeedbackCapture / VanillaCommandWrapper 回退整体不存在）。
 */
public final class FabricRequestHandler implements NodeIpcListener {
    private final KuroBridgeMod mod;
    private final MinecraftServer server;

    public FabricRequestHandler(KuroBridgeMod mod, MinecraftServer server) {
        this.mod = mod;
        this.server = server;
    }

    @Override
    public void onReady(int wsPort, boolean autoRestart) {
        // 就绪主日志与汇总行由主类的 onNodeReady 打印（含 autoRestart 看护开关的消费）
        mod.onNodeReady(wsPort, autoRestart);
    }

    @Override
    public void onBroadcast(String message, IpcResult result) {
        try {
            // PlayerManager.broadcast(Text, boolean) 的 vanilla 语义即「全体玩家 + 服务端控制台」，
            // 一步覆盖 Bukkit.broadcast 的等价面
            server.execute(() -> server.getPlayerManager().broadcast(Text.literal(message), false));
        } catch (RuntimeException e) {
            // mod 已停止等导致调度失败：显式回执失败，避免 Node 侧等到超时
            result.error("调度广播到主线程失败：" + e.getMessage());
            return;
        }
        result.ok(); // 广播调度后即回执 ok
    }

    @Override
    public void onExecuteCommand(String command, IpcResult result) {
        CollectingCommandOutput output = new CollectingCommandOutput();
        try {
            // 控制台语义 source（level 4）+ 输出改道收集器：反馈/错误行全部进缓冲，不落控制台
            ServerCommandSource source = server.getCommandSource().withOutput(output);
            server.execute(() -> {
                try {
                    CommandDispatcher<ServerCommandSource> dispatcher =
                            server.getCommandManager().getDispatcher();
                    dispatcher.execute(dispatcher.parse(command, source));
                } catch (CommandSyntaxException e) {
                    // 命令语法/执行错误（Brigadier 显式异常）：回执原文，避免 Node 侧等到超时
                    KuroBridgeMod.LOGGER.warn("execute_command 执行异常：{}", command, e);
                    result.error("命令执行异常：" + e.getRawMessage().getString());
                    return;
                } catch (RuntimeException e) {
                    // 命令本身抛异常（mod 命令 bug 等）：显式回执失败
                    KuroBridgeMod.LOGGER.warn("execute_command 执行异常：{}", command, e);
                    result.error("命令执行异常：" + e.getMessage());
                    return;
                }
                result.ok(output.collectedLines());
            });
        } catch (RuntimeException e) {
            // mod 已停止等导致调度失败：显式回执失败，避免 Node 侧等到超时
            result.error("调度命令执行到主线程失败：" + e.getMessage());
        }
        // 回执时序：主线程任务执行完才 ok（Node 等待真实执行完成）；主线程卡死超过请求
        // 超时（10s）由 Node 侧既有 IPC 超时兜底
    }

    @Override
    public void onStderrLine(String line) {
        // Node 侧日志行自带 [KuroBridge][node][LEVEL] 前缀；IpcLogLevels 单一解析点定级后
        // 机械映射到 slf4j（KuroBridgeMod.relayIpcLog）
        KuroBridgeMod.relayIpcLog(line);
    }

    @Override
    public void onProcessExited(Integer exitCode, String cause) {
        // 看护决策在 :core NodeSupervisor（重启/放弃）；此处仅留下宿主可观测的记录
        KuroBridgeMod.LOGGER.info("Node 进程退出通知：exit={}，原因={}", exitCode == null ? "未知" : exitCode, cause);
    }
}
