package com.kurobridge.paper;

import com.kurobridge.KuroBridgePlugin;
import com.kurobridge.core.NodeIpc;
import java.lang.management.ManagementFactory;
import org.bukkit.Bukkit;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;

/**
 * 玩家进出服事件桥接 + 服务器状态快照数据源。
 *
 * <p>status 推送时机 = 玩家进出服（在线数变化点）：join/quit 后各补一帧 status 快照，让
 * Node 侧拿到最新的 TPS / 在线数 / uptime。零业务：转发到哪些频道（fan-out）由 Node 侧
 * 绑定表决定，薄壳只上报原始事件（AGENTS.md 硬约束 2）。
 *
 * <p><b>线程契约：PlayerJoinEvent / PlayerQuitEvent 在 Bukkit 主线程触发</b>，直接调用
 * {@link NodeIpc} 发送即可——其发送方法线程安全（:core 写锁串行），不会阻塞主线程。
 */
public final class ConnectionListener implements Listener {
    private final KuroBridgePlugin plugin;

    public ConnectionListener(KuroBridgePlugin plugin) {
        this.plugin = plugin;
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        NodeIpc ipc = plugin.getIpc();
        if (ipc == null) {
            return; // 开发模式（未配置 KUROBRIDGE_BUNDLE）：无 IPC，静默跳过
        }
        ipc.sendPlayerJoin(event.getPlayer().getName());
        sendStatusSnapshot(ipc);
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        NodeIpc ipc = plugin.getIpc();
        if (ipc == null) {
            return; // 开发模式（未配置 KUROBRIDGE_BUNDLE）：无 IPC，静默跳过
        }
        ipc.sendPlayerQuit(event.getPlayer().getName());
        sendStatusSnapshot(ipc);
    }

    /** 进出服后的状态快照（在线数已变化，Node 侧按事件顺序处理即得新值）。 */
    private void sendStatusSnapshot(NodeIpc ipc) {
        ipc.sendStatus(currentTps(), Bukkit.getOnlinePlayers().size(), uptimeSeconds());
    }

    /** 1 分钟窗口 TPS（Paper API）；clamp 到 >=0 并保留 1 位小数（协议要求 nonnegative）。 */
    private static double currentTps() {
        double tps = Bukkit.getTPS()[0];
        return Math.max(0, Math.round(tps * 10.0) / 10.0);
    }

    /** JVM uptime（JDK 标准接口），等价专用服场景下的服务器 uptime。 */
    private static long uptimeSeconds() {
        return ManagementFactory.getRuntimeMXBean().getUptime() / 1000;
    }
}
