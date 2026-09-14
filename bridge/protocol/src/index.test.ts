import { describe, expect, it } from "vitest";

import {
    encodeFrame,
    isProtocolVersionCompatible,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    WS_SUBPROTOCOL,
    wireFrameSchema,
} from "./index.js";

describe("protocol 元信息", () => {
    it("协议名固定为 kurobridge-ws", () => {
        expect(PROTOCOL_NAME).toBe("kurobridge-ws");
    });

    it("版本号与 WS 子协议格式正确（ADR-003：两个独立概念）", () => {
        expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
        expect(WS_SUBPROTOCOL).toMatch(/^kurobridge-ws\.v\d+$/);
    });
});

describe("协议版本兼容判定（v0.3.0，ADR-026：主版本相同即兼容）", () => {
    it("同主版本兼容：0.2.0 对端可连 0.3.0 服务端，补丁位差异同样兼容", () => {
        expect(isProtocolVersionCompatible("0.2.0", PROTOCOL_VERSION)).toBe(true);
        expect(isProtocolVersionCompatible("0.3.0", "0.3.1")).toBe(true);
        expect(isProtocolVersionCompatible("0.3.0", "0.3.0")).toBe(true);
    });

    it("主版本不同或格式非法均不兼容（防御性兜底：解析失败按不兼容处理）", () => {
        expect(isProtocolVersionCompatible("1.0.0", "0.3.0")).toBe(false);
        expect(isProtocolVersionCompatible("0.3.0", "1.0.0")).toBe(false);
        expect(isProtocolVersionCompatible("0.3", "0.3.0")).toBe(false);
        expect(isProtocolVersionCompatible("latest", "0.3.0")).toBe(false);
        expect(isProtocolVersionCompatible("", "0.3.0")).toBe(false);
    });
});

describe("通用线格式帧 wireFrameSchema（v0.3.0 两段式解析第一段）", () => {
    it("只约束骨架：type 受 snake_case、id 可选（存在时须 UUID）、body 任意", () => {
        expect(
            wireFrameSchema.safeParse({
                header: { type: "anything_new" },
                body: { whatever: true },
            }).success,
        ).toBe(true);
        expect(
            wireFrameSchema.safeParse({
                header: { type: "anything_new", id: "123e4567-e89b-12d3-a456-426614174000" },
                body: null,
            }).success,
        ).toBe(true);
        expect(wireFrameSchema.safeParse({ header: { type: "BadType" }, body: {} }).success).toBe(
            false,
        );
        expect(
            wireFrameSchema.safeParse({
                header: { type: "x", id: "not-a-uuid" },
                body: {},
            }).success,
        ).toBe(false);
        expect(wireFrameSchema.safeParse({ header: {}, body: {} }).success).toBe(false);
    });

    it("encodeFrame 出帧省略未定义的 id（JSON 序列化自然丢键）", () => {
        const withId = JSON.parse(
            encodeFrame({
                type: "command_result",
                id: "123e4567-e89b-12d3-a456-426614174000",
                body: { ok: true },
            }),
        );
        expect(withId.header.id).toBe("123e4567-e89b-12d3-a456-426614174000");
        const withoutId = JSON.parse(encodeFrame({ type: "death", body: { ok: 1 } }));
        expect("id" in withoutId.header).toBe(false);
    });
});
