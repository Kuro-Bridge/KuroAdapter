package com.kurobridge.paper;

/**
 * 运行期版本探测器（ADR-038 universal 基线）：按「类是否存在」把 API 断层显式化。
 *
 * <ul>
 *   <li>{@code AsyncChatEvent}（io.papermc.paper.event.player）：Paper 1.19+ 的现代聊天事件；
 *       缺席（1.12.2 ~ 1.18.2）→ 注册 {@link LegacyChatListener}（AsyncPlayerChatEvent）。
 *       刻意不双注册：现代服上挂 legacy 监听会把整服聊天管线降级（Paper 有全局告警）。</li>
 *   <li>{@code Component}（net.kyori.adventure.text）：Paper 1.16.5 起捆绑 Adventure；
 *       缺席（1.12.2）→ 广播走 {@code Bukkit.broadcastMessage(String)}。</li>
 * </ul>
 *
 * <p>探测用 {@code Class.forName(name, false, ...)}（不初始化，零副作用），结果天然按
 * 服务器常驻类路径固定。
 */
public final class Compat {

    private static final boolean ASYNC_CHAT_EVENT_PRESENT = isPresent("io.papermc.paper.event.player.AsyncChatEvent");

    private static final boolean ADVENTURE_PRESENT = isPresent("net.kyori.adventure.text.Component");

    private Compat() {}

    public static boolean asyncChatEventPresent() {
        return ASYNC_CHAT_EVENT_PRESENT;
    }

    public static boolean adventurePresent() {
        return ADVENTURE_PRESENT;
    }

    private static boolean isPresent(String className) {
        try {
            Class.forName(className, false, Compat.class.getClassLoader());
            return true;
        } catch (ClassNotFoundException absent) {
            return false;
        }
    }
}
