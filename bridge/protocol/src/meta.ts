/**
 * 协议元信息（ADR-003：双层版本）
 *
 * - WS_SUBPROTOCOL：大版本（不兼容变化，握手期拒绝）。
 * - PROTOCOL_VERSION：语义化小版本，hello 期能力协商。
 */

export const PROTOCOL_NAME = "kurobot-ws" as const;

/** 语义化版本（ADR-003：hello.protocolVersion 用它做小版本/能力协商；v0.2 增频道与新事件集） */
export const PROTOCOL_VERSION = "0.2.0" as const;

/** WS 子协议（ADR-003：大版本，握手期拒绝不兼容对端） */
export const WS_SUBPROTOCOL = "kurobot-ws.v1" as const;
