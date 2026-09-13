package com.kurobot.paper;

import com.kurobot.KuroBotPlugin;
import com.kurobot.core.NodeIpc;
import java.util.Arrays;
import java.util.List;
import net.kyori.adventure.text.Component;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;

/**
 * /kurobot 命令（开发/验收期的 IPC 手工触发入口）。
 *
 * <p>paper-plugin.yml 不支持 commands 声明，由主类经 {@code Bukkit.getCommandMap()} 直接
 * 注册。子命令：
 * <ul>
 *   <li>{@code kurobot send <文本...>} → 以发送者名义上报一条 game_chat 事件帧。</li>
 *   <li>{@code kurobot reload}（v0.3.0）→ 上报 config_reload 事件帧，Node 侧重读配置
 *       （绑定变更经既有 bindings_updated 推送路径生效；命令即时返回「已通知重载」）。</li>
 * </ul>
 * 权限：kurobot.admin（paper-plugin.yml 已声明，default: op）。
 */
public final class KurobotCommand extends Command {
    private final KuroBotPlugin plugin;

    public KurobotCommand(KuroBotPlugin plugin) {
        super("kurobot", "KuroBot 开发命令", "/kurobot send <文本...> | reload", List.of());
        this.plugin = plugin;
    }

    @Override
    public boolean execute(CommandSender sender, String commandLabel, String[] args) {
        if (!sender.hasPermission("kurobot.admin")) {
            sender.sendMessage(Component.text("缺少 kurobot.admin 权限"));
            return true;
        }
        if (args.length >= 2 && "send".equals(args[0])) {
            NodeIpc ipc = plugin.getIpc();
            if (ipc == null) {
                sender.sendMessage(Component.text("Node IPC 未就绪"));
                return true;
            }
            String text = String.join(" ", Arrays.copyOfRange(args, 1, args.length));
            if (ipc.sendGameChat(sender.getName(), text)) {
                sender.sendMessage(Component.text("已发送"));
            } else if (plugin.isSupervisorGivenUp()) {
                sender.sendMessage(Component.text("发送失败：Node 进程反复崩溃，自动重启已放弃（需修复后重启服务器或重载插件）"));
            } else {
                sender.sendMessage(Component.text("发送失败：Node IPC 通道不可用，消息已丢弃"));
            }
            return true;
        }
        if (args.length == 1 && "reload".equals(args[0])) {
            NodeIpc ipc = plugin.getIpc();
            if (ipc == null) {
                sender.sendMessage(Component.text("Node IPC 未就绪"));
                return true;
            }
            if (ipc.sendConfigReload()) {
                sender.sendMessage(Component.text("已通知重载"));
            } else if (plugin.isSupervisorGivenUp()) {
                sender.sendMessage(Component.text("重载失败：Node 进程反复崩溃，自动重启已放弃（需修复后重启服务器或重载插件）"));
            } else {
                sender.sendMessage(Component.text("重载失败：Node IPC 通道不可用"));
            }
            return true;
        }
        sender.sendMessage(Component.text("用法：" + getUsage()));
        return true;
    }
}
