package com.kurobridge.paper;

import com.kurobridge.KuroBridgePlugin;
import com.kurobridge.core.NodeIpc;
import net.kyori.adventure.text.Component;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.PlayerDeathEvent;

/**
 * 玩家死亡事件桥接（v0.3.0）：PlayerDeathEvent → deathMessage plain 序列化 → 上报 Node。
 *
 * <p>deathMessage 可为 null（/kill 等无死亡消息场景）→ 以空串兜底（协议允许 message 为空串，
 * 与 join/quit 的 playerName min(1) 不同）。零业务：按绑定频道 fan-out 由 Node 侧决定，
 * 薄壳只上报原始事件（AGENTS.md 硬约束 2）。
 *
 * <p>线程契约：PlayerDeathEvent 在 Bukkit 主线程触发，直接调用 {@link NodeIpc} 发送即可
 * （:core 写锁串行，不阻塞主线程）。
 */
public final class DeathListener implements Listener {
    private final KuroBridgePlugin plugin;

    public DeathListener(KuroBridgePlugin plugin) {
        this.plugin = plugin;
    }

    @EventHandler
    public void onDeath(PlayerDeathEvent event) {
        NodeIpc ipc = plugin.getIpc();
        if (ipc == null) {
            return; // 开发模式（未配置 KUROBRIDGE_BUNDLE）：无 IPC，静默跳过
        }
        Component deathMessage = event.deathMessage();
        ipc.sendPlayerDeath(event.getEntity().getName(), deathMessage == null ? "" : PlainText.serialize(deathMessage));
    }
}
