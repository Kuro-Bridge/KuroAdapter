/**
 * KurobotServer：kurobridge-ws 协议服务端（握手 / 鉴权 / 心跳 / 连接生命周期）。
 *
 * 握手语义（决策 D-01/ADR-023）：Peer 连入 → 发 hello（带 id）→ 校验 → 回同 id 的 hello_ack。
 * 协议版本协商（ADR-026，v0.3.0）：主版本号相同即兼容（isProtocolVersionCompatible）；
 * 不匹配 → hello_ack error + 关连接（1002）。
 * 鉴权（DEBT-1）：CoreContext.token 非空时 hello 必须携带相同 token；失败 →
 * hello_ack "auth failed" + 关连接（1008）。token 为空 = 不鉴权（向后兼容）。
 * hello_ack ok 体携带 channelBindings（ADR-004，v0.2）——由注入的绑定表快照提供。
 *
 * 收帧（ADR-026 两段式解析）：wireFrameSchema 先取 type/id 骨架，已知 type 分发到具体
 * schema safeParse（失败 warn 丢弃）；未知 type 走容忍路径——请求帧（带 id）回同 id 的
 * `<type>_result {ok:false,"unknown frame type"}`、`_result` 结尾不回执（防乒乓）、
 * 事件帧 debug 忽略，均不断连。
 *
 * 超时健壮性（MVP 阶段一，时钟/定时器注入，ADR-007）：
 * - hello 等待超时：连接建立起 helloTimeoutMs 内未握手 → 关连接（1002）。
 * - 心跳空闲检测：idleTimeoutMs 内未收到任何帧 → 判定断开、关连接（1001）；
 *   任何入帧（含非法帧——仍证明对端活着）都会刷新。阈值 0 = 禁用。
 *
 * 本类零业务：send* 只负责把帧推给全部已握手对端并返回送达数（无对端时上层可观测），
 * 频道过滤/fan-out 由上层（Relay/业务）决定；command 的管理员判定/执行经 onCommand
 * 交给上层，query 在本地作答（status 缓存 + 绑定快照，零 IPC）。
 */
import {
    type BindingsUpdatedBody,
    type CommandBody,
    type CommandResultBody,
    commandFrame,
    type DeathBody,
    encodeFrame,
    type FrameHeader,
    type GameChatBody,
    type HelloBody,
    helloFrame,
    isProtocolVersionCompatible,
    type JoinBody,
    type LeaveBody,
    type PlatformChatBody,
    PROTOCOL_VERSION,
    pingFrame,
    platformChatFrame,
    type QueryBody,
    queryFrame,
    type StatusBody,
    WS_INBOUND_TYPES,
    wireFrameSchema,
} from "@kuro-bridge/protocol";

import type { CancelFn } from "./clock.js";
import type { CoreContext } from "./context.js";
import type { WsConnection, WsServer } from "./transport.js";

/** WS 关闭码：协议错误（版本不匹配 / 握手失败 / 握手超时） */
const CLOSE_PROTOCOL_ERROR = 1002;

/** WS 关闭码：对端失联（空闲超时） */
const CLOSE_IDLE = 1001;

