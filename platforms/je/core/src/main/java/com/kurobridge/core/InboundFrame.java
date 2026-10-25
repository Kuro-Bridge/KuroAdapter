package com.kurobridge.core;

import java.util.List;

/**
 * Java 侧收帧（Node→Java 及 Java 请求的响应）的解析结果。
 *
 * <p>与 {@code @kuro-bridge/protocol}（npm 包，SSOT 在姊妹仓 KuroProtocol）
 * {@code ipcJavaInboundFrame} 的成员一一对应，另加 Java 主动请求
 * （broadcast / execute_command）的响应帧——双向请求复用同一帧格式。
 *
 * <p>访问器名沿用 record 组件名（{@code wsPort()} / {@code payload()} 等），
 * Java 8 基线（ADR-038 universal 兼容）下以普通不可变类承载，调用点零改动。
 */
interface InboundFrame {

    /** ready 事件：Node 引导完成，WS 动态端口就绪。 */
    final class Ready implements InboundFrame {
        private final int wsPort;
        /** 宿主自动重启开关（v0.2.1 可选字段；null = 未上报，按缺省 true 处理）。 */
        private final Boolean autoRestart;

        Ready(int wsPort, Boolean autoRestart) {
            this.wsPort = wsPort;
            this.autoRestart = autoRestart;
        }

        public int wsPort() {
            return wsPort;
        }

        public Boolean autoRestart() {
            return autoRestart;
        }
    }

    /** broadcast / execute_command 请求（payload = message / command，非空）。 */
    final class Request implements InboundFrame {
        private final String type;
        private final String id;
        private final String payload;

        Request(String type, String id, String payload) {
            this.type = type;
            this.id = id;
            this.payload = payload;
        }

        public String type() {
            return type;
        }

        public String id() {
            return id;
        }

        public String payload() {
            return payload;
        }
    }

    /**
     * broadcast_result / execute_command_result 响应。
     *
     * <p>{@code error} 失败原因；ok 为 true 时恒为 null（对齐 resultBodySchema）。
     * {@code output} 命令输出行（v0.3.0，仅 execute_command_result 的 ok 分支解析；null = 帧未携带
     * 或 broadcast_result 不解析该字段）。
     */
    final class Result implements InboundFrame {
        private final String type;
        private final String id;
        private final boolean ok;
        private final String error;
        private final List<String> output;

        Result(String type, String id, boolean ok, String error, List<String> output) {
            this.type = type;
            this.id = id;
            this.ok = ok;
            this.error = error;
            this.output = output;
        }

        public String type() {
            return type;
        }

        public String id() {
            return id;
        }

        public boolean ok() {
            return ok;
        }

        public String error() {
            return error;
        }

        public List<String> output() {
            return output;
        }
    }
}
