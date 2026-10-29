package com.kurobridge.paper;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;

/**
 * Component → 纯文本序列化（ADR-038 universal 基线；ADR-043 收敛为单路径）。
 *
 * <p>{@code PlainTextComponentSerializer} 所在的 {@code adventure-text-serializer-plain}
 * 自 adventure 4.8.0（2021-05）引入并存活至 5.x，覆盖矩阵内全部捆绑 Adventure 的 Paper
 * （1.16.5 起捆绑；1.19 ~ 1.20.5 为 4.9~4.14；1.21.x 为 4.x 末段；26.x 为 5.2）——
 * 无需版本兼容链。
 *
 * <p>历史：ADR-038 曾设 {@code :paper-legacy} 模块隔离旧 {@code PlainComponentSerializer}
 * 作回退；ADR-043 裁决撤销——回退分支在支持矩阵上无可触发版本（4.8.0 即有现代序列化器，
 * 4.15 仅是旧序列化器弃用点），属死代码。无 Adventure / 无 AsyncChatEvent 的旧档由
 * {@link Compat} 探测分流到 String 路径，不会触碰本类。
 */
final class PlainText {

    private PlainText() {}

    static String serialize(Component component) {
        return PlainTextComponentSerializer.plainText().serialize(component);
    }
}
