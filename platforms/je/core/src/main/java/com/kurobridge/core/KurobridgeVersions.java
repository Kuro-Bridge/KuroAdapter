package com.kurobridge.core;

/**
 * 协议元信息常量（Java 侧硬编码副本）。
 *
 * <p>SSOT 是姊妹仓 KuroProtocol 的 {@code src/meta.ts} 的 {@code PROTOCOL_VERSION}（npm 包
 * {@code @kuro-bridge/protocol}，本仓经 ^0.4.0 依赖消费，ADR-031/035）；Java 不参与 WS 握手，
 * 仅在就绪汇总行等展示场景需要版本号——本副本是 {@code check-versions} 协议族比对点。
 * 维护约束：改协议版本须同步本副本（check-versions 门禁 + 集成测试的
 * stub 握手断言兜底暴露漂移）。
 */
public final class KurobridgeVersions {
    public static final String PROTOCOL_VERSION = "0.4.0";

    private KurobridgeVersions() {}
}
