/**
 * KurobotServer：kurobot-ws 协议服务端（握手 / 心跳 / 连接生命周期）。
 *
 * 握手语义（决策 D-01/ADR-023）：Peer 连入 → 发 hello（带 id）→ 校验 → 回同 id 的 hello_ack。
 * 协议版本协商（决策 D-10）：要求 protocolVersion 与本端 PROTOCOL_VERSION 精确相等
 * （大版本已由 WS 子协议把关）；不匹配 → hello_ack error + 关连接。
 * hello_ack ok 体携带 channelBindings（ADR-004，v0.2）——由注入的绑定表快照提供。
 *
 * 超时健壮性（MVP 阶段一，时钟/定时器注入，ADR-007）：
 * - hello 等待超时：连接建立起 helloTimeoutMs 内未握手 → 关连接（1002）。
 * - 心跳空闲检测：idleTimeoutMs 内未收到任何帧 → 判定断开、关连接（1001）；
 *   任何入帧（含非法帧——仍证明对端活着）都会刷新。阈值 0 = 禁用。
 *
 * 本类零业务：send* 只负责把帧推给全部已握手对端并返回送达数（无对端时上层可观测），
 * 频道过滤/fan-out 由上层（Relay/业务）决定。
 */
import {
    type BindingsUpdatedBody,
    encodeFrame,
    type GameChatBody,
    type HelloBody,
    type JoinBody,
    type LeaveBody,
    type PlatformChatBody,
    PROTOCOL_VERSION,
    type StatusBody,
    wsInboundFrame,
} from "@kurobot/protocol";

import type { CancelFn } from "./clock.js";
import type { CoreContext } from "./context.js";
import type { WsConnection, WsServer } from "./transport.js";

/** WS 关闭码：协议错误（版本不匹配 / 握手失败 / 握手超时） */
const CLOSE_PROTOCOL_ERROR = 1002;

/** WS 关闭码：对端失联（空闲超时） */
const CLOSE_IDLE = 1001;

/** 服务端超时阈值（毫秒）；0 = 禁用对应检测 */
export interface ServerTimeouts {
    /** 连接建立后等待 hello 的上限（默认 10s） */
    readonly helloTimeoutMs: number;
    /** 任意两帧之间的最大间隔（默认 30s） */
    readonly idleTimeoutMs: number;
}

export const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** 单个对端连接的状态（握手状态机 + 超时定时器） */
interface PeerState {
    readonly connection: WsConnection;
    established: boolean;
    peerId: string | null;
    helloTimer: CancelFn | null;
    idleTimer: CancelFn | null;
}

export interface ServerOptions {
    readonly context: CoreContext;
    readonly wsServer: WsServer;
    /** 当前绑定频道快照（hello_ack 上报给对端，ADR-004；业务层注入） */
    readonly channelBindings: () => string[];
    /** 超时阈值（缺省 hello 10s / idle 30s；0 禁用） */
    readonly timeouts?: ServerTimeouts;
}

export class KurobotServer {
    private readonly context: CoreContext;
    private readonly wsServer: WsServer;
    private readonly channelBindings: () => string[];
    private readonly helloTimeoutMs: number;
    private readonly idleTimeoutMs: number;
    private readonly peers = new Set<PeerState>();
    private platformChatHandler: ((body: PlatformChatBody) => void) | null = null;

