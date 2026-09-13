package com.kurobot.core;

/**
 * 协议元信息常量（Java 侧硬编码副本）。
 *
 * <p>SSOT 是 bridge/protocol 的 {@code PROTOCOL_VERSION}（zod 包）；Java 不参与 WS 握手，
 * 仅在就绪汇总行等展示场景需要版本号。维护约束：改协议版本须同步本副本（集成测试的
 * stub 握手断言兜底暴露漂移）。
 */
public final class KurobotVersions {
    public static final String PROTOCOL_VERSION = "0.3.0";

    private KurobotVersions() {}
}
