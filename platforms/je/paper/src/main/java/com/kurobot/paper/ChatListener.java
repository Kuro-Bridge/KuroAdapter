package com.kurobot.paper;

import com.kurobot.KuroBotPlugin;
import com.kurobot.core.NodeIpc;
import io.papermc.paper.event.player.AsyncChatEvent;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;

/**
 * 游戏聊天事件桥接：AsyncChatEvent（本身在异步线程触发）→ 提取纯文本 → 上报 Node。
 *
 * <p>{@code kurobot.relay} 权限（v0.3.0 消费，声明 default: true）：玩家无该权限（含 negate）
 * → 该玩家聊天不上报（静音语义）；是否转发到哪些群等其余规则仍全部由 Node 侧（bridge/core 的
 * Relay）决定，薄壳零业务（AGENTS.md 硬约束 2）。
 *
 * <p>{@link NodeIpc#sendGameChat} 线程安全（:core 写锁串行），异步线程直接调用即可。
 */
public final class ChatListener implements Listener {
    private final KuroBotPlugin plugin;

    public ChatListener(KuroBotPlugin plugin) {
        this.plugin = plugin;
    }

    @EventHandler
    public void onAsyncChat(AsyncChatEvent event) {
        if (!event.getPlayer().hasPermission("kurobot.relay")) {
            return; // 无 kurobot.relay 权限（negate 即静音）：该玩家聊天不上报
        }
        NodeIpc ipc = plugin.getIpc();
        if (ipc == null) {
            return; // 开发模式（未配置 KUROBOT_BUNDLE）：无 IPC，静默跳过
        }
        String text = PlainText.serialize(event.message());
        ipc.sendGameChat(event.getPlayer().getName(), text);
    }
}
