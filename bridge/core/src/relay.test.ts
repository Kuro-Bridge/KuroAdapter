import { PROTOCOL_VERSION } from "@kurobot/protocol";
import { describe, expect, it } from "vitest";

import { IpcRequestError, Relay } from "./relay.js";
import { KurobotServer } from "./server.js";
import {
    FakeIpc,
    FakeLogger,
    FakeWsConnection,
    FakeWsServer,
    makeContext,
    sequentialIdFactory,
} from "./test-fakes.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
/** 与 relay.ts 的假规则占位频道一致（阶段 3 替换为绑定表） */
const FANOUT_CHANNEL = "spike";

function helloText(): string {
    return JSON.stringify({
        header: { type: "hello", id: UUID },
        body: {
            peerId: "peer-1",
            platform: "stub",
            version: "0.0.1",
            protocolVersion: PROTOCOL_VERSION,
        },
    });
}

interface Fixture {
    relay: Relay;
    ws: FakeWsServer;
    ipc: FakeIpc;
    logger: FakeLogger;
    conn: FakeWsConnection;
    shutdownReasons: string[];
}

function makeFixture(): Fixture {
    const logger = new FakeLogger();
    const ws = new FakeWsServer();
    const ipc = new FakeIpc();
    const context = makeContext({ logger, newRequestId: sequentialIdFactory() });
    const server = new KurobotServer({
        context,
        wsServer: ws,
        channelBindings: () => [],
    });
    const shutdownReasons: string[] = [];
    const relay = new Relay({
        context,
        server,
        ipc,
        onShutdown: (reason) => {
            shutdownReasons.push(reason);
        },
    });
    const conn = new FakeWsConnection();
    ws.accept(conn);
    conn.receive(helloText());
    return { relay, ws, ipc, logger, conn, shutdownReasons };
}

/** 从 ipc 发出的请求帧里取第 index 个 id（保证回应与请求关联） */
function requestIdAt(ipc: FakeIpc, index: number): string {
    const frame = JSON.parse(ipc.sent[index] ?? "{}");
    return frame.header.id as string;
}

function resultText(id: string, ok: boolean, error?: string): string {
    const body = ok ? { ok: true } : { ok: false, error: error ?? "unknown" };
    return JSON.stringify({ header: { type: "broadcast_result", id }, body });
}

describe("Relay 游戏 → 平台", () => {
    it("IPC game_chat → WS chat（占位频道假规则）推给已握手对端", () => {
        const { ipc, conn } = makeFixture();
        ipc.receive(
            JSON.stringify({
                header: { type: "game_chat" },
                body: { playerName: "Steve", content: "yo" },
            }),
        );

        const chat = JSON.parse(conn.sent[1] ?? "{}");
        expect(chat).toEqual({
            header: { type: "chat" },
            body: { channel: FANOUT_CHANNEL, playerName: "Steve", content: "yo" },
        });
    });

    it("IPC player_join / player_quit → WS join / leave（占位频道假规则）", () => {
        const { ipc, conn } = makeFixture();
        ipc.receive(
            JSON.stringify({ header: { type: "player_join" }, body: { playerName: "Steve" } }),
        );
        ipc.receive(
            JSON.stringify({ header: { type: "player_quit" }, body: { playerName: "Steve" } }),
        );

        const join = JSON.parse(conn.sent[1] ?? "{}");
        const leave = JSON.parse(conn.sent[2] ?? "{}");
        expect(join).toEqual({
            header: { type: "join" },
            body: { channel: FANOUT_CHANNEL, playerName: "Steve" },
        });
        expect(leave).toEqual({
            header: { type: "leave" },
            body: { channel: FANOUT_CHANNEL, playerName: "Steve" },
        });
    });

    it("IPC status → WS status 原样中继", () => {
        const { ipc, conn } = makeFixture();
        ipc.receive(
            JSON.stringify({
                header: { type: "status" },
                body: { tps: 20, onlinePlayers: 1, uptimeSeconds: 42 },
            }),
        );

        const status = JSON.parse(conn.sent[1] ?? "{}");
        expect(status).toEqual({
            header: { type: "status" },
            body: { tps: 20, onlinePlayers: 1, uptimeSeconds: 42 },
        });
    });

    it("坏帧丢弃并告警，不崩", () => {
        const { ipc, logger, conn } = makeFixture();
        ipc.receive("garbage");
        ipc.receive(JSON.stringify({ header: { type: "ready" }, body: { wsPort: 1 } }));

        expect(conn.sent).toHaveLength(1); // 只有 hello_ack
        expect(logger.warns).toHaveLength(2);
    });
});

