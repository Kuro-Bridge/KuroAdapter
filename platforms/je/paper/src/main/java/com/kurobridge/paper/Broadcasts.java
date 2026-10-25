package com.kurobridge.paper;

import org.bukkit.Bukkit;

/**
 * 广播的跨版本分发（ADR-038 universal 基线）：Adventure 可用（Paper 1.16.5+）走
 * {@code Bukkit.broadcast(Component)}，否则（1.12.2）回退 {@code Bukkit.broadcastMessage(String)}。
 *
 * <p>Component 调用点隔离在 {@link ComponentPath}——无 Adventure 的服务器永不加载该类，
 * 广播主路径（本类）零 Adventure 引用。
 */
final class Broadcasts {

    private Broadcasts() {}

    @SuppressWarnings("deprecation") // broadcastMessage：1.12.2（无 Adventure）回退路径，26.3 仍存留
    static void broadcast(String message) {
        if (Compat.adventurePresent()) {
            ComponentPath.broadcast(message);
            return;
        }
        Bukkit.broadcastMessage(message);
    }

    /** Adventure 广播路径：独立类，静态初始化只烧自己。 */
    private static final class ComponentPath {
        private static void broadcast(String message) {
            Bukkit.broadcast(net.kyori.adventure.text.Component.text(message));
        }
    }
}
