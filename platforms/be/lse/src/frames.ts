/**
 * 帧编解码（壳侧）。出帧统一 encodeFrame（协议包扁平消息 → 线格式 JSON 单行，一帧一
 * WS text message）；入帧两段式解析（ADR-026）：先 wireFrameSchema 取 type，再分发具体
 * schema。JSON.parse 与 zod 校验失败一律返回 null（调用方 debug 日志后丢弃）。
 * 事件帧 header 严禁 id（协议包 strict 校验兜底）。
 */
import {
    broadcastRequestFrame,
    type CommandResultBody,
    encodeFrame,
    executeCommandRequestFrame,
    readyFrame,
    wireFrameSchema,
} from "@kuro-bridge/protocol";

/** shim → 壳 的入站帧全集（本通道不存在其他词汇；未知帧 → null） */
export type HostInbound =
    | { type: "ready"; body: { wsPort: number; autoRestart?: boolean | undefined } }
    | { type: "broadcast"; id: string; body: { channel: string; message: string } }
    | { type: "execute_command"; id: string; body: { command: string } };

export function encodeGameChat(playerName: string, content: string): string {
    return encodeFrame({ type: "game_chat", body: { playerName, content } });
}

export function encodePlayerJoin(playerName: string): string {
    return encodeFrame({ type: "player_join", body: { playerName } });
}

export function encodePlayerQuit(playerName: string): string {
    return encodeFrame({ type: "player_quit", body: { playerName } });
}

/** 死亡文案恒空串：onPlayerDie 无文案参数（裁决册 §5 差异项，不造假数据） */
export function encodePlayerDeath(player: string): string {
    return encodeFrame({ type: "player_death", body: { player, message: "" } });
}

/** broadcast 立即回执对齐 JE：恒 ok:true（裁决册 §4.3） */
export function encodeBroadcastResult(id: string): string {
    return encodeFrame({ type: "broadcast_result", id, body: { ok: true } });
}

export function encodeExecuteCommandResult(id: string, body: CommandResultBody): string {
    return encodeFrame({ type: "execute_command_result", id, body });
}

export function decodeHostInbound(text: string): HostInbound | null {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    const wire = wireFrameSchema.safeParse(raw);
    if (!wire.success) {
        return null;
    }
    const type = wire.data.header.type;
    if (type === "ready") {
        const parsed = readyFrame.safeParse(raw);
        return parsed.success ? { type: "ready", body: parsed.data.body } : null;
    }
    if (type === "broadcast") {
        const parsed = broadcastRequestFrame.safeParse(raw);
        return parsed.success
            ? { type: "broadcast", id: parsed.data.id, body: parsed.data.body }
            : null;
    }
    if (type === "execute_command") {
        const parsed = executeCommandRequestFrame.safeParse(raw);
        return parsed.success
            ? { type: "execute_command", id: parsed.data.id, body: parsed.data.body }
            : null;
    }
    return null;
}
