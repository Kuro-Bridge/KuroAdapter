import { describe, expect, it } from "vitest";

import {
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
} from "./ipc.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("IPC ready（Node→Java）", () => {
    it("携带正整数端口，事件帧无 id", () => {
        expect(
            readyFrame.safeParse({ header: { type: "ready" }, body: { wsPort: 34567 } }).success,
        ).toBe(true);
        expect(
            readyFrame.safeParse({ header: { type: "ready" }, body: { wsPort: 0 } }).success,
        ).toBe(false);
        expect(
            readyFrame.safeParse({ header: { type: "ready", id: UUID }, body: { wsPort: 1 } })
                .success,
        ).toBe(false);
    });
});

describe("IPC 请求-响应（UUID 关联）", () => {
    it("broadcast / execute_command 请求必须带 id；broadcast 携带 channel（v0.2）", () => {
        expect(
            broadcastRequestFrame.safeParse({
                header: { type: "broadcast", id: UUID },
                body: { channel: "10001", message: "hi" },
            }).success,
        ).toBe(true);
        expect(
            executeCommandRequestFrame.safeParse({
                header: { type: "execute_command", id: UUID },
                body: { command: "list" },
            }).success,
        ).toBe(true);
        expect(
            broadcastRequestFrame.safeParse({
                header: { type: "broadcast" },
                body: { channel: "10001", message: "hi" },
            }).success,
        ).toBe(false);
        expect(
            broadcastRequestFrame.safeParse({
                header: { type: "broadcast", id: UUID },
                body: { message: "hi" },
            }).success,
        ).toBe(false);
    });

    it("result 帧接受 ok 与 ok+error 两种，拒绝裸 false", () => {
        const ok = { header: { type: "broadcast_result", id: UUID }, body: { ok: true } };
        const err = {
            header: { type: "broadcast_result", id: UUID },
            body: { ok: false, error: "no players" },
        };
        const bad = { header: { type: "broadcast_result", id: UUID }, body: { ok: false } };
        expect(broadcastResultFrame.safeParse(ok).success).toBe(true);
        expect(broadcastResultFrame.safeParse(err).success).toBe(true);
        expect(broadcastResultFrame.safeParse(bad).success).toBe(false);
        expect(
            executeCommandResultFrame.safeParse({
                header: { type: "execute_command_result", id: UUID },
                body: { ok: true },
            }).success,
        ).toBe(true);
    });
});

describe("IPC 事件（Java→Node）", () => {
    it("game_chat / shutdown 均为无 id 事件", () => {
        expect(
            gameChatEventFrame.safeParse({
                header: { type: "game_chat" },
                body: { playerName: "Alex", content: "yo" },
            }).success,
        ).toBe(true);
        expect(
            shutdownFrame.safeParse({
                header: { type: "shutdown" },
                body: { reason: "plugin disable" },
            }).success,
        ).toBe(true);
        expect(shutdownFrame.safeParse({ header: { type: "shutdown" }, body: {} }).success).toBe(
            false,
        );
    });

    it("player_join / player_quit 携带 playerName（v0.2，无 channel——fan-out 是 Node 侧业务）", () => {
        expect(
            playerJoinEventFrame.safeParse({
                header: { type: "player_join" },
                body: { playerName: "Alex" },
            }).success,
        ).toBe(true);
        expect(
            playerQuitEventFrame.safeParse({
                header: { type: "player_quit" },
                body: { playerName: "Alex" },
            }).success,
        ).toBe(true);
        expect(
            playerJoinEventFrame.safeParse({
                header: { type: "player_join", id: UUID },
                body: { playerName: "Alex" },
            }).success,
        ).toBe(false);
    });

    it("status 事件与 WS status body 同构", () => {
        expect(
            statusEventFrame.safeParse({
                header: { type: "status" },
                body: { tps: 19.9, onlinePlayers: 2, uptimeSeconds: 600 },
            }).success,
        ).toBe(true);
        expect(
            statusEventFrame.safeParse({
                header: { type: "status" },
                body: { tps: 19.9, onlinePlayers: -1, uptimeSeconds: 600 },
            }).success,
        ).toBe(false);
    });
});

describe("IPC 聚合帧集（按进程侧收敛）", () => {
    it("Java 收帧集只接受 Node 发出的帧", () => {
        expect(
            ipcJavaInboundFrame.safeParse({ header: { type: "ready" }, body: { wsPort: 80 } })
                .success,
        ).toBe(true);
        expect(
            ipcJavaInboundFrame.safeParse({ header: { type: "shutdown" }, body: { reason: "x" } })
                .success,
        ).toBe(false);
    });

    it("Node 收帧集只接受 Java 发出的帧（含 v0.2 新事件）", () => {
        expect(
            ipcNodeInboundFrame.safeParse({
                header: { type: "game_chat" },
                body: { playerName: "A", content: "b" },
            }).success,
        ).toBe(true);
        expect(
            ipcNodeInboundFrame.safeParse({ header: { type: "ready" }, body: { wsPort: 80 } })
                .success,
        ).toBe(false);
        expect(
            ipcNodeInboundFrame.safeParse({
                header: { type: "player_join" },
                body: { playerName: "A" },
            }).success,
        ).toBe(true);
        expect(
            ipcNodeInboundFrame.safeParse({
                header: { type: "player_quit" },
                body: { playerName: "A" },
            }).success,
        ).toBe(true);
        expect(
            ipcNodeInboundFrame.safeParse({
                header: { type: "status" },
                body: { tps: 20, onlinePlayers: 1, uptimeSeconds: 1 },
            }).success,
        ).toBe(true);
    });
});
