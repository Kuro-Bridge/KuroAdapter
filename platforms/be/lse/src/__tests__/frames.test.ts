/**
 * 帧编解码契约（裁决册 §4.3 帧面）：
 * - encodeXxx 产物可被协议包对应 zod schema 解析回，且字段语义与裁决册一致
 *   （playerName 取 realName 由调用方保证、死亡 message 恒空串、事件帧 header 严禁 id）。
 * - decodeHostInbound 对 shim→壳三词汇（ready/broadcast/execute_command）返回判别联合；
 *   畸形 JSON / 未知 type / schema 不符一律 null 不抛（两段式解析，ADR-026）。
 */
import {
    broadcastRequestFrame,
    broadcastResultFrame,
    encodeFrame,
    executeCommandResultFrame,
    gameChatEventFrame,
    playerDeathEventFrame,
    playerJoinEventFrame,
    playerQuitEventFrame,
    readyFrame,
} from "@kuro-bridge/protocol";
import { describe, expect, it } from "vitest";

import {
    decodeHostInbound,
    encodeBroadcastResult,
    encodeExecuteCommandResult,
    encodeGameChat,
    encodePlayerDeath,
    encodePlayerJoin,
    encodePlayerQuit,
} from "../frames.js";

const UUID_A = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const UUID_B = "8f14e45f-ea09-4749-b0aa-26b2b6b0d95c";

/** 出帧统一线格式：单行 JSON（一帧一 WS text message），header 只含 type（+请求 id） */
function wireOf(text: string): { header: { type: string; id?: string }; body: unknown } {
    expect(text.includes("\n"), "线格式必须是单行 JSON").toBe(false);
    return JSON.parse(text) as { header: { type: string; id?: string }; body: unknown };
}

describe("事件帧编码（壳→shim，事件 header 严禁 id）", () => {
    it("encodeGameChat：game_chat 帧可被 gameChatEventFrame 解析回，字段一致", () => {
        const wire = wireOf(encodeGameChat("Steve", "hello world"));
        expect(wire.header.type).toBe("game_chat");
        expect(wire.header.id).toBeUndefined();
        const parsed = gameChatEventFrame.safeParse(wire);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data).toEqual({
                type: "game_chat",
                body: { playerName: "Steve", content: "hello world" },
            });
        }
    });

    it("encodePlayerJoin：player_join 帧可被 playerJoinEventFrame 解析回", () => {
        const wire = wireOf(encodePlayerJoin("Alex"));
        expect(wire.header.type).toBe("player_join");
        expect(wire.header.id).toBeUndefined();
        const parsed = playerJoinEventFrame.safeParse(wire);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.body).toEqual({ playerName: "Alex" });
        }
    });

    it("encodePlayerQuit：player_quit 帧可被 playerQuitEventFrame 解析回", () => {
        const wire = wireOf(encodePlayerQuit("Alex"));
        expect(wire.header.type).toBe("player_quit");
        expect(wire.header.id).toBeUndefined();
        const parsed = playerQuitEventFrame.safeParse(wire);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.body).toEqual({ playerName: "Alex" });
        }
    });

    it("encodePlayerDeath：player_death 帧 message 恒空串（裁决册 §5：onPlayerDie 无文案参数）", () => {
        const wire = wireOf(encodePlayerDeath("Steve"));
        expect(wire.header.type).toBe("player_death");
        expect(wire.header.id).toBeUndefined();
        const parsed = playerDeathEventFrame.safeParse(wire);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.body).toEqual({ player: "Steve", message: "" });
        }
    });
});

describe("回执帧编码（壳→shim，响应 header 必须携带同 id）", () => {
    it("encodeBroadcastResult：broadcast_result 恒 ok:true（裁决册 §4.3 立即回执）", () => {
        const wire = wireOf(encodeBroadcastResult(UUID_A));
        const parsed = broadcastResultFrame.safeParse(wire);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data).toEqual({
                type: "broadcast_result",
                id: UUID_A,
                body: { ok: true },
            });
        }
    });

    it("encodeExecuteCommandResult：ok 分支带 output 行数组", () => {
        const wire = wireOf(
            encodeExecuteCommandResult(UUID_A, { ok: true, output: ["line1", "line2"] }),
        );
        const parsed = executeCommandResultFrame.safeParse(wire);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data).toEqual({
                type: "execute_command_result",
                id: UUID_A,
                body: { ok: true, output: ["line1", "line2"] },
            });
        }
    });

    it("encodeExecuteCommandResult：error 分支（ok:false + error 文本）", () => {
        const wire = wireOf(encodeExecuteCommandResult(UUID_B, { ok: false, error: "boom" }));
        const parsed = executeCommandResultFrame.safeParse(wire);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.body).toEqual({ ok: false, error: "boom" });
        }
    });
});