describe("Relay 平台 → 游戏（broadcast 请求-响应）", () => {
    it("forwardToGame 发出携带 channel 的 broadcast 请求；result ok → promise 解决", async () => {
        const { relay, ipc } = makeFixture();
        const promise = relay.forwardToGame({
            channel: "10001",
            sender: "小明",
            content: "大家好",
        });

        expect(ipc.sent).toHaveLength(1);
        const requestId = requestIdAt(ipc, 0);
        expect(JSON.parse(ipc.sent[0] ?? "{}")).toEqual({
            header: { type: "broadcast", id: requestId },
            body: { channel: "10001", message: "<小明> 大家好" },
        });

        ipc.receive(resultText(requestId, true));
        await expect(promise).resolves.toEqual({ ok: true });
    });

    it("result error → promise 以 IpcRequestError 拒绝", async () => {
        const { relay, ipc } = makeFixture();
        const promise = relay.forwardToGame({ channel: "10001", sender: "a", content: "b" });
        ipc.receive(resultText(requestIdAt(ipc, 0), false, "no players"));

        await expect(promise).rejects.toBeInstanceOf(IpcRequestError);
        await expect(promise).rejects.toMatchObject({ reason: "no players" });
    });

    it("WS 平台 chat 自动触发 broadcast（组装路径）；失败被捕获进日志不外泄", async () => {
        const { ipc, conn, logger } = makeFixture();
        conn.receive(
            JSON.stringify({
                header: { type: "chat" },
                body: { channel: "10001", sender: "小明", content: "大家好" },
            }),
        );
        expect(ipc.sent).toHaveLength(1);

        ipc.receive(resultText(requestIdAt(ipc, 0), false, "boom"));
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        expect(logger.errors).toHaveLength(1);
    });

    it("IPC 断开 → 在途请求全部拒绝；之后新请求立即拒绝", async () => {
        const { relay, ipc } = makeFixture();
        const first = relay.forwardToGame({ channel: "10001", sender: "a", content: "b" });
        const second = relay.forwardToGame({ channel: "10001", sender: "c", content: "d" });
        ipc.emitClose();

        await expect(first).rejects.toBeInstanceOf(IpcRequestError);
        await expect(second).rejects.toBeInstanceOf(IpcRequestError);
        await expect(
            relay.forwardToGame({ channel: "10001", sender: "e", content: "f" }),
        ).rejects.toBeInstanceOf(IpcRequestError);
    });
});

describe("Relay 关机", () => {
    it("shutdown 帧 → onShutdown 收到 reason", () => {
        const { ipc, shutdownReasons } = makeFixture();
        ipc.receive(
            JSON.stringify({ header: { type: "shutdown" }, body: { reason: "plugin disable" } }),
        );
        expect(shutdownReasons).toEqual(["plugin disable"]);
    });

    it("dispose 后丢弃后续 IPC 帧", () => {
        const { relay, ipc, conn } = makeFixture();
        relay.dispose();
        ipc.receive(
            JSON.stringify({
                header: { type: "game_chat" },
                body: { playerName: "x", content: "y" },
            }),
        );
        expect(conn.sent).toHaveLength(1); // 只有 hello_ack
    });
});
