/**
 * `ws` 库适配器：实现 bridge/core 的 WsServer / WsConnection 接口（决策 D-05）。
 *
 * - 监听参数化（MVP-3）：构造器收 { host, port }（缺省 = 动态端口 + 全部接口）；external
 *   形态的固定端口连入点由 bootstrap 从 config.ws 读出传入。core 的 `WsServer` 接口不感知
 *   监听参数：start() 返回实际端口的契约不变。
 * - 绑定失败语义（MVP-3）：EADDRINUSE 不在构造时抛（实测 Node 26 + ws 8.x：构造时同步发起
 *   listen，失败经底层 http server 以 error 事件异步转发）→ start() 以先挂的一次性 error
 *   监听收口，reject `WsBindError`（含 host/port 与原因），宿主打日志后非零退出；重启收敛
 *   于 Java 看护器退避（DEBT-2 语义），不新增重试机制。
 * - 子协议：握手期校验 `kurobot-ws.v1`（ADR-003 大版本），不匹配直接拒绝连接。
 */
import type { Logger, WsConnection, WsServer } from "@kurobot/bridge-core";
import { WS_SUBPROTOCOL } from "@kurobot/protocol";
import { type WebSocket, WebSocketServer } from "ws";

/** WS 监听参数（MVP-3）。成员显式允许 undefined（exactOptionalPropertyTypes 下 bootstrap 可直接透传 config.ws 的可选字段）。 */
export interface NodeWsServerOptions {
    /** 绑定地址（如 127.0.0.1 只听本机）；缺省/undefined = 全部接口 */
    readonly host?: string | undefined;
    /** 监听端口（1-65535）；缺省/undefined = 动态端口（listen(0)） */
    readonly port?: number | undefined;
    /** listening 之后 error 事件的日志出口（防未处理 error 炸进程）；缺省静默 */
    readonly logger?: Logger | undefined;
}

/** WS 端口绑定失败（含异步 EADDRINUSE）：message 含 host/port 与原因，宿主据此打日志后退出 */
export class WsBindError extends Error {
    constructor(host: string | undefined, port: number, reason: string) {
        const where = host === undefined ? `port=${port}` : `host=${host}, port=${port}`;
        super(`WS 服务端绑定失败（${where}）：${reason}`);
        this.name = "WsBindError";
    }
}

export class NodeWsServer implements WsServer {
    private server: WebSocketServer | null = null;
    private connectionHandler: ((connection: WsConnection) => void) | null = null;
    private readonly host: string | undefined;
    private readonly port: number;
    private readonly logger: Logger | undefined;

    constructor(options: NodeWsServerOptions = {}) {
        this.host = options.host;
        this.port = options.port ?? 0;
        this.logger = options.logger;
    }

    async start(): Promise<number> {
        // host 条件展开：ws 库的 options.host 为可选 string，避免字面量显式 undefined（EOPT）
        const listenOptions: { port: number; host?: string } = { port: this.port };
        if (this.host !== undefined) {
            listenOptions.host = this.host;
        }
        const server = new WebSocketServer({
            ...listenOptions,
            handleProtocols: (protocols) => {
                return protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false;
            },
        });
        server.on("connection", (ws) => {
            this.connectionHandler?.(new NodeWsConnection(ws));
        });
        return await new Promise<number>((resolve, reject) => {
            // 失败判据先挂：EADDRINUSE 等绑定错误异步到达（一次性，二选一后移除）
            const onBindFailure = (error: Error): void => {
                server.removeListener("listening", onBindSuccess);
                // 不登记 this.server：绑定失败的实例无监听句柄，stop() 维持 no-op
                reject(new WsBindError(this.host, this.port, error.message));
            };
            const onBindSuccess = (): void => {
                server.removeListener("error", onBindFailure);
                // listening 后的 error（非绑定失败）只记日志，防未处理事件炸进程
                server.on("error", (error) => {
                    this.logger?.error(`WS 服务端运行期错误：${error.message}`);
                });
                this.server = server;
                resolve(this.resolvePort(server));
            };
            server.once("error", onBindFailure);
            server.once("listening", onBindSuccess);
        });
    }

    async stop(): Promise<void> {
        const server = this.server;
        if (server === null) {
            return;
        }
        this.server = null;
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error === undefined) {
                    resolve();
                } else {
                    reject(error);
                }
            });
        });
    }

    onConnection(handler: (connection: WsConnection) => void): void {
        this.connectionHandler = handler;
    }

    private resolvePort(server: WebSocketServer): number {
        const address = server.address();
        if (typeof address === "object" && address !== null) {
            return address.port;
        }
        throw new Error(`WS 服务端地址异常：${String(address)}`);
    }
}

class NodeWsConnection implements WsConnection {
    private readonly ws: WebSocket;

    constructor(ws: WebSocket) {
        this.ws = ws;
    }

    send(text: string): void {
        this.ws.send(text);
    }

    close(code: number, reason: string): void {
        this.ws.close(code, reason);
    }

    onMessage(handler: (text: string) => void): void {
        this.ws.on("message", (data) => {
            handler(data.toString());
        });
    }

    onClose(handler: () => void): void {
        this.ws.on("close", () => {
            handler();
        });
    }
}
