/**
 * @kuro-bridge/protocol —— kurobridge-ws 协议 zod schema SSOT
 *
 * 这里是消息类型的唯一来源（硬约束，见 AGENTS.md）：
 * 任何文件禁止手写消息类型，必须 `import { ... } from "@kuro-bridge/protocol"`。
 *
 * 原型最小集 + v0.2 / v0.3.x / v0.4.0 增量见各子模块与 meta.ts 版本史；
 * 语义说明见 docs/protocol/peer-guide.md（历史草案 docs/history/draft-v0.1.md 仅供考古）。
 */

import type {
    CommandResultBody,
    EventMessage,
    FrameHeader,
    RequestMessage,
    ResultBody,
    WireFrame,
} from "./frame.js";
import {
    commandResultBodySchema,
    encodeFrame,
    eventFrameSchema,
    frameHeaderSchema,
    requestFrameSchema,
    resultBodySchema,
    wireFrameSchema,
} from "./frame.js";
import {
    isProtocolVersionCompatible,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    WS_SUBPROTOCOL,
} from "./meta.js";

export type {
    BroadcastBody,
    BroadcastRequestFrame,
    BroadcastResultFrame,
    ConfigReloadFrame,
    ExecuteCommandBody,
    ExecuteCommandRequestFrame,
    ExecuteCommandResultFrame,
    GameChatEventBody,
    GameChatEventFrame,
    PlayerDeathEventBody,
    PlayerDeathEventFrame,
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
    configReloadFrame,
    executeCommandRequestFrame,
    executeCommandResultFrame,
    gameChatEventFrame,
    ipcJavaInboundFrame,
    ipcNodeInboundFrame,
    playerDeathEventFrame,
    playerJoinEventFrame,
    playerQuitEventFrame,
    readyFrame,
    shutdownFrame,
    statusEventFrame,
} from "./messages/ipc.js";
export type {
    BindingsUpdatedBody,
    BindingsUpdatedFrame,
    CommandBody,
    CommandFrame,
    CommandResultFrame,
    CommandSource,
    DeathBody,
    DeathFrame,
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
    QueryBody,
    QueryFrame,
    QueryResultBody,
    QueryResultFrame,
    StatusBody,
    StatusFrame,
} from "./messages/ws.js";

// ---- WS 侧消息 ----
export {
    bindingsUpdatedFrame,
    commandFrame,
    commandResultFrame,
    deathFrame,
    gameChatFrame,
    helloAckFrame,
    helloFrame,
    joinFrame,
    leaveFrame,
    pingFrame,
    platformChatFrame,
    pongFrame,
    queryFrame,
    queryResultFrame,
    statusFrame,
    WS_INBOUND_TYPES,
    wsInboundFrame,
    wsOutboundFrame,
} from "./messages/ws.js";
export type { CommandResultBody, EventMessage, FrameHeader, RequestMessage, ResultBody, WireFrame };
// ---- 帧格式 ----
// ---- 元信息 ----
export {
    commandResultBodySchema,
    encodeFrame,
    eventFrameSchema,
    frameHeaderSchema,
    isProtocolVersionCompatible,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    requestFrameSchema,
    resultBodySchema,
    WS_SUBPROTOCOL,
    wireFrameSchema,
};
