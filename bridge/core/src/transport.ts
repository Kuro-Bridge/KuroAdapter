/**
 * 传输层接口（ADR-007：core 平台无关）
 *
 * core 只依赖这里的抽象；Node 具体实现（ws 库 / stdin/stdout）只出现在引导层
 * （bridge/embedded）。事件订阅语义：onXxx 可多次注册，实现方需回调全部 handler
 * （Relay 与引导层可能各自订阅同一事件，如 IPC onClose）。
 */

/** 日志接口（依赖注入，core 不绑定具体实现） */
export interface Logger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string, error?: unknown): void;
}

/** 单条 WS 连接（宿主实现）。send 抛错视为连接已死，由 onClose 收尾 */
export interface WsConnection {
    send(text: string): void;
    close(code: number, reason: string): void;
    onMessage(handler: (text: string) => void): void;
    onClose(handler: () => void): void;
}

/** WS 服务端（宿主实现；kurobridge 永远是 WS 服务端角色，ADR-005/架构书 §1） */
export interface WsServer {
    /** 开始监听，返回实际端口（宿主实现应用动态端口 listen(0)） */
    start(): Promise<number>;
    stop(): Promise<void>;
    onConnection(handler: (connection: WsConnection) => void): void;
}

/** IPC 通道（宿主实现：Java 薄壳 ↔ Node 的 stdin/stdout JSON-lines，ADR-010） */
export interface IpcChannel {
    /** 通道是否仍可用（断连降级观测用，候选 E；只读快照，不保证随后仍可用） */
    readonly isOpen: boolean;
    send(text: string): void;
    onMessage(handler: (text: string) => void): void;
    onClose(handler: () => void): void;
}
