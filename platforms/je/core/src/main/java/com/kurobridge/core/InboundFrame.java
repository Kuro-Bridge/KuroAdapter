package com.kurobridge.core;

import java.util.List;

/**
 * Java 侧收帧（Node→Java 及 Java 请求的响应）的解析结果。
 *
 * <p>与 {@code @kuro-bridge/protocol}（npm 包，SSOT 在姊妹仓 KuroProtocol）
 * {@code ipcJavaInboundFrame} 的成员一一对应，另加 Java 主动请求
 * （broadcast / execute_command）的响应帧——双向请求复用同一帧格式。
 */
sealed interface InboundFrame {
    /**
     * ready 事件：Node 引导完成，WS 动态端口就绪。
     *
     * @param autoRestart 宿主自动重启开关（v0.2.1 可选字段；null = 未上报，按缺省 true 处理）
     */
    record Ready(int wsPort, Boolean autoRestart) implements InboundFrame {}

    /** broadcast / execute_command 请求（payload = message / command，非空）。 */
    record Request(String type, String id, String payload) implements InboundFrame {}

    /**
     * broadcast_result / execute_command_result 响应。
     *
     * @param error 失败原因；ok 为 true 时恒为 null（对齐 resultBodySchema）
     * @param output 命令输出行（v0.3.0，仅 execute_command_result 的 ok 分支解析；null = 帧未携带
     *     或 broadcast_result 不解析该字段）
     */
    record Result(String type, String id, boolean ok, String error, List<String> output) implements InboundFrame {}
}
