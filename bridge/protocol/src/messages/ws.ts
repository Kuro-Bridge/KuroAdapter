/**
 * WS 侧消息（kurobot-ws，draft-v0.1.md §2）
 *
 * 原型最小集（任务书 §4.1）：
 * - Peer→Server：hello（请求）、ping（心跳请求）、chat（平台聊天）
 * - Server→Peer：hello_ack（响应，含协议协商）、pong（心跳响应）、chat（游戏聊天）
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
    sender: z.string().min(1),
    content: z.string().min(1),
});

/** 平台 → 游戏聊天（事件） */
export const platformChatFrame = eventFrameSchema("chat", platformChatBodySchema);
export type PlatformChatBody = z.infer<typeof platformChatBodySchema>;
export type PlatformChatFrame = z.infer<typeof platformChatFrame>;

// ---- Server → Peer ----

const helloAckOkBodySchema = z.object({
    ok: z.literal(true),
    serverId: z.string().min(1),
    version: z.string().min(1),
    protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
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
export type HelloAckBody =
    | z.infer<typeof helloAckOkBodySchema>
    | z.infer<typeof helloAckErrorBodySchema>;
export type HelloAckFrame = z.infer<typeof helloAckFrame>;

const pongBodySchema = z.object({
    timestamp: z.number().int().nonnegative(),
});

/** 心跳响应 */
export const pongFrame = requestFrameSchema("pong", pongBodySchema);
export type PongBody = z.infer<typeof pongBodySchema>;
export type PongFrame = z.infer<typeof pongFrame>;

const gameChatBodySchema = z.object({
    playerName: z.string().min(1),
    content: z.string().min(1),
});

/** 游戏 → 平台聊天（事件） */
export const gameChatFrame = eventFrameSchema("chat", gameChatBodySchema);
export type GameChatBody = z.infer<typeof gameChatBodySchema>;
export type GameChatFrame = z.infer<typeof gameChatFrame>;

// ---- 聚合（收帧侧「接受任意已知帧」用；zod 4 不支持嵌套判别路径，故平铺 union，决策 D-09）----

/** kurobot 服务端视角的收帧集 */
export const wsInboundFrame = z.union([helloFrame, pingFrame, platformChatFrame]);

/** 协议端视角的收帧集 */
export const wsOutboundFrame = z.union([helloAckFrame, pongFrame, gameChatFrame]);
