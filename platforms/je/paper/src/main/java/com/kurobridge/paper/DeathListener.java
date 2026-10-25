package com.kurobridge.paper;

import com.kurobridge.KuroBridgePlugin;
import com.kurobridge.core.NodeIpc;
import java.util.regex.Pattern;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.PlayerDeathEvent;

/**
 * 玩家死亡事件桥接（v0.3.0；ADR-038 universal 化）：PlayerDeathEvent → getDeathMessage()
 * String → 剥 legacy 颜色码 → 上报 Node。
 *
 * <p>String 取值路径经 26.3 paper-api jar 实证全版本存留（1.12.2 → 26.3），不再走
 * Component 序列化——旧版取值在 Paper 侧经 legacy 序列化，可能带 {@code §} 颜色码，
 * {@link #LEGACY_COLOR} 剥离后即为纯文本。
 *
 * <p>deathMessage 可为 null（/kill 等无死亡消息场景）→ 以空串兜底（协议允许 message 为空串，
 * 与 join/quit 的 playerName min(1) 不同）。零业务：按绑定频道 fan-out 由 Node 侧决定，
 * 薄壳只上报原始事件（AGENTS.md 硬约束 2）。
 *
 * <p>线程契约：PlayerDeathEvent 在 Bukkit 主线程触发，直接调用 {@link NodeIpc} 发送即可
 * （:core 写锁串行，不阻塞主线程）。
 */
public final class DeathListener implements Listener {
    /** legacy 颜色码 §X / §xX（大小写通吃），死亡消息取 String 路径时可能出现 */
    private static final Pattern LEGACY_COLOR = Pattern.compile("(?i)\u00a7[0-9A-FK-ORX]");

    private final KuroBridgePlugin plugin;

    public DeathListener(KuroBridgePlugin plugin) {
        this.plugin = plugin;
    }

    @SuppressWarnings("deprecation") // getDeathMessage()：String 取值 1.12.2 → 26.3 全版本存留（ADR-038）
    @EventHandler
    public void onDeath(PlayerDeathEvent event) {
        NodeIpc ipc = plugin.getIpc();
        if (ipc == null) {
            return; // 开发模式（未配置 KUROBRIDGE_BUNDLE）：无 IPC，静默跳过
        }
        String deathMessage = event.getDeathMessage();
        String text =
                deathMessage == null ? "" : LEGACY_COLOR.matcher(deathMessage).replaceAll("");
        ipc.sendPlayerDeath(event.getEntity().getName(), text);
    }
}
