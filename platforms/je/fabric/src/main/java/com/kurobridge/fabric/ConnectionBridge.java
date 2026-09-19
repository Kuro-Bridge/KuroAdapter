package com.kurobridge.fabric;

import com.kurobridge.core.NodeIpc;
import java.lang.management.ManagementFactory;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayNetworkHandler;

/**
 * 玩家进出服事件桥接 + 服务器状态快照数据源。
 *
 * <p>status 推送时机 = 玩家进出服（在线数变化点）：join/quit 后各补一帧 status 快照，让
 * Node 侧拿到最新的 TPS / 在线数 / uptime（paper 同语义）。零业务：转发到哪些频道
 * （fan-out）由 Node 侧绑定表决定，薄壳只上报原始事件（AGENTS.md 硬约束 2）。
 *
 * <p>线程契约：JOIN / DISCONNECT 在服务端主线程触发，直接调用 {@link NodeIpc} 发送即可
 * （:core 写锁串行，不阻塞主线程）；TPS 采样器同为单线程（主线程逐 tick 喂样），无并发防护。
 */
final class ConnectionBridge {

    private ConnectionBridge() {}

    static void onJoin(KuroBridgeMod mod, ServerPlayNetworkHandler handler, MinecraftServer server) {
        NodeIpc ipc = mod.getIpc();
        if (ipc == null) {
            return; // 开发模式/降级：无 IPC，静默跳过
        }
        ipc.sendPlayerJoin(handler.player.getGameProfile().getName());
        sendStatusSnapshot(mod, ipc, server);
    }

    static void onDisconnect(KuroBridgeMod mod, ServerPlayNetworkHandler handler, MinecraftServer server) {
        NodeIpc ipc = mod.getIpc();
        if (ipc == null) {
            return; // 开发模式/降级：无 IPC，静默跳过
        }
        ipc.sendPlayerQuit(handler.player.getGameProfile().getName());
        sendStatusSnapshot(mod, ipc, server);
    }

    /** 进出服后的状态快照（在线数已变化，Node 侧按事件顺序处理即得新值）。 */
    private static void sendStatusSnapshot(KuroBridgeMod mod, NodeIpc ipc, MinecraftServer server) {
        ipc.sendStatus(currentTps(mod), server.getPlayerManager().getCurrentPlayerCount(), uptimeSeconds());
    }

    /** 60s 滑动窗 TPS（TickRateSampler 自测）+ 1 位小数/下限 0（协议 nonnegative，同 paper 口径）。 */
    private static double currentTps(KuroBridgeMod mod) {
        TickRateSampler sampler = mod.tickSampler();
        double tps = sampler == null ? TickRateSampler.TARGET_TPS : sampler.sampleTps();
        return TickRateSampler.normalizeTps(tps);
    }

    /** JVM uptime（JDK 标准接口），等价专用服场景下的服务器 uptime。 */
    private static long uptimeSeconds() {
        return ManagementFactory.getRuntimeMXBean().getUptime() / 1000;
    }
}
