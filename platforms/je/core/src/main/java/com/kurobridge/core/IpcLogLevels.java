package com.kurobridge.core;

import java.util.logging.Level;

/**
 * IPC / Node stderr 日志行 → JUL {@link Level} 的单一解析点（ADR-034 可观测性收敛）。
 *
 * <p>中继方（:paper 的 relayIpcLog / onStderrLine）一律经 {@link #parse(String)} 分流，
 * 不得各自猜前缀——历史上两处各自实现导致 Node error 行降级 INFO 的事故即由此而来。
 *
 * <p>契约表（ADR-034）：
 *
 * <ul>
 *   <li>{@code [KuroBridge][node][error] } → SEVERE；{@code [warn]} → WARNING；
 *       {@code [info]} → INFO（同保守缺省，显式登记在案）；{@code [debug]} → FINE</li>
 *   <li>{@code [NodeIpc][WARN]} / {@code [NodeSupervisor][WARN]} → WARNING；
 *       {@code [NodeIpc][SEVERE]} / {@code [NodeSupervisor][SEVERE]} → SEVERE</li>
 *   <li>其余（含 {@code [KuroBridge][stub]}（开发期工件，无 LEVEL 段）、未知前缀、无前缀）
 *       → INFO：保守默认，不丢行</li>
 * </ul>
 *
 * <p><b>前缀须整段匹配</b>：仅识别行首的完整前缀字样，消息体内出现 {@code [node][error]}
 * 之类的字样不得误判（用 startsWith 而非 contains 的原因）。
 */
public final class IpcLogLevels {

    private IpcLogLevels() {}

    /**
     * 解析一行 Node stderr / :core 日志到 JUL 级别。
     *
     * @param line 原始日志行（不判空：空行落入保守缺省 INFO）
     * @return 契约表对应的级别；未识别一律 INFO（不丢行）
     */
    public static Level parse(String line) {
        if (line.startsWith("[KuroBridge][node][error]")) {
            return Level.SEVERE;
        }
        if (line.startsWith("[KuroBridge][node][warn]")) {
            return Level.WARNING;
        }
        if (line.startsWith("[KuroBridge][node][debug]")) {
            return Level.FINE;
        }
        if (line.startsWith("[NodeIpc][WARN]") || line.startsWith("[NodeSupervisor][WARN]")) {
            return Level.WARNING;
        }
        if (line.startsWith("[NodeIpc][SEVERE]") || line.startsWith("[NodeSupervisor][SEVERE]")) {
            return Level.SEVERE;
        }
        // [KuroBridge][node][info] / [NodeIpc][INFO] / [NodeSupervisor][INFO] / [KuroBridge][stub]
        // / 未知前缀 / 无前缀 → 保守缺省 INFO（不丢行）
        return Level.INFO;
    }
}
