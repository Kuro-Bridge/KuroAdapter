package com.kurobot.paper;

import com.kurobot.KuroBotPlugin;
import com.kurobot.core.NodeIpc;
import io.papermc.paper.event.player.AsyncChatEvent;
import net.kyori.adventure.text.serializer.plain.PlainComponentSerializer;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;

/**
 * 游戏聊天事件桥接：AsyncChatEvent（本身在异步线程触发）→ 提取纯文本 → 上报 Node。
 *
 * <p>零业务：是否转发、转发到哪些群等规则全部由 Node 侧（bridge/core 的 Relay）决定，
 * 薄壳只上报原始事件（kurobot.relay 权限的过滤语义属于 Node 侧转发规则，原型阶段不在此
 * 判断）。{@link NodeIpc#sendGameChat} 线程安全（:core 写锁串行），异步线程直接调用即可。
 */
public final class ChatListener implements Listener {
    /**
     * paper-api 1.21.4 只暴露 adventure-text-serializer-plain（该类自 adventure 4.15 起被标记
     * {@code @Deprecated}）；PlainTextComponentSerializer 所在的 plaintext 模块既不在 paper-api
     * 依赖中、也不随 Paper 服务端分发（见 PaperMC/Paper 的 paper-api/build.gradle.kts），引入它会
     * 在运行时抛 {@code NoClassDefFoundError}。故此处局部压制 deprecation 使用 plain 序列化器，
     * 升级到暴露 plaintext 模块的 Paper 版本后替换为 {@code PlainTextComponentSerializer.plainText()}。
     */
    @SuppressWarnings("deprecation")
    private static final PlainComponentSerializer PLAIN_TEXT = PlainComponentSerializer.plain();

    private final KuroBotPlugin plugin;

    public ChatListener(KuroBotPlugin plugin) {
        this.plugin = plugin;
    }

    @EventHandler
    public void onAsyncChat(AsyncChatEvent event) {
        NodeIpc ipc = plugin.getIpc();
        if (ipc == null) {
            return; // 开发模式（未配置 KUROBOT_BUNDLE）：无 IPC，静默跳过
        }
        String text = PLAIN_TEXT.serialize(event.message());
        ipc.sendGameChat(event.getPlayer().getName(), text);
    }
}
