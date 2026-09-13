/**
 * WS 侧消息（kurobot-ws，draft-v0.1.md §2 + §6 v0.2 增量）
 *
 * v0.2（MVP 阶段一）：chat 双向携带 channel；hello_ack ok 体携带 channelBindings（ADR-004）；
 * 新增 join / leave / status / bindings_updated 事件（Server→Peer）。
 *
 * 注意：chat 在两个方向 body 形状不同（playerName / sender），
 * 消费方按方向选用 GameChatFrame / PlatformChatFrame（决策 D-01/D-09）。
 * 所有 *Frame 类型均为扁平消息 { type, id?, body }（决策 D-11）。
 */
import { z } from "zod";

import { eventFrameSchema, requestFrameSchema } from "../frame.js";

// ---- Peer → Server ----

const helloBodySchema = z.object({
    peerId: z.string().min(1),
    platform: z.string().min(1),
    version: z.string().min(1),
    protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
});

/** 对端注册（请求，Server 必须回同 id 的 hello_ack） */
export const helloFrame = requestFrameSchema("hello", helloBodySchema);
export type HelloBody = z.infer<typeof helloBodySchema>;
export type HelloFrame = z.infer<typeof helloFrame>;

const pingBodySchema = z.object({
    timestamp: z.number().int().nonnegative(),
});

/** 心跳请求 */
export const pingFrame = requestFrameSchema("ping", pingBodySchema);
export type PingBody = z.infer<typeof pingBodySchema>;
export type PingFrame = z.infer<typeof pingFrame>;

const platformChatBodySchema = z.object({
    /** 消息来源频道（绑定表标识，如群号） */
    channel: z.string().min(1),
    sender: z.string().min(1),
    content: z.string().min(1),
});

/** 平台 → 游戏聊天（事件；服务端按绑定表过滤未绑定频道） */
export const platformChatFrame = eventFrameSchema("chat", platformChatBodySchema);
export type PlatformChatBody = z.infer<typeof platformChatBodySchema>;
export type PlatformChatFrame = z.infer<typeof platformChatFrame>;

// ---- Server → Peer ----

const helloAckOkBodySchema = z.object({
    ok: z.literal(true),
    serverId: z.string().min(1),
    version: z.string().min(1),
    protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** 服务端绑定表快照（ADR-004：随握手下发；空数组合法） */
    channelBindings: z.array(z.string().min(1)),
});

const helloAckErrorBodySchema = z.object({
    ok: z.literal(false),
    reason: z.string().min(1),
});

/** 握手结果（响应；服务端身份信息并入 body，决策 D-01） */
export const helloAckFrame = z.union([
    requestFrameSchema("hello_ack", helloAckOkBodySchema),
    requestFrameSchema("hello_ack", helloAckErrorBodySchema),
]);
export type HelloAckOkBody = z.infer<typeof helloAckOkBodySchema>;
export type HelloAckErrorBody = z.infer<typeof helloAckErrorBodySchema>;
export type HelloAckBody = HelloAckOkBody | HelloAckErrorBody;
export type HelloAckFrame = z.infer<typeof helloAckFrame>;

const pongBodySchema = z.object({
    timestamp: z.number().int().nonnegative(),
});

/** 心跳响应 */
export const pongFrame = requestFrameSchema("pong", pongBodySchema);
export type PongBody = z.infer<typeof pongBodySchema>;
export type PongFrame = z.infer<typeof pongFrame>;

const gameChatBodySchema = z.object({
    /** 目标频道（服务端按绑定表逐频道 fan-out，每频道一帧） */
    channel: z.string().min(1),
    playerName: z.string().min(1),
    content: z.string().min(1),
});

/** 游戏 → 平台聊天（事件） */
export const gameChatFrame = eventFrameSchema("chat", gameChatBodySchema);
export type GameChatBody = z.infer<typeof gameChatBodySchema>;
export type GameChatFrame = z.infer<typeof gameChatFrame>;

const joinBodySchema = z.object({
    channel: z.string().min(1),
    playerName: z.string().min(1),
});

/** 玩家进服（事件，按绑定频道 fan-out） */
export const joinFrame = eventFrameSchema("join", joinBodySchema);
export type JoinBody = z.infer<typeof joinBodySchema>;
export type JoinFrame = z.infer<typeof joinFrame>;

const leaveBodySchema = z.object({
    channel: z.string().min(1),
    playerName: z.string().min(1),
});

/** 玩家退服（事件，按绑定频道 fan-out） */
export const leaveFrame = eventFrameSchema("leave", leaveBodySchema);
export type LeaveBody = z.infer<typeof leaveBodySchema>;
export type LeaveFrame = z.infer<typeof leaveFrame>;

const statusBodySchema = z.object({
    /** 1 分钟 TPS 均值（Paper getTPS()[0]） */
    tps: z.number().nonnegative(),
    onlinePlayers: z.number().int().nonnegative(),
    uptimeSeconds: z.number().int().nonnegative(),
});

/** 服务器状态（事件；无 channel——全服状态而非频道消息） */
export const statusFrame = eventFrameSchema("status", statusBodySchema);
export type StatusBody = z.infer<typeof statusBodySchema>;
export type StatusFrame = z.infer<typeof statusFrame>;

const bindingsUpdatedBodySchema = z.object({
    /** 变更后的完整绑定列表（非增量；ADR-004） */
    channelBindings: z.array(z.string().min(1)),
});

/** 绑定表变更推送（事件，配置变更时发给已握手对端） */
export const bindingsUpdatedFrame = eventFrameSchema("bindings_updated", bindingsUpdatedBodySchema);
export type BindingsUpdatedBody = z.infer<typeof bindingsUpdatedBodySchema>;
export type BindingsUpdatedFrame = z.infer<typeof bindingsUpdatedFrame>;

// ---- 聚合（收帧侧「接受任意已知帧」用；zod 4 不支持嵌套判别路径，故平铺 union，决策 D-09）----

/** kurobot 服务端视角的收帧集 */
export const wsInboundFrame = z.union([helloFrame, pingFrame, platformChatFrame]);

/** 协议端视角的收帧集 */
export const wsOutboundFrame = z.union([
    helloAckFrame,
    pongFrame,
    gameChatFrame,
    joinFrame,
    leaveFrame,
    statusFrame,
    bindingsUpdatedFrame,
]);
