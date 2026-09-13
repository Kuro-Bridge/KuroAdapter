/**
 * @kurobot/protocol —— kurobot-ws 协议 zod schema SSOT
 *
 * 这里是消息类型的唯一来源（硬约束，见 AGENTS.md）：
 * 任何文件禁止手写消息类型，必须 `import { ... } from "@kurobot/protocol"`。
 *
 * 原型最小集 + v0.2 增量见各子模块；docs/protocol/draft-v0.1.md 是语义说明。
 */

import type { EventMessage, FrameHeader, RequestMessage, ResultBody } from "./frame.js";
import {
    encodeFrame,
    eventFrameSchema,
    frameHeaderSchema,
    requestFrameSchema,
    resultBodySchema,
} from "./frame.js";
import { PROTOCOL_NAME, PROTOCOL_VERSION, WS_SUBPROTOCOL } from "./meta.js";

export type {
    BroadcastBody,
    BroadcastRequestFrame,
    BroadcastResultFrame,
    ExecuteCommandBody,
    ExecuteCommandRequestFrame,
    ExecuteCommandResultFrame,
    GameChatEventBody,
    GameChatEventFrame,
    PlayerJoinEventBody,
    PlayerJoinEventFrame,
    PlayerQuitEventBody,
    PlayerQuitEventFrame,
    ReadyBody,
    ReadyFrame,
    ShutdownBody,
    ShutdownFrame,
    StatusEventBody,
    StatusEventFrame,
} from "./messages/ipc.js";
// ---- IPC 侧消息 ----
export {
    broadcastRequestFrame,
    broadcastResultFrame,
    executeCommandRequestFrame,
    executeCommandResultFrame,
    gameChatEventFrame,
    ipcJavaInboundFrame,
    ipcNodeInboundFrame,
    playerJoinEventFrame,
    playerQuitEventFrame,
    readyFrame,
    shutdownFrame,
    statusEventFrame,
} from "./messages/ipc.js";
export type {
    BindingsUpdatedBody,
    BindingsUpdatedFrame,
    GameChatBody,
    GameChatFrame,
    HelloAckBody,
    HelloAckErrorBody,
    HelloAckFrame,
    HelloAckOkBody,
    HelloBody,
    HelloFrame,
    JoinBody,
    JoinFrame,
    LeaveBody,
    LeaveFrame,
    PingBody,
    PingFrame,
    PlatformChatBody,
    PlatformChatFrame,
    PongBody,
    PongFrame,
    StatusBody,
    StatusFrame,
} from "./messages/ws.js";

// ---- WS 侧消息 ----
export {
    bindingsUpdatedFrame,
    gameChatFrame,
    helloAckFrame,
    joinFrame,
    leaveFrame,
    pingFrame,
    platformChatFrame,
    pongFrame,
    statusFrame,
    wsInboundFrame,
    wsOutboundFrame,
} from "./messages/ws.js";
export type { EventMessage, FrameHeader, RequestMessage, ResultBody };
// ---- 元信息 ----
// ---- 帧格式 ----
export {
    encodeFrame,
    eventFrameSchema,
    frameHeaderSchema,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    requestFrameSchema,
    resultBodySchema,
    WS_SUBPROTOCOL,
};
