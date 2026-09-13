/**
 * IPC 侧消息（Java 薄壳 ↔ Node 子进程，stdin/stdout JSON-lines，ADR-010）
 *
 * 帧结构复用 WS 帧（决策 D-04）。spike 最小集 + v0.2 增量（MVP 阶段一）：
 * - Node→Java：ready（事件）、broadcast / execute_command（请求）
 * - Java→Node：game_chat / player_join / player_quit / status / shutdown（事件）、
 *   broadcast_result / execute_command_result（响应）
 *
 * 命名对齐：IPC 帧名描述 Bukkit 事件源（game_chat / player_join），WS 帧名是协议事件
 * （chat / join）；channel 概念只在 Node 侧业务存在，IPC 的 game_chat / player_join 等
 * 不携带 channel（Java 零业务）。
 * 所有 *Frame 类型均为扁平消息 { type, id?, body }（决策 D-11）。
 */
import { z } from "zod";

import { eventFrameSchema, requestFrameSchema, resultBodySchema } from "../frame.js";

// ---- Node → Java ----

const readyBodySchema = z.object({
    wsPort: z.number().int().positive(),
    /**
     * 宿主自动重启开关（DEBT-2）：业务配置 runtime.autoRestart 经 ready 上报给 Java。
     * 可选、缺省 true（缺省语义归 Node 侧 schema；Java 侧 null 按 true 处理）。
     */
    autoRestart: z.boolean().optional(),
});

/** WS 服务端已就绪（事件，携带动态端口） */
export const readyFrame = eventFrameSchema("ready", readyBodySchema);
export type ReadyBody = z.infer<typeof readyBodySchema>;
export type ReadyFrame = z.infer<typeof readyFrame>;

const broadcastBodySchema = z.object({
    /** 消息来源频道（Java 侧 MVP 只广播不区分，字段保留给未来按频道渲染） */
    channel: z.string().min(1),
    message: z.string().min(1),
});

/** 游戏内广播请求（Java 回同 id 的 broadcast_result） */
export const broadcastRequestFrame = requestFrameSchema("broadcast", broadcastBodySchema);
export type BroadcastBody = z.infer<typeof broadcastBodySchema>;
export type BroadcastRequestFrame = z.infer<typeof broadcastRequestFrame>;

const executeCommandBodySchema = z.object({
    command: z.string().min(1),
});

/** 执行服务器命令请求（Java 回同 id 的 execute_command_result） */
export const executeCommandRequestFrame = requestFrameSchema(
    "execute_command",
    executeCommandBodySchema,
);
export type ExecuteCommandBody = z.infer<typeof executeCommandBodySchema>;
export type ExecuteCommandRequestFrame = z.infer<typeof executeCommandRequestFrame>;

// ---- Java → Node ----

const gameChatBodySchema = z.object({
    playerName: z.string().min(1),
    content: z.string().min(1),
});

/** 游戏聊天事件（事件，由 Bukkit 事件桥接产生） */
export const gameChatEventFrame = eventFrameSchema("game_chat", gameChatBodySchema);
export type GameChatEventBody = z.infer<typeof gameChatBodySchema>;
export type GameChatEventFrame = z.infer<typeof gameChatEventFrame>;

const playerJoinEventBodySchema = z.object({
    playerName: z.string().min(1),
});

/** 玩家进服事件（PlayerJoinEvent 桥接；channel fan-out 是 Node 侧业务） */
export const playerJoinEventFrame = eventFrameSchema("player_join", playerJoinEventBodySchema);
export type PlayerJoinEventBody = z.infer<typeof playerJoinEventBodySchema>;
export type PlayerJoinEventFrame = z.infer<typeof playerJoinEventFrame>;

const playerQuitEventBodySchema = z.object({
    playerName: z.string().min(1),
});

/** 玩家退服事件（PlayerQuitEvent 桥接） */
export const playerQuitEventFrame = eventFrameSchema("player_quit", playerQuitEventBodySchema);
export type PlayerQuitEventBody = z.infer<typeof playerQuitEventBodySchema>;
export type PlayerQuitEventFrame = z.infer<typeof playerQuitEventFrame>;

const statusEventBodySchema = z.object({
    tps: z.number().nonnegative(),
    onlinePlayers: z.number().int().nonnegative(),
    uptimeSeconds: z.number().int().nonnegative(),
});

/** 服务器状态事件（Java 在 join/quit 时机推送，与 WS status body 同构） */
export const statusEventFrame = eventFrameSchema("status", statusEventBodySchema);
export type StatusEventBody = z.infer<typeof statusEventBodySchema>;
export type StatusEventFrame = z.infer<typeof statusEventFrame>;

const shutdownBodySchema = z.object({
    reason: z.string().min(1),
});

/** 关机通知（事件；随后 Java 会关 stdin，stdin EOF 为最终兜底，决策 D-08） */
export const shutdownFrame = eventFrameSchema("shutdown", shutdownBodySchema);
export type ShutdownBody = z.infer<typeof shutdownBodySchema>;
export type ShutdownFrame = z.infer<typeof shutdownFrame>;

/** broadcast 的响应（ok / error） */
export const broadcastResultFrame = requestFrameSchema("broadcast_result", resultBodySchema);
export type BroadcastResultFrame = z.infer<typeof broadcastResultFrame>;

/** execute_command 的响应（ok / error） */
export const executeCommandResultFrame = requestFrameSchema(
    "execute_command_result",
    resultBodySchema,
);
export type ExecuteCommandResultFrame = z.infer<typeof executeCommandResultFrame>;

// ---- 聚合（决策 D-09：平铺 union）----

/** Node 视角的收帧集 */
export const ipcNodeInboundFrame = z.union([
    gameChatEventFrame,
    playerJoinEventFrame,
    playerQuitEventFrame,
    statusEventFrame,
    broadcastResultFrame,
    executeCommandResultFrame,
    shutdownFrame,
]);

/** Java 视角的收帧集 */
export const ipcJavaInboundFrame = z.union([
    readyFrame,
    broadcastRequestFrame,
    executeCommandRequestFrame,
]);
