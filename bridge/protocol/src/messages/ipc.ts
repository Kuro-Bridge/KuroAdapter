/**
 * IPC 侧消息（Java 薄壳 ↔ Node 子进程，stdin/stdout JSON-lines，ADR-010）
 *
 * 帧结构复用 WS 帧（决策 D-04）。原型最小集（任务书 §4.1）：
 * - Node→Java：ready（事件）、broadcast / execute_command（请求）
 * - Java→Node：game_chat / shutdown（事件）、broadcast_result / execute_command_result（响应）
 *
 * 所有 *Frame 类型均为扁平消息 { type, id?, body }（决策 D-11）。
 */
import { z } from "zod";

import { eventFrameSchema, requestFrameSchema, resultBodySchema } from "../frame.js";

// ---- Node → Java ----

const readyBodySchema = z.object({
    wsPort: z.number().int().positive(),
});

/** WS 服务端已就绪（事件，携带动态端口） */
export const readyFrame = eventFrameSchema("ready", readyBodySchema);
export type ReadyBody = z.infer<typeof readyBodySchema>;
export type ReadyFrame = z.infer<typeof readyFrame>;

const broadcastBodySchema = z.object({
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
