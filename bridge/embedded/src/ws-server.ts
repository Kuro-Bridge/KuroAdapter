/**
 * `ws` 库适配器：实现 bridge/core 的 WsServer / WsConnection 接口（决策 D-05）。
 *
 * - 动态端口：listen(0)（ADR-010：避免僵尸进程占端口）。
 * - 子协议：握手期校验 `kurobot-ws.v1`（ADR-003 大版本），不匹配直接拒绝连接。
 */
import type { WsConnection, WsServer } from "@kurobot/bridge-core";
import { WS_SUBPROTOCOL } from "@kurobot/protocol";
import { type WebSocket, WebSocketServer } from "ws";

export class NodeWsServer implements WsServer {
    private server: WebSocketServer | null = null;
    private connectionHandler: ((connection: WsConnection) => void) | null = null;

    async start(): Promise<number> {
        const server = new WebSocketServer({
            port: 0,
            handleProtocols: (protocols) => {
                return protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false;
            },
        });
        this.server = server;
        server.on("connection", (ws) => {
            this.connectionHandler?.(new NodeWsConnection(ws));
        });
        return this.resolvePort(server);
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
