import { describe, expect, it } from "vitest";

import type { GameChatFrame, HelloFrame, PlatformChatFrame } from "./ws.js";
import {
    gameChatFrame,
    helloAckFrame,
    helloFrame,
    pingFrame,
    platformChatFrame,
    pongFrame,
    wsInboundFrame,
    wsOutboundFrame,
} from "./ws.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("WS 侧 hello / hello_ack", () => {
    it("合法 hello 通过，且 id 必填（UUID）", () => {
        const parsed = helloFrame.safeParse({
            header: { type: "hello", id: UUID },
            body: { peerId: "stub", platform: "stub", version: "0.0.1", protocolVersion: "0.1.0" },
        });
        expect(parsed.success).toBe(true);
    });

    it("缺 id 的 hello 被拒（请求帧必须携带 UUID）", () => {
        const parsed = helloFrame.safeParse({
            header: { type: "hello" },
            body: { peerId: "stub", platform: "stub", version: "0.0.1", protocolVersion: "0.1.0" },
        });
        expect(parsed.success).toBe(false);
    });

    it("protocolVersion 非语义化三元组被拒", () => {
        const parsed = helloFrame.safeParse({
            header: { type: "hello", id: UUID },
            body: { peerId: "stub", platform: "stub", version: "0.0.1", protocolVersion: "0.1" },
        });
        expect(parsed.success).toBe(false);
    });

    it("hello_ack ok 分支携带服务端身份，error 分支携带 reason", () => {
        const ok = helloAckFrame.safeParse({
            header: { type: "hello_ack", id: UUID },
            body: { ok: true, serverId: "srv-1", version: "0.1.0", protocolVersion: "0.1.0" },
        });
        expect(ok.success).toBe(true);
        const err = helloAckFrame.safeParse({
            header: { type: "hello_ack", id: UUID },
            body: { ok: false, reason: "protocol mismatch" },
        });
        expect(err.success).toBe(true);
        const bad = helloAckFrame.safeParse({
            header: { type: "hello_ack", id: UUID },
            body: { ok: false },
        });
        expect(bad.success).toBe(false);
    });
});

describe("WS 侧心跳", () => {
    it("ping / pong 均为请求-响应帧（id 必填）", () => {
        expect(
            pingFrame.safeParse({
                header: { type: "ping", id: UUID },
                body: { timestamp: 1700000000000 },
            }).success,
        ).toBe(true);
        expect(
            pongFrame.safeParse({
                header: { type: "pong", id: UUID },
                body: { timestamp: 1700000000000 },
            }).success,
        ).toBe(true);
        expect(
            pingFrame.safeParse({ header: { type: "ping" }, body: { timestamp: 1 } }).success,
        ).toBe(false);
    });
});

describe("WS 侧 chat 双向同型不同体", () => {
    it("游戏聊天（playerName）与平台聊天（sender）各自通过自己的 schema", () => {
        const game: GameChatFrame = {
            header: { type: "chat" },
            body: { playerName: "Steve", content: "hello world" },
        };
        const platform: PlatformChatFrame = {
            header: { type: "chat" },
            body: { sender: "群里的小明", content: "大家好" },
        };
        expect(gameChatFrame.safeParse(game).success).toBe(true);
        expect(platformChatFrame.safeParse(platform).success).toBe(true);
        // 交叉验证失败：方向不同的 body 形状不兼容
        expect(gameChatFrame.safeParse(platform).success).toBe(false);
        expect(platformChatFrame.safeParse(game).success).toBe(false);
    });
});

describe("WS 聚合帧集（按方向收敛）", () => {
    it("服务端收帧集接受 hello/ping/平台 chat，拒绝游戏 chat", () => {
        const hello: HelloFrame = {
            header: { type: "hello", id: UUID },
            body: { peerId: "stub", platform: "stub", version: "0.0.1", protocolVersion: "0.1.0" },
        };
        expect(wsInboundFrame.safeParse(hello).success).toBe(true);
        expect(
            wsInboundFrame.safeParse({
                header: { type: "chat" },
                body: { playerName: "Steve", content: "hi" },
            }).success,
        ).toBe(false);
    });

    it("协议端收帧集接受 hello_ack/pong/游戏 chat，拒绝平台 chat", () => {
        const gameChat: GameChatFrame = {
            header: { type: "chat" },
            body: { playerName: "Steve", content: "hi" },
        };
        expect(wsOutboundFrame.safeParse(gameChat).success).toBe(true);
        expect(
            wsOutboundFrame.safeParse({
                header: { type: "chat" },
                body: { sender: "小明", content: "hi" },
            }).success,
        ).toBe(false);
    });
});
