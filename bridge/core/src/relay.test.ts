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
    manualTime,
    sequentialIdFactory,
} from "./test-fakes.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
/** 与 relay.ts 的假规则占位频道一致（阶段 3 替换为绑定表） */
const FANOUT_CHANNEL = "spike";
/** 测试用 IPC 请求超时（远小于默认值） */
const IPC_TIMEOUT_MS = 500;

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
    time: ReturnType<typeof manualTime>;
}

function makeFixture(ipcRequestTimeoutMs?: number): Fixture {
    const logger = new FakeLogger();
    const ws = new FakeWsServer();
    const ipc = new FakeIpc();
    const time = manualTime();
    const context = makeContext({
        logger,
        newRequestId: sequentialIdFactory(),
        clock: time.clock,
        scheduler: time.scheduler,
    });
    const server = new KurobotServer({
        context,
        wsServer: ws,
        channelBindings: () => [],
        // 关闭 server 侧超时：本文件只测 Relay 的定时器（pendingCount 断言不混入 server 任务）
        timeouts: { helloTimeoutMs: 0, idleTimeoutMs: 0 },
    });
    const shutdownReasons: string[] = [];
    const relay = new Relay({
        context,
        server,
        ipc,
        onShutdown: (reason) => {
            shutdownReasons.push(reason);
        },
        ...(ipcRequestTimeoutMs === undefined ? {} : { ipcRequestTimeoutMs }),
    });
    const conn = new FakeWsConnection();
    ws.accept(conn);
    conn.receive(helloText());
    return { relay, ws, ipc, logger, conn, shutdownReasons, time };
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

    it("IPC 断开后定时器无泄漏", () => {
        const { relay, ipc, time } = makeFixture(IPC_TIMEOUT_MS);
        void relay
            .forwardToGame({ channel: "10001", sender: "a", content: "b" })
            .catch(() => undefined);
        ipc.emitClose();

        expect(time.scheduler.pendingCount).toBe(0);
    });
});

describe("Relay IPC 请求超时（对齐 Java 侧 10s 语义）", () => {
    it("无响应 → 超时以 IpcRequestError 拒绝；迟到的响应被忽略不崩", async () => {
        const { relay, ipc, logger, time } = makeFixture(IPC_TIMEOUT_MS);
        const promise = relay.forwardToGame({ channel: "10001", sender: "a", content: "b" });

        time.scheduler.advance(IPC_TIMEOUT_MS - 1);
        time.scheduler.advance(1);
        await expect(promise).rejects.toMatchObject({
            name: "IpcRequestError",
            reason: expect.stringContaining("超时"),
        });

        // 迟到的响应：id 已不在途 → 告警忽略
        const requestId = JSON.parse(ipc.sent[0] ?? "{}").header.id as string;
        ipc.receive(resultText(requestId, true));
        expect(logger.warns.some((w) => w.includes("无在途请求"))).toBe(true);
    });

    it("响应及时到达 → 超时定时器被取消", async () => {
        const { relay, ipc, time } = makeFixture(IPC_TIMEOUT_MS);
        const promise = relay.forwardToGame({ channel: "10001", sender: "a", content: "b" });
        ipc.receive(resultText(requestIdAt(ipc, 0), true));
        await expect(promise).resolves.toEqual({ ok: true });

        time.scheduler.advance(IPC_TIMEOUT_MS * 3);
        expect(time.scheduler.pendingCount).toBe(0);
    });

    it("ipcRequestTimeoutMs=0 禁用超时", async () => {
        const { relay, time } = makeFixture(0);
        void relay
            .forwardToGame({ channel: "10001", sender: "a", content: "b" })
            .catch(() => undefined);

        time.scheduler.advance(1_000_000);
        // promise 仍悬挂（不因超时拒绝）——用 pendingCount 断言无调度
        expect(time.scheduler.pendingCount).toBe(0);
    });
});

describe("Relay IPC 健康观测（候选 E）", () => {
    it("ipcOpen：初始 true，IPC 断开 / dispose 后 false", () => {
        const { relay, ipc } = makeFixture();
        expect(relay.ipcOpen).toBe(true);

        ipc.emitClose();
        expect(relay.ipcOpen).toBe(false);
    });

    it("dispose 后 ipcOpen 为 false（不再接受新请求）", () => {
        const { relay } = makeFixture();
        relay.dispose();
        expect(relay.ipcOpen).toBe(false);
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
