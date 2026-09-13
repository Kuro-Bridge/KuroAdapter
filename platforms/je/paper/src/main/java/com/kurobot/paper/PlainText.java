package com.kurobot.paper;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.serializer.plain.PlainComponentSerializer;

/** Component → 纯文本的 plain 序列化器（聊天 / 死亡消息 / 命令输出收集共用）。 */
final class PlainText {

    /**
     * paper-api 1.21.4 只暴露 adventure-text-serializer-plain（该类自 adventure 4.15 起被标记
     * {@code @Deprecated}）；PlainTextComponentSerializer 所在的 plaintext 模块既不在 paper-api
     * 依赖中、也不随 Paper 服务端分发（见 PaperMC/Paper 的 paper-api/build.gradle.kts），引入它会
     * 在运行时抛 {@code NoClassDefFoundError}。故此处局部压制 deprecation 使用 plain 序列化器，
     * 升级到暴露 plaintext 模块的 Paper 版本后替换为 {@code PlainTextComponentSerializer.plainText()}。
     */
    @SuppressWarnings("deprecation")
    static final PlainComponentSerializer SERIALIZER = PlainComponentSerializer.plain();

    private PlainText() {}

    static String serialize(Component component) {
        return SERIALIZER.serialize(component);
    }
}
