/**
 * 协议元信息（ADR-003：双层版本）
 *
 * - WS_SUBPROTOCOL：大版本（不兼容变化，握手期拒绝）。
 * - PROTOCOL_VERSION：语义化小版本，hello 期能力协商（主版本兼容区间，ADR-026）。
 */

export const PROTOCOL_NAME = "kurobot-ws" as const;

/**
 * 语义化版本（ADR-026：hello.protocolVersion 按主版本兼容区间协商——0.2.0 对端可连
 * 0.3.0 服务端；v0.3.0 增鉴权 token、command/query 请求族、death 事件、config_reload——
 * DEBT-1，未知帧容忍为协商安全网）
 */
export const PROTOCOL_VERSION = "0.3.0" as const;

/** WS 子协议（ADR-003：大版本，握手期拒绝不兼容对端） */
export const WS_SUBPROTOCOL = "kurobot-ws.v1" as const;

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

function parseMajor(version: string): number | null {
    const match = VERSION_PATTERN.exec(version);
    if (match === null) {
        return null;
    }
    const major = Number.parseInt(match[1] as string, 10);
    return Number.isNaN(major) ? null : major;
}

/**
 * 协议版本兼容判定（ADR-026）：主版本号相同即兼容（0.2.0 对端可连 0.3.0 服务端）。
 * 任一侧不满足语义化三元组格式 → 不兼容（hello schema 已强制格式，此处防御性兜底）。
 */
export function isProtocolVersionCompatible(peerVersion: string, serverVersion: string): boolean {
    const peer = parseMajor(peerVersion);
    const server = parseMajor(serverVersion);
    return peer !== null && server !== null && peer === server;
}
