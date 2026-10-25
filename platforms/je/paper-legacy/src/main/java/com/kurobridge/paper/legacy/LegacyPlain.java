package com.kurobridge.paper.legacy;

import net.kyori.adventure.text.Component;

// 注意：PlainComponentSerializer 用全限定名引用——import 行的弃用警告不受
// 类级 @SuppressWarnings 覆盖，会触发 -Werror（本模块存在的目的就是用它，见类注释）。

/**
 * 旧 Adventure（4.x pre-4.15，Paper 1.19 ~ 1.21.x 捆绑）的 Component → 纯文本序列化器。
 *
 * <p>本类存在的唯一原因是版本隔离（ADR-038）：{@link PlainComponentSerializer} 自 adventure
 * 4.15 弃用、5.x（Paper 26.x）删除，对现行 paper-api 无法编译，故独立成模块对 1.21.4 时代的
 * API 编译。运行期只允许经 :paper 的 {@code PlainText} 兼容链在现代序列化器不可用时触碰——
 * 在 adventure 5.x 服务器上加载本类会抛 {@code NoClassDefFoundError}，由调用方捕获。
 *
 * <p>零 Bukkit API、零业务：纯函数工具类。
 */
@SuppressWarnings("deprecation") // 刻意使用被 1.21.4 API 弃用的旧序列化器（见类注释）
public final class LegacyPlain {

    private static final net.kyori.adventure.text.serializer.plain.PlainComponentSerializer SERIALIZER =
            net.kyori.adventure.text.serializer.plain.PlainComponentSerializer.plain();

    private LegacyPlain() {}

    public static String serialize(Component component) {
        return SERIALIZER.serialize(component);
    }
}