    constructor(options: ServerOptions) {
        this.context = options.context;
        this.wsServer = options.wsServer;
        this.channelBindings = options.channelBindings;
        this.helloTimeoutMs = options.timeouts?.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
        this.idleTimeoutMs = options.timeouts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
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

    /** 停止服务端并关闭所有对端连接（定时器随 onClose 清理） */
    async stop(): Promise<void> {
        for (const peer of this.peers) {
            peer.connection.close(1001, "server shutdown");
        }
        this.peers.clear();
        await this.wsServer.stop();
    }

    /** 订阅平台 → 游戏聊天（业务入口，Relay 挂接） */
    onPlatformChat(handler: (body: PlatformChatBody) => void): void {
        this.platformChatHandler = handler;
    }

    /** 游戏 → 平台聊天（上层按绑定频道逐频道调用）。返回送达的已握手对端数。 */
    sendGameChat(body: GameChatBody): number {
        return this.sendToEstablished(encodeFrame({ type: "chat", body }));
    }

    /** 玩家进服事件（上层按绑定频道逐频道调用）。返回送达数。 */
    sendJoin(body: JoinBody): number {
        return this.sendToEstablished(encodeFrame({ type: "join", body }));
    }

    /** 玩家退服事件（上层按绑定频道逐频道调用）。返回送达数。 */
    sendLeave(body: LeaveBody): number {
        return this.sendToEstablished(encodeFrame({ type: "leave", body }));
    }

    /** 服务器状态事件（全服状态，无频道）。返回送达数。 */
    sendStatus(body: StatusBody): number {
        return this.sendToEstablished(encodeFrame({ type: "status", body }));
    }

    /** 绑定表变更推送（配置变更时发给已握手对端，ADR-004）。返回送达数。 */
    sendBindingsUpdated(body: BindingsUpdatedBody): number {
        return this.sendToEstablished(encodeFrame({ type: "bindings_updated", body }));
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

    private sendToEstablished(text: string): number {
        let delivered = 0;
        for (const peer of this.peers) {
            if (peer.established) {
                peer.connection.send(text);
                delivered += 1;
            }
        }
        if (delivered === 0) {
            this.context.logger.debug("无已握手对端，丢弃出帧");
        }
        return delivered;
    }

    private handleConnection(connection: WsConnection): void {
        const peer: PeerState = {
            connection,
            established: false,
            peerId: null,
            helloTimer: null,
            idleTimer: null,
        };
        this.peers.add(peer);
        connection.onClose(() => {
            if (peer.peerId !== null) {
                this.context.logger.info(`对端 ${peer.peerId} 断开`);
            } else {
                this.context.logger.debug("未握手连接关闭");
            }
            this.cancelTimers(peer);
            this.peers.delete(peer);
        });
        connection.onMessage((text) => {
            this.handleMessage(peer, text);
        });
        this.armHelloTimeout(peer);
        this.armIdleTimeout(peer);
    }

    /** 握手超时：helloTimeoutMs 内未完成握手 → 关连接 */
    private armHelloTimeout(peer: PeerState): void {
        if (this.helloTimeoutMs <= 0) {
            return;
        }
        peer.helloTimer = this.context.scheduler.schedule(this.helloTimeoutMs, () => {
            peer.helloTimer = null;
            this.context.logger.warn(`连接 ${this.describePeer(peer)} 等待 hello 超时，关闭`);
            peer.connection.close(CLOSE_PROTOCOL_ERROR, "hello timeout");
        });
    }

    /** 空闲检测：idleTimeoutMs 内无任何入帧 → 判定断开。任何入帧都会重挂。 */
    private armIdleTimeout(peer: PeerState): void {
        if (this.idleTimeoutMs <= 0) {
            return;
        }
        peer.idleTimer?.();
        peer.idleTimer = this.context.scheduler.schedule(this.idleTimeoutMs, () => {
            peer.idleTimer = null;
            this.context.logger.warn(
                `对端 ${this.describePeer(peer)} ${this.idleTimeoutMs}ms 无任何帧，判定断开`,
            );
            peer.connection.close(CLOSE_IDLE, "idle timeout");
        });
    }

    private cancelTimers(peer: PeerState): void {
        peer.helloTimer?.();
        peer.helloTimer = null;
        peer.idleTimer?.();
        peer.idleTimer = null;
    }

    private describePeer(peer: PeerState): string {
        return peer.peerId ?? "（未握手）";
    }

    private handleMessage(peer: PeerState, text: string): void {
        this.armIdleTimeout(peer); // 任何入帧都证明对端活着（含非法帧）
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
        if (message.type !== "chat") {
            // v0.3.0 的 command / query 帧已在收帧集内；业务处理于 DEBT-1 阶段 2 接入，此处先丢弃
            this.context.logger.warn(`收到 ${message.type} 帧（业务处理未接入），丢弃`);
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
        peer.helloTimer?.();
        peer.helloTimer = null;
        peer.connection.send(
            encodeFrame({
                type: "hello_ack",
                id,
                body: {
                    ok: true,
                    serverId: this.context.serverId,
                    version: this.context.version,
                    protocolVersion: PROTOCOL_VERSION,
                    channelBindings: this.channelBindings(),
                },
            }),
        );
        this.context.logger.info(`对端 ${body.peerId} 握手成功（platform=${body.platform}）`);
    }

    private rejectHello(peer: PeerState, id: string, reason: string): void {
        this.cancelTimers(peer);
        peer.connection.send(encodeFrame({ type: "hello_ack", id, body: { ok: false, reason } }));
        peer.connection.close(CLOSE_PROTOCOL_ERROR, reason);
        this.context.logger.warn(`握手被拒：${reason}`);
    }
}