describe("decodeHostInbound：shim→壳 判别联合", () => {
    it("ready 帧：缺省无 autoRestart；携带 autoRestart 一并透传", () => {
        const plain = decodeHostInbound(encodeFrame({ type: "ready", body: { wsPort: 34567 } }));
        expect(plain).toEqual({ type: "ready", body: { wsPort: 34567 } });
        const full = decodeHostInbound(
            encodeFrame({ type: "ready", body: { wsPort: 1, autoRestart: false } }),
        );
        expect(full).toEqual({ type: "ready", body: { wsPort: 1, autoRestart: false } });
        const parsed = readyFrame.safeParse(
            JSON.parse(encodeFrame({ type: "ready", body: { wsPort: 2 } })),
        );
        expect(parsed.success).toBe(true);
    });

    it("broadcast 帧：返回带 id 的 broadcast 判别支", () => {
        const decoded = decodeHostInbound(
            encodeFrame({
                type: "broadcast",
                id: UUID_A,
                body: { channel: "114514", message: "hi" },
            }),
        );
        expect(decoded).toEqual({
            type: "broadcast",
            id: UUID_A,
            body: { channel: "114514", message: "hi" },
        });
    });

    it("execute_command 帧：返回带 id 的 execute_command 判别支", () => {
        const decoded = decodeHostInbound(
            encodeFrame({ type: "execute_command", id: UUID_B, body: { command: "list" } }),
        );
        expect(decoded).toEqual({ type: "execute_command", id: UUID_B, body: { command: "list" } });
    });

    it("broadcast 请求可被协议包 broadcastRequestFrame 解析回（词汇同一 SSOT）", () => {
        const text = encodeFrame({
            type: "broadcast",
            id: UUID_A,
            body: { channel: "c", message: "m" },
        });
        const parsed = broadcastRequestFrame.safeParse(JSON.parse(text));
        expect(parsed.success).toBe(true);
    });
});

describe("decodeHostInbound：畸形输入一律 null 不抛", () => {
    it("非合法 JSON → null", () => {
        expect(decodeHostInbound("{nope")).toBeNull();
        expect(decodeHostInbound("")).toBeNull();
    });

    it("非对象 JSON（标量/数组）→ null", () => {
        expect(decodeHostInbound("42")).toBeNull();
        expect(decodeHostInbound('"text"')).toBeNull();
        expect(decodeHostInbound("[]")).toBeNull();
        expect(decodeHostInbound("null")).toBeNull();
    });

    it("缺 header / header 缺 type → null", () => {
        expect(decodeHostInbound(JSON.stringify({ body: { wsPort: 1 } }))).toBeNull();
        expect(decodeHostInbound(JSON.stringify({ header: {}, body: {} }))).toBeNull();
    });

    it("未知 type（不在 shim→壳词汇集）→ null", () => {
        expect(
            decodeHostInbound(JSON.stringify({ header: { type: "mystery" }, body: {} })),
        ).toBeNull();
        // game_chat 是壳→shim 方向词汇，出现在入站面同样拒收
        expect(
            decodeHostInbound(
                encodeFrame({ type: "game_chat", body: { playerName: "Steve", content: "hi" } }),
            ),
        ).toBeNull();
    });

    it("schema 不符 → null（ready.wsPort 非数值 / 请求缺 UUID id / body 缺字段）", () => {
        expect(
            decodeHostInbound(encodeFrame({ type: "ready", body: { wsPort: "abc" } })),
        ).toBeNull();
        expect(
            decodeHostInbound(
                encodeFrame({ type: "broadcast", body: { channel: "c", message: "m" } }),
            ),
        ).toBeNull();
        expect(
            decodeHostInbound(
                encodeFrame({
                    type: "broadcast",
                    id: "not-a-uuid",
                    body: { channel: "c", message: "m" },
                }),
            ),
        ).toBeNull();
        expect(
            decodeHostInbound(encodeFrame({ type: "execute_command", id: UUID_A, body: {} })),
        ).toBeNull();
    });
});
