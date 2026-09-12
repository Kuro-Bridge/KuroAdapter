/**
 * KurobotServer：kurobot-ws 协议服务端（握手 / 心跳 / 连接生命周期）。
 *
 * 握手语义（决策 D-01）：Peer 连入 → 发 hello（带 id）→ 校验 → 回同 id 的 hello_ack。
 * 协议版本协商（决策 D-10）：spike 要求 protocolVersion 与本端 PROTOCOL_VERSION
 * 精确相等（大版本已由 WS 子协议把关）；不匹配 → hello_ack error + 关连接。
 */
import {
    encodeFrame,
    type GameChatBody,
    type HelloBody,
    type PlatformChatBody,
    PROTOCOL_VERSION,
    wsInboundFrame,
} from "@kurobot/protocol";

import type { CoreContext } from "./context.js";
import type { WsConnection, WsServer } from "./transport.js";

/** WS 关闭码：协议错误（版本不匹配 / 握手失败） */
const CLOSE_PROTOCOL_ERROR = 1002;

/** 单个对端连接的状态（握手状态机） */
interface PeerState {
    readonly connection: WsConnection;
    established: boolean;
    peerId: string | null;
}

export interface ServerOptions {
    readonly context: CoreContext;
    readonly wsServer: WsServer;
}

export class KurobotServer {
    private readonly context: CoreContext;
    private readonly wsServer: WsServer;
    private readonly peers = new Set<PeerState>();
    private platformChatHandler: ((body: PlatformChatBody) => void) | null = null;

    constructor(options: ServerOptions) {
        this.context = options.context;
        this.wsServer = options.wsServer;
        this.wsServer.onConnection((connection) => {
            this.handleConnection(connection);
        });
    }

    /** 开始监听，返回实际端口 */
    async start(): Promise<number> {
        const port = await this.wsServer.start();
        this.context.logger.info(`WS 服务端已监听端口 ${port}`);
        return port;
    }

    /** 停止服务端并关闭所有对端连接 */
    async stop(): Promise<void> {
        for (const peer of this.peers) {
            peer.connection.close(1001, "server shutdown");
        }
        this.peers.clear();
        await this.wsServer.stop();
    }

    /** 订阅平台 → 游戏聊天（占位业务入口，Relay 挂接） */
    onPlatformChat(handler: (body: PlatformChatBody) => void): void {
        this.platformChatHandler = handler;
    }

    /** 游戏 → 平台聊天：推给所有已握手对端（spike：无绑定过滤，全量转发） */
    sendGameChat(body: GameChatBody): void {
        const text = encodeFrame({ type: "chat", body });
        let delivered = 0;
        for (const peer of this.peers) {
            if (peer.established) {
                peer.connection.send(text);
                delivered += 1;
            }
        }
        if (delivered === 0) {
            this.context.logger.debug("游戏聊天无已握手对端，丢弃");
        }
    }

    /** 当前已握手对端数（观测/测试用） */
    get establishedPeerCount(): number {
        let count = 0;
        for (const peer of this.peers) {
            if (peer.established) {
                count += 1;
            }
        }
        return count;
    }

    private handleConnection(connection: WsConnection): void {
        const peer: PeerState = { connection, established: false, peerId: null };
        this.peers.add(peer);
        connection.onClose(() => {
            if (peer.peerId !== null) {
                this.context.logger.info(`对端 ${peer.peerId} 断开`);
            }
            this.peers.delete(peer);
        });
        connection.onMessage((text) => {
            this.handleMessage(peer, text);
        });
    }

    private handleMessage(peer: PeerState, text: string): void {
        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch {
            this.context.logger.warn("对端帧不是合法 JSON，丢弃");
            return;
        }
        const parsed = wsInboundFrame.safeParse(raw);
        if (!parsed.success) {
            this.context.logger.warn(`对端帧校验失败，丢弃：${text.slice(0, 200)}`);
            return;
        }
        const message = parsed.data;
        if (message.type === "hello") {
            this.handleHello(peer, message.id, message.body);
            return;
        }
        if (!peer.established) {
            this.context.logger.warn(`握手完成前收到 ${message.type}，丢弃`);
            return;
        }
        if (message.type === "ping") {
            peer.connection.send(encodeFrame({ type: "pong", id: message.id, body: message.body }));
            return;
        }
        // message.type === "chat"（平台 → 游戏）
        this.platformChatHandler?.(message.body);
    }

    private handleHello(peer: PeerState, id: string, body: HelloBody): void {
        if (peer.established) {
            this.context.logger.warn(`对端 ${body.peerId} 重复 hello，忽略`);
            return;
        }
        if (body.protocolVersion !== PROTOCOL_VERSION) {
            this.rejectHello(peer, id, `protocol version mismatch: peer=${body.protocolVersion}`);
            return;
        }
        peer.established = true;
        peer.peerId = body.peerId;
        peer.connection.send(
            encodeFrame({
                type: "hello_ack",
                id,
                body: {
                    ok: true,
                    serverId: this.context.serverId,
                    version: this.context.version,
                    protocolVersion: PROTOCOL_VERSION,
                },
            }),
        );
        this.context.logger.info(`对端 ${body.peerId} 握手成功（platform=${body.platform}）`);
    }

    private rejectHello(peer: PeerState, id: string, reason: string): void {
        peer.connection.send(encodeFrame({ type: "hello_ack", id, body: { ok: false, reason } }));
        peer.connection.close(CLOSE_PROTOCOL_ERROR, reason);
        this.context.logger.warn(`握手被拒：${reason}`);
    }
}