/** WS 关闭码：策略违规（鉴权失败，DEBT-1） */
const CLOSE_POLICY_VIOLATION = 1008;

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
    /** command 请求的业务处理（管理员判定 + IPC 执行在 Relay，server 零业务） */
    private commandHandler: ((body: CommandBody) => Promise<CommandResultBody>) | null = null;
    /** 最近一帧 status 快照（query status 本地作答用；null = 尚未收到过） */
    private latestStatus: StatusBody | null = null;

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

    /** 订阅 command 请求（业务入口，Relay 挂接：管理员判定 + IPC 执行） */
    onCommand(handler: (body: CommandBody) => Promise<CommandResultBody>): void {
        this.commandHandler = handler;
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

    /** 服务器状态事件（全服状态，无频道）。顺带更新 query status 的本地缓存。返回送达数。 */
    sendStatus(body: StatusBody): number {
        this.latestStatus = body;
        return this.sendToEstablished(encodeFrame({ type: "status", body }));
    }

    /** 玩家死亡事件（上层按绑定频道逐频道调用，v0.3.0）。返回送达数。 */
    sendDeath(body: DeathBody): number {
        return this.sendToEstablished(encodeFrame({ type: "death", body }));
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
        // 两段式解析（ADR-026）：wire 骨架先取 type/id；未知 type 先走容忍路径（无状态、
        // 不断连），已知 type 再按握手状态与具体 schema 分发
        const wire = wireFrameSchema.safeParse(raw);
        if (!wire.success) {
            this.context.logger.warn(`对端帧校验失败，丢弃：${text.slice(0, 200)}`);
            return;
        }
        const { type, id } = wire.data.header;
        if (type === "hello") {
            const parsed = helloFrame.safeParse(raw);
            if (parsed.success) {
                this.handleHello(peer, parsed.data.id, parsed.data.body);
                return;
            }
        } else if (!WS_INBOUND_TYPES.includes(type)) {
            this.handleUnknownFrame(peer, type, id);
            return;
        } else {
            if (!peer.established) {
                this.context.logger.warn(`握手完成前收到 ${type}，丢弃`);
                return;
            }
            if (this.handleEstablishedFrame(peer, wire.data, raw)) {
                return;
            }
        }
        this.context.logger.warn(`对端 ${type} 帧校验失败，丢弃：${text.slice(0, 200)}`);
    }

    /**
     * 握手后的已知帧分发（v0.3.0：ping / chat / command / query）。
     * 返回是否已受理（true = 已处理或已回执）；false = 具体校验失败，调用方 warn 丢弃。
     */
    private handleEstablishedFrame(
        peer: PeerState,
        wire: { header: FrameHeader; body: unknown },
        raw: unknown,
    ): boolean {
        if (wire.header.type === "ping") {
            const parsed = pingFrame.safeParse(raw);
            if (parsed.success) {
                peer.connection.send(
                    encodeFrame({ type: "pong", id: parsed.data.id, body: parsed.data.body }),
                );
                return true;
            }
            return false;
        }
        if (wire.header.type === "chat") {
            const parsed = platformChatFrame.safeParse(raw);
            if (parsed.success) {
                this.platformChatHandler?.(parsed.data.body);
                return true;
            }
            return false;
        }
        if (wire.header.type === "command") {
            const parsed = commandFrame.safeParse(raw);
            if (parsed.success) {
                this.dispatchCommand(peer, parsed.data.id, parsed.data.body);
                return true;
            }
            return false;
        }
        if (wire.header.type === "query") {
            const parsed = queryFrame.safeParse(raw);
            if (parsed.success) {
                this.handleQuery(peer, parsed.data.id, parsed.data.body);
                return true;
            }
            return false;
        }
        // 未知 type 已在 handleMessage 前置容忍，理论上不可达；防御性按未受理处理
        return false;
    }

    /**
     * 未知帧容忍（ADR-026）：请求帧（带 uuid id）→ 回同 id 的 `<type>_result`
     * `{ok:false,"unknown frame type"}`；`_result` 结尾视为响应帧不回执（防乒乓循环）；
     * 事件帧 → debug 忽略。均不断连。
     */
    private handleUnknownFrame(peer: PeerState, type: string, id: string | undefined): void {
        if (id === undefined) {
            this.context.logger.debug(`收到未知事件帧 ${type}，忽略`);
            return;
        }
        if (type.endsWith("_result")) {
            this.context.logger.debug(`收到未知响应帧 ${type}，忽略（响应不回执，防乒乓循环）`);
            return;
        }
        this.context.logger.debug(`收到未知请求帧 ${type}，回执 unknown frame type`);
        peer.connection.send(
            encodeFrame({
                type: `${type}_result`,
                id,
                body: { ok: false, error: "unknown frame type" },
            }),
        );
    }

    /** command 请求：交给上层业务处理（管理员判定 + IPC 执行），同 id 回 command_result */
    private dispatchCommand(peer: PeerState, id: string, body: CommandBody): void {
        const handler = this.commandHandler;
        if (handler === null) {
            this.context.logger.warn("收到 command 帧但业务处理未注册，回执失败");
            peer.connection.send(
                encodeFrame({
                    type: "command_result",
                    id,
                    body: { ok: false, error: "command handler not available" },
                }),
            );
            return;
        }
        void handler(body)
            .then((result) => {
                peer.connection.send(encodeFrame({ type: "command_result", id, body: result }));
            })
            .catch((error: unknown) => {
                const reason = error instanceof Error ? error.message : String(error);
                this.context.logger.warn(`command 执行失败：${reason}`);
                peer.connection.send(
                    encodeFrame({
                        type: "command_result",
                        id,
                        body: { ok: false, error: reason },
                    }),
                );
            });
    }

    /** query 请求：core 本地作答（零 IPC）。status 回缓存快照；bindings 回绑定表实时快照 */
    private handleQuery(peer: PeerState, id: string, body: QueryBody): void {
        if (body.kind === "status") {
            const snapshot = this.latestStatus;
            if (snapshot === null) {
                peer.connection.send(
                    encodeFrame({
                        type: "query_result",
                        id,
                        body: { ok: false, error: "no status yet" },
                    }),
                );
                return;
            }
            peer.connection.send(
                encodeFrame({ type: "query_result", id, body: { ok: true, data: snapshot } }),
            );
            return;
        }
        peer.connection.send(
            encodeFrame({
                type: "query_result",
                id,
                body: { ok: true, data: this.channelBindings() },
            }),
        );
    }

    private handleHello(peer: PeerState, id: string, body: HelloBody): void {
        if (peer.established) {
            this.context.logger.warn(`对端 ${body.peerId} 重复 hello，忽略`);
            return;
        }
        if (!isProtocolVersionCompatible(body.protocolVersion, PROTOCOL_VERSION)) {
            this.rejectHello(peer, id, `protocol version mismatch: peer=${body.protocolVersion}`);
            return;
        }
        if (this.context.token !== "" && body.token !== this.context.token) {
            this.rejectHello(peer, id, "auth failed", CLOSE_POLICY_VIOLATION);
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
        // client 自报身份（v0.3.1，MVP-3）：仅连接日志辨识，不做行为分支
        const clientSuffix = body.client === undefined ? "" : `，client=${body.client}`;
        this.context.logger.info(
            `对端 ${body.peerId} 握手成功（platform=${body.platform}${clientSuffix}）`,
        );
    }

    private rejectHello(
        peer: PeerState,
        id: string,
        reason: string,
        code: number = CLOSE_PROTOCOL_ERROR,
    ): void {
        this.cancelTimers(peer);
        peer.connection.send(encodeFrame({ type: "hello_ack", id, body: { ok: false, reason } }));
        peer.connection.close(code, reason);
        this.context.logger.warn(`握手被拒：${reason}`);
    }
}
