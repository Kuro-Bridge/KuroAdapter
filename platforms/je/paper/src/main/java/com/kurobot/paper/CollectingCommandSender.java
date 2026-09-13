package com.kurobot.paper;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import net.kyori.adventure.audience.MessageType;
import net.kyori.adventure.identity.Identity;
import net.kyori.adventure.text.Component;
import org.bukkit.Bukkit;
import org.bukkit.Server;
import org.bukkit.command.CommandSender;
import org.bukkit.permissions.Permission;
import org.bukkit.permissions.PermissionAttachment;
import org.bukkit.permissions.PermissionAttachmentInfo;
import org.bukkit.plugin.Plugin;

/**
 * 收集型 CommandSender（v0.3.0）：execute_command 的执行者——把命令的全部回显文本行收进
 * 缓冲，执行完经 {@link #collectedLines()} 回传 execute_command_result 的 output。
 *
 * <p><b>控制台语义</b>（与原直接使用 Bukkit.getConsoleSender() 等价）：权限判定恒 true
 * （临时瞬态对象，生命周期 = 单次命令执行，无插件会对其挂权限附件——addAttachment 一律
 * 拒绝）；isOp 恒 true；所有消息只进本地缓冲，不落服务端控制台。
 *
 * <p>线程契约：仅在 Bukkit 主线程使用（dispatchCommand 与 collectedLines 都在主线程任务内）。
 * adventure 4.20 的 Audience 各 sendMessage(Component) 变体最终都汇入
 * {@code sendMessage(Identity, Component, MessageType)}（默认实现为 no-op），故除该汇聚点外
 * 仅需再拦截 Bukkit 侧的 String 变体即可覆盖全部回显。
 */
public final class CollectingCommandSender implements CommandSender {
    private final List<String> lines = new ArrayList<>();

    /** 已收集的输出行（快照；空输出 → 空列表，IpcResult.ok 对空列表不产生 output 字段）。 */
    public List<String> collectedLines() {
        return List.copyOf(lines);
    }

    // ---- 消息收集（Bukkit String 变体 + adventure 汇聚点）----

    @Override
    public void sendMessage(String message) {
        lines.add(message);
    }

    @Override
    public void sendMessage(String... messages) {
        for (String message : messages) {
            lines.add(message);
        }
    }

    @SuppressWarnings("deprecation") // Bukkit 的 UUID 变体已弃用但仍为 CommandSender 抽象方法
    @Override
    public void sendMessage(UUID sender, String message) {
        lines.add(message);
    }

    @SuppressWarnings("deprecation") // 同上
    @Override
    public void sendMessage(UUID sender, String... messages) {
        for (String message : messages) {
            lines.add(message);
        }
    }

    @Override
    public void sendMessage(Component message) {
        lines.add(PlainText.serialize(message));
    }

    @SuppressWarnings("deprecation") // MessageType 自 adventure 4.15 起弃用，但仍是 Audience 汇聚点签名
    @Override
    public void sendMessage(Identity sourceIdentity, Component message, MessageType type) {
        lines.add(PlainText.serialize(message));
    }

    // ---- 控制台语义：权限恒 true ----

    @Override
    public boolean isPermissionSet(String name) {
        return false; // 无显式设置项；hasPermission 恒 true 兜底
    }

    @Override
    public boolean isPermissionSet(Permission perm) {
        return false;
    }

    @Override
    public boolean hasPermission(String name) {
        return true;
    }

    @Override
    public boolean hasPermission(Permission perm) {
        return true;
    }

    @Override
    public boolean isOp() {
        return true;
    }

    @Override
    public void setOp(boolean value) {
        // 瞬态对象：op 状态恒 true，忽略设置
    }

    // ---- 权限附件：瞬态对象不支持 ----

    @Override
    public PermissionAttachment addAttachment(Plugin plugin, String name, boolean value) {
        throw new UnsupportedOperationException("收集型 CommandSender 不支持权限附件");
    }

    @Override
    public PermissionAttachment addAttachment(Plugin plugin, String name, boolean value, int ticks) {
        throw new UnsupportedOperationException("收集型 CommandSender 不支持权限附件");
    }

    @Override
    public PermissionAttachment addAttachment(Plugin plugin) {
        throw new UnsupportedOperationException("收集型 CommandSender 不支持权限附件");
    }

    @Override
    public PermissionAttachment addAttachment(Plugin plugin, int ticks) {
        throw new UnsupportedOperationException("收集型 CommandSender 不支持权限附件");
    }

    @Override
    public void removeAttachment(PermissionAttachment attachment) {
        // 无附件可移除：no-op
    }

    @Override
    public void recalculatePermissions() {
        // 恒 true 语义，无需重算
    }

    @Override
    public Set<PermissionAttachmentInfo> getEffectivePermissions() {
        return Set.of();
    }

    // ---- 身份 ----

    @Override
    public String getName() {
        // 控制台语义：与 Bukkit.getConsoleSender().getName() 一致，命令回显中的对象名不变
        return "Console";
    }

    @Override
    public Component name() {
        return Component.text(getName());
    }

    @Override
    public Server getServer() {
        return Bukkit.getServer();
    }

    @Override
    public Spigot spigot() {
        return new Spigot();
    }
}
