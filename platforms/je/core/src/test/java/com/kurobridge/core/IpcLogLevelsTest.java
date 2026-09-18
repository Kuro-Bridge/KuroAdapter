package com.kurobridge.core;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.logging.Level;
import org.junit.jupiter.api.Test;

/** IpcLogLevels 契约表测试（ADR-034）：行首整段前缀 → JUL 级别，其余保守 INFO 不丢行。 */
class IpcLogLevelsTest {

    @Test
    void kurobridgeNodePrefixesMapByContract() {
        assertEquals(Level.SEVERE, IpcLogLevels.parse("[KuroBridge][node][error] boom"));
        assertEquals(Level.WARNING, IpcLogLevels.parse("[KuroBridge][node][warn] careful"));
        assertEquals(Level.INFO, IpcLogLevels.parse("[KuroBridge][node][info] hello"));
        assertEquals(Level.FINE, IpcLogLevels.parse("[KuroBridge][node][debug] detail"));
    }

    @Test
    void corePrefixesMapWarnAndSevere() {
        assertEquals(Level.WARNING, IpcLogLevels.parse("[NodeIpc][WARN] 坏行已丢弃"));
        assertEquals(Level.WARNING, IpcLogLevels.parse("[NodeSupervisor][WARN] 重启退避"));
        assertEquals(Level.SEVERE, IpcLogLevels.parse("[NodeIpc][SEVERE] IPC 通道异常"));
        assertEquals(Level.SEVERE, IpcLogLevels.parse("[NodeSupervisor][SEVERE] 看护器放弃"));
        // INFO 级前缀未单列（保守缺省即 INFO），显式断言防契约表漂移
        assertEquals(Level.INFO, IpcLogLevels.parse("[NodeIpc][INFO] ready 已发送"));
        assertEquals(Level.INFO, IpcLogLevels.parse("[NodeSupervisor][INFO] 启动看护"));
    }

    @Test
    void unknownOrMissingPrefixFallsBackToInfo() {
        // [KuroBridge][stub]：开发期 KUROBRIDGE_STUB_PEER 工件，无 LEVEL 段（ADR-034 例外登记）
        assertEquals(Level.INFO, IpcLogLevels.parse("[KuroBridge][stub] QR 状态文件已更新"));
        assertEquals(Level.INFO, IpcLogLevels.parse("[whatever] 未知前缀"));
        assertEquals(Level.INFO, IpcLogLevels.parse("普通无前缀日志行"));
    }

    @Test
    void prefixMustBeWholeAtLineStart() {
        // 级别段须整段匹配：[errorX] 不是 [error]
        assertEquals(Level.INFO, IpcLogLevels.parse("[KuroBridge][node][errorX] 形近前缀"));
        // 消息体内出现的字样不误判（startsWith 而非 contains 的原因）
        assertEquals(Level.INFO, IpcLogLevels.parse("ctx [KuroBridge][node][error] 不在行首"));
        assertEquals(Level.INFO, IpcLogLevels.parse("tail [NodeIpc][WARN] 不在行首"));
    }

    @Test
    void emptyLineAndPrefixOnlyLine() {
        assertEquals(Level.INFO, IpcLogLevels.parse(""));
        // 纯前缀无消息仍按前缀分流（中继原样输出时消息体为空是合法形态）
        assertEquals(Level.SEVERE, IpcLogLevels.parse("[KuroBridge][node][error]"));
        assertEquals(Level.WARNING, IpcLogLevels.parse("[NodeIpc][WARN]"));
    }
}
