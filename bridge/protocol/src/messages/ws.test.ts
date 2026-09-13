import { describe, expect, it } from "vitest";

import {
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
    wsInboundFrame,
    wsOutboundFrame,
} from "./ws.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("WS 侧 hello / hello_ack", () => {
    it("合法 hello 通过，且 id 必填（UUID）", () => {
        const parsed = helloFrame.safeParse({
            header: { type: "hello", id: UUID },
            body: { peerId: "stub", platform: "stub", version: "0.0.1", protocolVersion: "0.2.0" },
        });
        expect(parsed.success).toBe(true);
    });

    it("缺 id 的 hello 被拒（请求帧必须携带 UUID）", () => {
        const parsed = helloFrame.safeParse({
            header: { type: "hello" },
            body: { peerId: "stub", platform: "stub", version: "0.0.1", protocolVersion: "0.2.0" },
        });
        expect(parsed.success).toBe(false);
    });

    it("protocolVersion 非语义化三元组被拒", () => {
        const parsed = helloFrame.safeParse({
            header: { type: "hello", id: UUID },
            body: { peerId: "stub", platform: "stub", version: "0.0.1", protocolVersion: "0.2" },
        });
        expect(parsed.success).toBe(false);
    });

    it("hello_ack ok 携带服务端身份与 channelBindings；error 携带 reason", () => {
        const ok = helloAckFrame.safeParse({
            header: { type: "hello_ack", id: UUID },
            body: {
                ok: true,
                serverId: "srv-1",
                version: "0.1.0",
                protocolVersion: "0.2.0",
                channelBindings: ["10001", "10002"],
            },
        });
        expect(ok.success).toBe(true);
        const emptyBindings = helloAckFrame.safeParse({
            header: { type: "hello_ack", id: UUID },
            body: {
                ok: true,
                serverId: "srv-1",
                version: "0.1.0",
                protocolVersion: "0.2.0",
                channelBindings: [],
            },
        });
        expect(emptyBindings.success).toBe(true);
        const err = helloAckFrame.safeParse({
            header: { type: "hello_ack", id: UUID },
            body: { ok: false, reason: "protocol mismatch" },
        });
        expect(err.success).toBe(true);
        const missingBindings = helloAckFrame.safeParse({
            header: { type: "hello_ack", id: UUID },
            body: { ok: true, serverId: "srv-1", version: "0.1.0", protocolVersion: "0.2.0" },
        });
        expect(missingBindings.success).toBe(false);
        const bad = helloAckFrame.safeParse({
            header: { type: "hello_ack", id: UUID },
            body: { ok: false },
        });
        expect(bad.success).toBe(false);
    });

    it("hello 的 token 可选（v0.3.0）：携带与缺省均合法，非字符串被拒", () => {
        const base = {
            peerId: "stub",
            platform: "stub",
            version: "0.0.1",
            protocolVersion: "0.3.0",
        };
        expect(
            helloFrame.safeParse({ header: { type: "hello", id: UUID }, body: base }).success,
        ).toBe(true);
        expect(
            helloFrame.safeParse({
                header: { type: "hello", id: UUID },
                body: { ...base, token: "s3cret" },
            }).success,
        ).toBe(true);
        expect(
            helloFrame.safeParse({
                header: { type: "hello", id: UUID },
                body: { ...base, token: 123 },
            }).success,
        ).toBe(false);
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

describe("WS 侧 chat 双向同型不同体（v0.2 携带 channel）", () => {
    it("游戏聊天（channel+playerName）与平台聊天（channel+sender）各自通过自己的 schema", () => {
        const game = {
            header: { type: "chat" },
            body: { channel: "10001", playerName: "Steve", content: "hello world" },
        };
        const platform = {
            header: { type: "chat" },
            body: { channel: "10001", sender: "群里的小明", content: "大家好" },
        };
        expect(gameChatFrame.safeParse(game).success).toBe(true);
        expect(platformChatFrame.safeParse(platform).success).toBe(true);
        // 交叉验证失败：方向不同的 body 形状不兼容
        expect(gameChatFrame.safeParse(platform).success).toBe(false);
        expect(platformChatFrame.safeParse(game).success).toBe(false);
        // 缺 channel 被拒
        expect(
            platformChatFrame.safeParse({
                header: { type: "chat" },
                body: { sender: "小明", content: "大家好" },
            }).success,
        ).toBe(false);
    });
});

describe("WS 侧 v0.2 新事件（Server→Peer，均无 id）", () => {
    it("join / leave 携带 channel + playerName", () => {
        const join = { header: { type: "join" }, body: { channel: "10001", playerName: "Steve" } };
        const leave = {
            header: { type: "leave" },
            body: { channel: "10001", playerName: "Steve" },
        };
        expect(joinFrame.safeParse(join).success).toBe(true);
        expect(leaveFrame.safeParse(leave).success).toBe(true);
        expect(
            joinFrame.safeParse({ header: { type: "join", id: UUID }, body: join.body }).success,
        ).toBe(false);
        expect(
            joinFrame.safeParse({ header: { type: "join" }, body: { playerName: "Steve" } })
                .success,
        ).toBe(false);
    });

    it("status 携带 tps / onlinePlayers / uptimeSeconds，数值约束生效", () => {
        const ok = {
            header: { type: "status" },
            body: { tps: 19.5, onlinePlayers: 3, uptimeSeconds: 12345 },
        };
        expect(statusFrame.safeParse(ok).success).toBe(true);
        expect(
            statusFrame.safeParse({
                header: { type: "status" },
                body: { tps: -1, onlinePlayers: 3, uptimeSeconds: 1 },
            }).success,
        ).toBe(false);
        expect(
            statusFrame.safeParse({
                header: { type: "status" },
                body: { tps: 19.5, onlinePlayers: 1.5, uptimeSeconds: 1 },
            }).success,
        ).toBe(false);
    });

    it("bindings_updated 携带完整绑定列表", () => {
        const frame = {
            header: { type: "bindings_updated" },
            body: { channelBindings: ["10001"] },
        };
        expect(bindingsUpdatedFrame.safeParse(frame).success).toBe(true);
        expect(
            bindingsUpdatedFrame.safeParse({ header: { type: "bindings_updated" }, body: {} })
                .success,
        ).toBe(false);
    });

    it("death 携带 channel + player + message；message 允许空串（deathMessage 可为 null）", () => {
        expect(
            deathFrame.safeParse({
                header: { type: "death" },
                body: { channel: "10001", player: "Steve", message: "Steve 掉进了虚空" },
            }).success,
        ).toBe(true);
        expect(
            deathFrame.safeParse({
                header: { type: "death" },
                body: { channel: "10001", player: "Steve", message: "" },
            }).success,
        ).toBe(true);
        expect(
            deathFrame.safeParse({
                header: { type: "death" },
                body: { channel: "10001", playerName: "Steve", message: "" },
            }).success,
        ).toBe(false);
        expect(
            deathFrame.safeParse({
                header: { type: "death", id: UUID },
                body: { channel: "10001", player: "Steve", message: "" },
            }).success,
        ).toBe(false);
    });
});

describe("WS 侧 v0.3.0 请求族（Peer→Server）", () => {
    it("command 请求：command + source{channel,userId} 必填；source 缺失被拒", () => {
        const ok = {
            header: { type: "command", id: UUID },
            body: {
                command: "whitelist list",
                source: { channel: "stub-channel", userId: "stub-admin" },
            },
        };
        expect(commandFrame.safeParse(ok).success).toBe(true);
        expect(
            commandFrame.safeParse({
                header: { type: "command", id: UUID },
                body: { command: "whitelist list" },
            }).success,
        ).toBe(false);
        expect(
            commandFrame.safeParse({
                header: { type: "command", id: UUID },
                body: {
                    command: "whitelist list",
                    source: { channel: "stub-channel", userId: "" },
                },
            }).success,
        ).toBe(false);
        expect(
            commandFrame.safeParse({
                header: { type: "command" },
                body: {
                    command: "whitelist list",
                    source: { channel: "stub-channel", userId: "u" },
                },
            }).success,
        ).toBe(false);
    });

    it("query 请求：kind 仅接受 status / bindings", () => {
        expect(
            queryFrame.safeParse({ header: { type: "query", id: UUID }, body: { kind: "status" } })
                .success,
        ).toBe(true);
        expect(
            queryFrame.safeParse({
                header: { type: "query", id: UUID },
                body: { kind: "bindings" },
            }).success,
        ).toBe(true);
        expect(
            queryFrame.safeParse({
                header: { type: "query", id: UUID },
                body: { kind: "whitelist" },
            }).success,
        ).toBe(false);
    });

    it("command_result：ok 体可带 output 行数组，error 体要求非空 error", () => {
        expect(
            commandResultFrame.safeParse({
                header: { type: "command_result", id: UUID },
                body: { ok: true, output: ["Steve, Herobrine"] },
            }).success,
        ).toBe(true);
        expect(
            commandResultFrame.safeParse({
                header: { type: "command_result", id: UUID },
                body: { ok: true },
            }).success,
        ).toBe(true);
        expect(
            commandResultFrame.safeParse({
                header: { type: "command_result", id: UUID },
                body: { ok: false, error: "forbidden" },
            }).success,
        ).toBe(true);
        expect(
            commandResultFrame.safeParse({
                header: { type: "command_result", id: UUID },
                body: { ok: false },
            }).success,
        ).toBe(false);
    });

    it("query_result：ok 体携带任意 data，error 体要求非空 error", () => {
        expect(
            queryResultFrame.safeParse({
                header: { type: "query_result", id: UUID },
                body: { ok: true, data: { tps: 20, onlinePlayers: 0, uptimeSeconds: 60 } },
            }).success,
        ).toBe(true);
        expect(
            queryResultFrame.safeParse({
                header: { type: "query_result", id: UUID },
                body: { ok: true, data: ["stub-channel"] },
            }).success,
        ).toBe(true);
        expect(
            queryResultFrame.safeParse({
                header: { type: "query_result", id: UUID },
                body: { ok: false, error: "no status yet" },
            }).success,
        ).toBe(true);
        expect(
            queryResultFrame.safeParse({
                header: { type: "query_result", id: UUID },
                body: { ok: true },
            }).success,
        ).toBe(false);
    });
});

describe("WS 聚合帧集（按方向收敛）", () => {
    it("服务端收帧集接受 hello/ping/平台 chat，拒绝游戏 chat 与新事件（Server→Peer 方向）", () => {
        const hello = {
            header: { type: "hello", id: UUID },
            body: { peerId: "stub", platform: "stub", version: "0.0.1", protocolVersion: "0.2.0" },
        };
        expect(wsInboundFrame.safeParse(hello).success).toBe(true);
        expect(
            wsInboundFrame.safeParse({
                header: { type: "chat" },
                body: { channel: "10001", playerName: "Steve", content: "hi" },
            }).success,
        ).toBe(false);
        expect(
            wsInboundFrame.safeParse({
                header: { type: "bindings_updated" },
                body: { channelBindings: [] },
            }).success,
        ).toBe(false);
    });

    it("协议端收帧集接受 hello_ack/pong/游戏 chat 与全部 v0.2 新事件，拒绝平台 chat", () => {
        const gameChat = {
            header: { type: "chat" },
            body: { channel: "10001", playerName: "Steve", content: "hi" },
        };
        expect(wsOutboundFrame.safeParse(gameChat).success).toBe(true);
        expect(
            wsOutboundFrame.safeParse({
                header: { type: "chat" },
                body: { channel: "10001", sender: "小明", content: "hi" },
            }).success,
        ).toBe(false);
        expect(
            wsOutboundFrame.safeParse({
                header: { type: "join" },
                body: { channel: "10001", playerName: "Steve" },
            }).success,
        ).toBe(true);
        expect(
            wsOutboundFrame.safeParse({
                header: { type: "leave" },
                body: { channel: "10001", playerName: "Steve" },
            }).success,
        ).toBe(true);
        expect(
            wsOutboundFrame.safeParse({
                header: { type: "status" },
                body: { tps: 20, onlinePlayers: 0, uptimeSeconds: 60 },
            }).success,
        ).toBe(true);
        expect(
            wsOutboundFrame.safeParse({
                header: { type: "bindings_updated" },
                body: { channelBindings: ["10001"] },
            }).success,
        ).toBe(true);
    });

    it("服务端收帧集接受 v0.3.0 command/query 请求；协议端收帧集接受其响应与 death", () => {
        expect(
            wsInboundFrame.safeParse({
                header: { type: "command", id: UUID },
                body: {
                    command: "whitelist list",
                    source: { channel: "stub-channel", userId: "stub-admin" },
                },
            }).success,
        ).toBe(true);
        expect(
            wsInboundFrame.safeParse({
                header: { type: "query", id: UUID },
                body: { kind: "bindings" },
            }).success,
        ).toBe(true);
        expect(
            wsOutboundFrame.safeParse({
                header: { type: "command_result", id: UUID },
                body: { ok: true, output: [] },
            }).success,
        ).toBe(true);
        expect(
            wsOutboundFrame.safeParse({
                header: { type: "query_result", id: UUID },
                body: { ok: true, data: [] },
            }).success,
        ).toBe(true);
        expect(
            wsOutboundFrame.safeParse({
                header: { type: "death" },
                body: { channel: "10001", player: "Steve", message: "boom" },
            }).success,
        ).toBe(true);
    });
});
