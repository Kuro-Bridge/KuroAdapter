/**
 * 游戏通道 WS 服务端（127.0.0.1:gamePort）：QuickJS 壳接入点，鉴权后包装成 core 的
 * IpcChannel 交引导层注入 Relay（裁决册 §4.1/4.2）。
 *
 * - 单租户：已有通道时新连接直接 close（壳看护器每轮全新 spawn，本进程生命周期内
 *   只服务一个通道；通道随脐带语义断开即关机）。
 * - 鉴权：首帧必须等于令牌原文（明文，非 JSON），不匹配 close(1008, "unauthorized")；
 *  限时未交令牌也关闭（防僵尸连接长期占位）。
 * - 脐带语义（D-08）：仅已鉴权连接断开 → IpcChannel onClose + onChannelLost → 引导层
 *   关机（等价 embedded 的 stdin EOF 自杀）；未鉴权连接的断开（端口扫描/令牌不匹配/
 *   鉴权超时）只清租户槽位，绝不触发脐带。
 */
import { setTimeout } from "node:timers";
import type { IpcChannel, Logger } from "@kuro-bridge/bridge-core";
import { type WebSocket, WebSocketServer } from "ws";

export interface GameGateOptions {
    /** 游戏通道监听端口（壳每轮尝试随机下发，裁决册 §4.2） */
    readonly port: number;
    /** 会话令牌原文（首帧全等比对） */
    readonly token: string;
    readonly logger: Logger;
    /** 鉴权时限毫秒（缺省 10s；测试注入短时限以确定性覆盖超时路径） */
    readonly authTimeoutMs?: number | undefined;
}

/** 鉴权时限缺省：壳 connectAsync 成功后立即发令牌，超时视为对端异常 */
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;

export class GameGate {
    private server: WebSocketServer | null = null;
    private current: WebSocket | null = null;
    private channelHandler: ((ipc: IpcChannel) => void) | null = null;
    private lostHandler: (() => void) | null = null;
    private closing = false;
    private readonly port: number;
    private readonly token: string;
    private readonly logger: Logger;
    private readonly authTimeoutMs: number;

    constructor(options: GameGateOptions) {
        this.port = options.port;
        this.token = options.token;
        this.logger = options.logger;
        this.authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    }

    onChannel(handler: (ipc: IpcChannel) => void): void {
        this.channelHandler = handler;
    }

    /** 已鉴权通道断开（脐带断）的关机通知点 */
    onChannelLost(handler: () => void): void {
        this.lostHandler = handler;
    }

    async start(): Promise<void> {
        const server = new WebSocketServer({ host: "127.0.0.1", port: this.port });
        server.on("connection", (ws) => {
            this.accept(ws);
        });
        return await new Promise<void>((resolve, reject) => {
            // 失败判据先挂：端口被占等绑定错误异步到达（对齐 NodeWsServer 语义）
            const onBindFailure = (error: Error): void => {
                server.removeListener("listening", onBindSuccess);
                reject(error);
            };
            const onBindSuccess = (): void => {
                server.removeListener("error", onBindFailure);
                server.on("error", (error) => {
                    this.logger.error(`游戏通道运行期错误：${error.message}`);
                });
                this.server = server;
                resolve();
            };
            server.once("error", onBindFailure);
            server.once("listening", onBindSuccess);
        });
    }

    async close(): Promise<void> {
        this.closing = true;
        const current = this.current;
        this.current = null;
        if (current !== null) {
            current.close();
        }
        const server = this.server;
        this.server = null;
        if (server === null) {
            return;
        }
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

    private accept(ws: WebSocket): void {
        if (this.current !== null) {
            this.logger.warn("游戏通道已有租户，拒绝新连接");
            ws.close();
            return;
        }
        this.current = ws;
        // 鉴权标志是脐带的分界：未鉴权（含鉴权失败/超时）连接的断开只清槽位、不动脐带
        // ——回环端口的端口扫描连断不得杀死 shim（修复 2 契约）
        let authenticated = false;
        const authTimer = setTimeout(() => {
            // 先释放租户槽位再关连接：超时关停同样不走脐带
            if (this.current !== ws) {
                return;
            }
            this.logger.warn("游戏通道鉴权超时（未收到令牌首帧），关闭连接");
            this.current = null;
            ws.close(1008, "unauthorized");
        }, this.authTimeoutMs);
        authTimer.unref();
        ws.once("message", (data) => {
            clearTimeout(authTimer);
            if (this.current !== ws) {
                return;
            }
            if (data.toString() !== this.token) {
                this.logger.warn("游戏通道令牌不匹配，拒绝连接");
                this.current = null;
                ws.close(1008, "unauthorized");
                return;
            }
            authenticated = true;
            this.openChannel(ws);
        });
        ws.on("close", () => {
            clearTimeout(authTimer);
            if (this.current !== ws) {
                return;
            }
            this.current = null;
            if (!authenticated || this.closing) {
                return;
            }
            // 关机日志由引导层打（单一出口）；此处只回调脐带通知
            this.lostHandler?.();
        });
        ws.on("error", (error) => {
            this.logger.error(`游戏通道连接错误：${error.message}`);
        });
    }

    /** 鉴权通过：包装 core IpcChannel（onClose 由游戏通道断开触发，即脐带信号） */
    private openChannel(ws: WebSocket): void {
        this.logger.info("游戏通道已鉴权（QuickJS 壳接入）");
        let open = true;
        const messageHandlers: ((text: string) => void)[] = [];
        const closeHandlers: (() => void)[] = [];
        const ipc: IpcChannel = {
            get isOpen(): boolean {
                return open;
            },
            send: (text: string): void => {
                if (open) {
                    ws.send(text);
                }
            },
            onMessage: (handler: (text: string) => void): void => {
                messageHandlers.push(handler);
            },
            onClose: (handler: () => void): void => {
                closeHandlers.push(handler);
            },
        };
        ws.on("message", (data) => {
            const text = data.toString();
            for (const handler of [...messageHandlers]) {
                handler(text);
            }
        });
        ws.on("close", () => {
            if (!open) {
                return;
            }
            open = false;
            for (const handler of [...closeHandlers]) {
                handler();
            }
        });
        this.channelHandler?.(ipc);
    }
}
