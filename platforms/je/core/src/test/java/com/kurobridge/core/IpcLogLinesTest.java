package com.kurobridge.core;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/** IpcLogLines 展示层剥前缀测试（ADR-038 对 ADR-034 的补充）：传输契约前缀整段剥掉、
 * 非契约前缀原样保留——Bukkit logger 自带 [KuroBridge] 前缀，透传即多层套娃。 */
class IpcLogLinesTest {

    @Test
    void stripsNodeContractPrefixes() {
        assertEquals("hello", IpcLogLines.strip("[KuroBridge][node][info] hello"));
        assertEquals("boom", IpcLogLines.strip("[KuroBridge][node][error] boom"));
        assertEquals("careful", IpcLogLines.strip("[KuroBridge][node][warn] careful"));
        assertEquals("detail", IpcLogLines.strip("[KuroBridge][node][debug] detail"));
    }

    @Test
    void stripsCoreContractPrefixes() {
        assertEquals("坏行已丢弃", IpcLogLines.strip("[NodeIpc][WARN] 坏行已丢弃"));
        assertEquals("启动看护", IpcLogLines.strip("[NodeSupervisor][INFO] 启动看护"));
        // 级别段是可选的（stub 工件无级别段，ADR-034 例外登记）
        assertEquals("QR 状态文件已更新", IpcLogLines.strip("[KuroBridge][stub] QR 状态文件已更新"));
    }

    @Test
    void keepsNonContractPrefixesVerbatim() {
        // [napuketto] 子系统前缀是信息，不是传输契约——原样保留
        assertEquals("[napuketto] stdin 已关闭", IpcLogLines.strip("[napuketto] stdin 已关闭"));
        assertEquals("普通无前缀日志行", IpcLogLines.strip("普通无前缀日志行"));
    }

    @Test
    void stripsOnlyOnceAndOnlyAtLineStart() {
        // 消息体内的第二处前缀是内容，不剥
        assertEquals(
                "中继 [KuroBridge][node][info] 原文",
                IpcLogLines.strip("[KuroBridge][node][info] 中继 [KuroBridge][node][info] 原文"));
        // 非行首契约串不剥
        assertEquals("ctx [NodeIpc][WARN] 不在行首", IpcLogLines.strip("ctx [NodeIpc][WARN] 不在行首"));
    }

    @Test
    void emptyAndNullLines() {
        assertEquals("", IpcLogLines.strip(""));
        assertEquals("", IpcLogLines.strip(null));
    }
}
