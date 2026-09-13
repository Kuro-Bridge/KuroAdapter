package com.kurobot.paper;

import com.kurobot.KuroBotPlugin;
import com.kurobot.core.NodeIpc;
import java.util.Arrays;
import java.util.List;
import net.kyori.adventure.text.Component;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;

/**
 * /kurobot 命令（仅原型——开发期手工触发 IPC 帧的调试入口，后续由正式管理命令替代）。
 *
 * <p>paper-plugin.yml 不支持 commands 声明，由主类经 {@code Bukkit.getCommandMap()} 直接
 * 注册。子命令：{@code kurobot send <文本...>} → 以发送者名义上报一条 game_chat 事件帧。
 * 权限：kurobot.admin（paper-plugin.yml 已声明，default: op）。
 */
public final class KurobotCommand extends Command {
    private final KuroBotPlugin plugin;

    public KurobotCommand(KuroBotPlugin plugin) {
        super("kurobot", "KuroBot 原型开发命令", "/kurobot send <文本...>", List.of());
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
            ipc.sendGameChat(sender.getName(), text);
            sender.sendMessage(Component.text("已发送"));
            return true;
        }
        sender.sendMessage(Component.text("用法：" + getUsage()));
        return true;
    }
}
