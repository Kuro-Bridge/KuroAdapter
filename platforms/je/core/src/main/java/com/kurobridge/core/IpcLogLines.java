package com.kurobridge.core;

import java.util.regex.Pattern;

/**
 * IPC / Node stderr 日志行的<b>展示层</b>清洗（ADR-038 对 ADR-034 的补充）：
 * 剥掉行首的传输契约前缀后再交宿主 logger——Bukkit logger 自行附加 {@code [KuroBridge]}
 * 插件前缀，级别由 JUL {@link java.util.logging.Level} 参数承载，前缀若原样透传会出现
 * 「[KuroBridge] [KuroBridge][node][info] …」式的多层套娃。
 *
 * <p><b>传输契约不变</b>：Node 侧 logger.ts 与 :core 的 {@code [NodeIpc][LEVEL]} 前缀照旧
 * 逐行携带（它们是 {@link IpcLogLevels} 级别解析的依据）；本类只在「中继到控制台」的
 * 最后一跳剥离，日志文件 / 其他消费方仍可拿到完整行。
 *
 * <p>识别的前缀（与 {@link IpcLogLevels} 契约表同源，行首整段匹配）：
 * {@code [KuroBridge][node][level]}、{@code [NodeIpc][LEVEL]}、
 * {@code [NodeSupervisor][LEVEL]}、{@code [KuroBridge][stub]}（开发期工件，无级别段）。
 * 未命中契约前缀的行（如 {@code [napuketto] …} 子系统前缀）原样返回——那是信息，不是冗余。
 */
public final class IpcLogLines {

    /**
     * 行首传输前缀：来源段（KuroBridge/NodeIpc/NodeSupervisor）+ 可选子系统段
     * （node/stub）+ 可选级别段（node 侧小写、:core 侧大写；stub 无级别段）。
     */
    private static final Pattern TRANSPORT_PREFIX = Pattern.compile(
            "^\\[(?:KuroBridge|NodeIpc|NodeSupervisor)\\](?:\\[(?:node|stub)\\])?(?:\\[(?:debug|info|warn|error|INFO|WARN|SEVERE)\\])?[ ]?");

    private IpcLogLines() {}

    /**
     * 剥掉行首的传输契约前缀（仅一处、仅行首）。
     *
     * @param line 原始日志行（null 安全：返回空串）
     * @return 剥离后的消息体；无契约前缀的行原样返回
     */
    public static String strip(String line) {
        if (line == null || line.isEmpty()) {
            return "";
        }
        return TRANSPORT_PREFIX.matcher(line).replaceFirst("");
    }
}
