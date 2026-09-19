package com.kurobridge.fabric;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.kurobridge.core.NodeIpc;
import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.StringArgumentType;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.text.Text;

/**
 * /kurobridge 命令（开发/验收期的 IPC 手工触发入口），Brigadier 注册
 * （CommandRegistrationCallback，docs/design.md §5）。
 *
 * <p>子命令与 :paper 的 KurobridgeCommand 一致：
 * <ul>
 *   <li>{@code kurobridge send <文本...>} → 以发送者名义上报一条 game_chat 事件帧。</li>
 *   <li>{@code kurobridge reload} → 上报 config_reload 事件帧（重载效果经 bindings_updated
 *       推送路径生效；命令即时返回「已通知重载」）。</li>
 *   <li>{@code kurobridge qr} → 读取 Node 落地的 QR 状态文件 {@code plugins/kurobridge/qr.json}
 *       展示（零 IPC 零业务——纯文件只读展示）。</li>
 * </ul>
 *
 * <p>权限：{@code hasPermissionLevel(2)}（≈ op）——paper 用权限节点 kurobridge.admin
 * （default: op），fabric 原生无权限节点系统的近似等价（docs/design.md §5，接管计划同 relay 门）。
 */
public final class KurobridgeCommand {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final DateTimeFormatter TIME_FORMAT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").withZone(ZoneId.systemDefault());

    private KurobridgeCommand() {}

    public static void register(CommandDispatcher<ServerCommandSource> dispatcher, KuroBridgeMod mod) {
        dispatcher.register(CommandManager.literal("kurobridge")
                .requires(source -> source.hasPermissionLevel(2))
                .then(CommandManager.literal("send")
                        .then(CommandManager.argument("text", StringArgumentType.greedyString())
                                .executes(context ->
                                        send(mod, context.getSource(), StringArgumentType.getString(context, "text")))))
                .then(CommandManager.literal("reload").executes(context -> reload(mod, context.getSource())))
                .then(CommandManager.literal("qr").executes(context -> qr(context.getSource()))));
    }

    private static int send(KuroBridgeMod mod, ServerCommandSource source, String text) {
        NodeIpc ipc = mod.getIpc();
        if (ipc == null) {
            source.sendFeedback(() -> Text.literal("Node IPC 未就绪"), false);
            return 0;
        }
        if (ipc.sendGameChat(source.getName(), text)) {
            source.sendFeedback(() -> Text.literal("已发送"), false);
        } else if (mod.isSupervisorGivenUp()) {
            source.sendError(Text.literal("发送失败：Node 进程反复崩溃，自动重启已放弃（需修复后重启服务器）"));
        } else {
            source.sendError(Text.literal("发送失败：Node IPC 通道不可用，消息已丢弃"));
        }
        return 1;
    }

    private static int reload(KuroBridgeMod mod, ServerCommandSource source) {
        NodeIpc ipc = mod.getIpc();
        if (ipc == null) {
            source.sendFeedback(() -> Text.literal("Node IPC 未就绪"), false);
            return 0;
        }
        if (ipc.sendConfigReload()) {
            source.sendFeedback(() -> Text.literal("已通知重载"), false);
        } else if (mod.isSupervisorGivenUp()) {
            source.sendError(Text.literal("重载失败：Node 进程反复崩溃，自动重启已放弃（需修复后重启服务器）"));
        } else {
            source.sendError(Text.literal("重载失败：Node IPC 通道不可用"));
        }
        return 1;
    }

    /** /kurobridge qr：只读展示 QR 状态文件；无 IPC 依赖，node 未起也可查（paper 同语义）。 */
    private static int qr(ServerCommandSource source) {
        Path qrJson =
                Path.of("plugins", "kurobridge", "qr.json").toAbsolutePath().normalize();
        if (!Files.isRegularFile(qrJson)) {
            source.sendFeedback(
                    () -> Text.literal("尚无 QR 状态：napuketto 未启用（config 的 embedded.napuketto.enabled），或还未进入扫码阶段"), false);
            return 0;
        }
        JsonNode state;
        try {
            state = MAPPER.readTree(Files.readAllBytes(qrJson));
        } catch (IOException e) {
            source.sendError(Text.literal("QR 状态文件读取失败（可能正在写入，稍后重试）：" + e.getMessage()));
            return 0;
        }
        long detectedAt = state.path("detectedAt").asLong(0);
        String age = detectedAt > 0 ? "，距今 " + humanAge(detectedAt) : "";
        source.sendFeedback(
                () -> Text.literal(
                        "QQ 登录二维码状态（检测时间 " + TIME_FORMAT.format(Instant.ofEpochMilli(detectedAt)) + age + "）："),
                false);
        String pngPath = state.path("pngPath").asText("");
        if (!pngPath.isEmpty()) {
            source.sendFeedback(() -> Text.literal("  二维码图片（手机 QQ 扫描）：" + pngPath), false);
        } else {
            source.sendFeedback(() -> Text.literal("  二维码图片尚未生成，请稍后再次运行 /kurobridge qr"), false);
        }
        String url = state.path("url").asText("");
        if (!url.isEmpty()) {
            source.sendFeedback(() -> Text.literal("  登录链接（手机 QQ 打开）：" + url), false);
        }
        source.sendFeedback(() -> Text.literal("二维码过期会自动刷新；登录成功后本命令显示的内容即为最后一次扫码状态"), false);
        return 1;
    }

    /** 检测时间的相对年龄（N 秒/分钟/小时前）：二维码 120s 过期，过没过期要一眼可见。 */
    private static String humanAge(long epochMilli) {
        long seconds = Math.max(
                0L, Duration.ofMillis(System.currentTimeMillis() - epochMilli).toSeconds());
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
