package com.kurobridge.paper;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.kurobridge.KuroBridgePlugin;
import com.kurobridge.core.NodeIpc;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Arrays;
import org.bukkit.command.CommandSender;

/**
 * /kurobridge 子命令分派（plugin.yml 声明命令，主类 onCommand 委派到这里；ADR-038 universal
 * 化：消息回执全 String——sendMessage(String) 全版本存留，Component 版 1.12.2 无）。
 *
 * <p>子命令：
 * <ul>
 *   <li>{@code kurobridge send <文本...>} → 以发送者名义上报一条 game_chat 事件帧。</li>
 *   <li>{@code kurobridge reload}（v0.3.0）→ 上报 config_reload 事件帧，Node 侧重读配置
 *       （绑定变更经既有 bindings_updated 推送路径生效；命令即时返回「已通知重载」）。</li>
 *   <li>{@code kurobridge qr}（MVP-4）→ 读取 Node 落地的 QR 状态文件
 *       {@code plugins/kurobridge/qr.json}（node.pid 式运维文件先例），展示二维码图片路径、
 *       登录链接（可得时）与检测时间。零 IPC 零业务——纯文件只读展示。</li>
 * </ul>
 * 权限：kurobridge.admin（plugin.yml 已声明，default: op）。
 */
public final class KurobridgeCommand {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final DateTimeFormatter TIME_FORMAT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").withZone(ZoneId.systemDefault());

    private final KuroBridgePlugin plugin;

    public KurobridgeCommand(KuroBridgePlugin plugin) {
        this.plugin = plugin;
    }

    /** 主类 onCommand 的委派入口；返回值语义同 Bukkit（权限已由主类校验）。 */
    public boolean execute(CommandSender sender, String[] args) {
        if (args.length >= 2 && "send".equals(args[0])) {
            NodeIpc ipc = plugin.getIpc();
            if (ipc == null) {
                sender.sendMessage("Node IPC 未就绪");
                return true;
            }
            String text = String.join(" ", Arrays.copyOfRange(args, 1, args.length));
            if (ipc.sendGameChat(sender.getName(), text)) {
                sender.sendMessage("已发送");
            } else if (plugin.isSupervisorGivenUp()) {
                sender.sendMessage("发送失败：Node 进程反复崩溃，自动重启已放弃（需修复后重启服务器或重载插件）");
            } else {
                sender.sendMessage("发送失败：Node IPC 通道不可用，消息已丢弃");
            }
            return true;
        }
        if (args.length == 1 && "reload".equals(args[0])) {
            NodeIpc ipc = plugin.getIpc();
            if (ipc == null) {
                sender.sendMessage("Node IPC 未就绪");
                return true;
            }
            if (ipc.sendConfigReload()) {
                sender.sendMessage("已通知重载");
            } else if (plugin.isSupervisorGivenUp()) {
                sender.sendMessage("重载失败：Node 进程反复崩溃，自动重启已放弃（需修复后重启服务器或重载插件）");
            } else {
                sender.sendMessage("重载失败：Node IPC 通道不可用");
            }
            return true;
        }
        if (args.length == 1 && "qr".equals(args[0])) {
            handleQr(sender);
            return true;
        }
        sender.sendMessage("用法：/kurobridge send <文本...> | reload | qr");
        return true;
    }

    /** /kurobridge qr（MVP-4，ADR-029）：只读展示 QR 状态文件；无 IPC 依赖，node 未起也可查。 */
    private void handleQr(CommandSender sender) {
        Path qrJson =
                Paths.get("plugins", "kurobridge", "qr.json").toAbsolutePath().normalize();
        if (!Files.isRegularFile(qrJson)) {
            sender.sendMessage("尚无 QR 状态：napuketto 未启用（config 的 embedded.napuketto.enabled），或还未进入扫码阶段");
            return;
        }
        JsonNode state;
        try {
            state = MAPPER.readTree(Files.readAllBytes(qrJson));
        } catch (IOException e) {
            sender.sendMessage("QR 状态文件读取失败（可能正在写入，稍后重试）：" + e.getMessage());
            return;
        }
        long detectedAt = state.path("detectedAt").asLong(0);
        String age = detectedAt > 0 ? "，距今 " + humanAge(detectedAt) : "";
        sender.sendMessage("QQ 登录二维码状态（检测时间 " + TIME_FORMAT.format(Instant.ofEpochMilli(detectedAt)) + age + "）：");
        String pngPath = state.path("pngPath").asText("");
        if (!pngPath.isEmpty()) {
            sender.sendMessage("  二维码图片（手机 QQ 扫描）：" + pngPath);
        } else {
            sender.sendMessage("  二维码图片尚未生成，请稍后再次运行 /kurobridge qr");
        }
        String url = state.path("url").asText("");
        if (!url.isEmpty()) {
            sender.sendMessage("  登录链接（手机 QQ 打开）：" + url);
        }
        sender.sendMessage("二维码过期会自动刷新；登录成功后本命令显示的内容即为最后一次扫码状态");
    }

    /** 检测时间的相对年龄（N 秒/分钟/小时前）：二维码 120s 过期，过没过期要一眼可见 */
    private static String humanAge(long epochMilli) {
        // 不用 Duration.toSeconds()（Java 9+）：Java 8 基线（ADR-038）下手动换算
        long seconds = Math.max(0L, (System.currentTimeMillis() - epochMilli) / 1000L);
        if (seconds < 90L) {
            return seconds + " 秒前";
        }
        long minutes = seconds / 60L;
        if (minutes < 90L) {
            return minutes + " 分钟前";
        }
        return minutes / 60L + " 小时前";
    }
}
