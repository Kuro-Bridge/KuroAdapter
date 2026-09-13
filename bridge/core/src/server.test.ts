import { PROTOCOL_VERSION } from "@kurobot/protocol";
import { describe, expect, it } from "vitest";

import { KurobotServer, type ServerTimeouts } from "./server.js";
import {
    FakeLogger,
    FakeWsConnection,
    FakeWsServer,
    makeContext,
    manualTime,
} from "./test-fakes.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const CHANNELS = ["10001", "10002"];
/** 测试用阈值（远小于默认值，手动推进即可覆盖边界） */
const T = { helloTimeoutMs: 10_000, idleTimeoutMs: 30_000 };

function helloText(protocolVersion: string = PROTOCOL_VERSION): string {
    return JSON.stringify({
        header: { type: "hello", id: UUID },
        body: { peerId: "peer-1", platform: "stub", version: "0.0.1", protocolVersion },
    });
}

interface ServerFixture {
    server: KurobotServer;
    ws: FakeWsServer;
    logger: FakeLogger;
    time: ReturnType<typeof manualTime>;
}

function makeServer(timeouts?: ServerTimeouts): ServerFixture {
    const logger = new FakeLogger();
    const ws = new FakeWsServer();
    const time = manualTime();
    const context = makeContext({ logger, clock: time.clock, scheduler: time.scheduler });
    const server = new KurobotServer({
        context,
        wsServer: ws,
        channelBindings: () => CHANNELS,
        ...(timeouts === undefined ? {} : { timeouts }),
    });
    return { server, ws, logger, time };
}

/** 建立一个已握手连接 */
function establishedConn(ws: FakeWsServer): FakeWsConnection {
    const conn = new FakeWsConnection();
    ws.accept(conn);
    conn.receive(helloText());
    return conn;
}

function pingText(): string {
    return JSON.stringify({ header: { type: "ping", id: UUID }, body: { timestamp: 1 } });
}

describe("KurobotServer 握手", () => {
    it("合法 hello → hello_ack ok（携带服务端身份与 channelBindings）", () => {
        const { server, ws } = makeServer();
        const conn = establishedConn(ws);

        expect(server.establishedPeerCount).toBe(1);
        const ack = JSON.parse(conn.sent[0] ?? "{}");
        expect(ack).toEqual({
            header: { type: "hello_ack", id: UUID },
            body: {
                ok: true,
                serverId: "srv-1",
                version: "0.1.0",
                protocolVersion: PROTOCOL_VERSION,
                channelBindings: CHANNELS,
            },
        });
    });

    it("协议版本不匹配 → hello_ack error + 关连接（1002）", () => {
        const { server, ws, logger } = makeServer();
        const conn = new FakeWsConnection();
        ws.accept(conn);
        conn.receive(helloText("9.9.9"));

        expect(server.establishedPeerCount).toBe(0);
        const ack = JSON.parse(conn.sent[0] ?? "{}");
        expect(ack.body.ok).toBe(false);
        expect(ack.body.reason).toContain("mismatch");
        expect(conn.closed?.code).toBe(1002);
        expect(logger.warns.length).toBeGreaterThan(0);
    });

    it("重复 hello 被忽略（不二次握手）", () => {
        const { server, ws } = makeServer();
        const conn = establishedConn(ws);
        conn.receive(helloText());

        expect(server.establishedPeerCount).toBe(1);
        expect(conn.sent.filter((t) => JSON.parse(t).header.type === "hello_ack")).toHaveLength(1);
    });
});

describe("KurobotServer 心跳", () => {
    it("握手后 ping → 同 id pong，回带 timestamp", () => {
        const { ws } = makeServer();
        const conn = establishedConn(ws);
        conn.receive(
            JSON.stringify({ header: { type: "ping", id: UUID }, body: { timestamp: 123456 } }),
        );

        const pong = JSON.parse(conn.sent[1] ?? "{}");
        expect(pong).toEqual({ header: { type: "pong", id: UUID }, body: { timestamp: 123456 } });
    });

    it("握手前 ping 被丢弃", () => {
        const { ws } = makeServer();
        const conn = new FakeWsConnection();
        ws.accept(conn);
        conn.receive(pingText());

        expect(conn.sent).toHaveLength(0);
    });
});

describe("KurobotServer chat 双向", () => {
    it("握手后平台 chat（带 channel）触发 onPlatformChat；握手前丢弃", () => {
        const { server, ws } = makeServer();
        const received: { channel: string; sender: string; content: string }[] = [];
        server.onPlatformChat((body) => {
            received.push(body);
        });
        const conn = new FakeWsConnection();
        ws.accept(conn);
        conn.receive(
            JSON.stringify({
                header: { type: "chat" },
                body: { channel: "10001", sender: "小明", content: "早" },
            }),
        );
        expect(received).toHaveLength(0);

        conn.receive(helloText());
        conn.receive(
            JSON.stringify({
                header: { type: "chat" },
                body: { channel: "10001", sender: "小明", content: "早" },
            }),
        );
        expect(received).toEqual([{ channel: "10001", sender: "小明", content: "早" }]);
    });

    it("sendGameChat 推给已握手对端并返回送达数；无对端时返回 0", () => {
        const { server, ws } = makeServer();
        expect(server.sendGameChat({ channel: "10001", playerName: "Steve", content: "hi" })).toBe(
            0,
        );

        const conn = establishedConn(ws);
        expect(server.sendGameChat({ channel: "10001", playerName: "Steve", content: "hi" })).toBe(
            1,
        );

        const chat = JSON.parse(conn.sent[1] ?? "{}");
        expect(chat).toEqual({
            header: { type: "chat" },
            body: { channel: "10001", playerName: "Steve", content: "hi" },
        });
    });
});

describe("KurobotServer v0.2 出帧（join/leave/status/bindings_updated）", () => {
    it("四种事件均推给已握手对端，未握手对端不收", () => {
        const { server, ws } = makeServer();
        const established = establishedConn(ws);
        const unestablished = new FakeWsConnection();
        ws.accept(unestablished);

        server.sendJoin({ channel: "10001", playerName: "Steve" });
        server.sendLeave({ channel: "10001", playerName: "Steve" });
        server.sendStatus({ tps: 19.5, onlinePlayers: 2, uptimeSeconds: 100 });
        server.sendBindingsUpdated({ channelBindings: ["10001"] });

        const types = established.sent.slice(1).map((t) => JSON.parse(t).header.type);
        expect(types).toEqual(["join", "leave", "status", "bindings_updated"]);
        expect(JSON.parse(established.sent[1] ?? "{}").body).toEqual({
            channel: "10001",
            playerName: "Steve",
        });
        expect(JSON.parse(established.sent[3] ?? "{}").body).toEqual({
            tps: 19.5,
            onlinePlayers: 2,
            uptimeSeconds: 100,
        });
        expect(JSON.parse(established.sent[4] ?? "{}").body).toEqual({
            channelBindings: ["10001"],
        });
        expect(unestablished.sent).toHaveLength(0);
    });
});

describe("KurobotServer 超时健壮性（验收 §4.2）", () => {
    it("假对端连入后不发 hello → hello 超时被关（1002）", () => {
        const { server, ws, logger, time } = makeServer(T);
        const conn = new FakeWsConnection();
        ws.accept(conn);

        time.scheduler.advance(T.helloTimeoutMs - 1);
        expect(conn.closed).toBeNull();

        time.scheduler.advance(1);
        expect(conn.closed?.code).toBe(1002);
        expect(conn.closed?.reason).toContain("hello");
        expect(server.establishedPeerCount).toBe(0);
        expect(logger.warns.some((w) => w.includes("hello 超时"))).toBe(true);
    });

    it("超时前完成握手 → hello 定时器被取消，不再触发", () => {
        const { server, ws, time } = makeServer(T);
        const conn = establishedConn(ws);

        // 越过 hello 阈值但停在 idle 阈值内（该用例只验证 hello 定时器被取消）
        time.scheduler.advance(T.helloTimeoutMs + 1);
        expect(conn.closed).toBeNull();
        expect(server.establishedPeerCount).toBe(1);
    });

    it("握手后停发任何帧 → 空闲阈值判定断开（1001）", () => {
        const { server, ws, logger, time } = makeServer(T);
        const conn = establishedConn(ws);

        time.scheduler.advance(T.idleTimeoutMs - 1);
        expect(conn.closed).toBeNull();

        time.scheduler.advance(1);
        expect(conn.closed?.code).toBe(1001);
        expect(conn.closed?.reason).toContain("idle");
        expect(server.establishedPeerCount).toBe(0);
        expect(logger.warns.some((w) => w.includes("无任何帧"))).toBe(true);
    });

    it("空闲窗口内持续 ping → 空闲计时不断重置，连接保持", () => {
        const { server, ws, time } = makeServer(T);
        const conn = establishedConn(ws);

        // 三个完整的空闲窗口，每个窗口末尾前 ping 一次
        for (let i = 0; i < 3; i += 1) {
            time.scheduler.advance(T.idleTimeoutMs - 1);
            conn.receive(pingText());
        }
        time.scheduler.advance(T.idleTimeoutMs - 1);
        expect(conn.closed).toBeNull();
        expect(server.establishedPeerCount).toBe(1);
    });

    it("连接关闭后定时器全部清理（无泄漏）", () => {
        const { ws, time } = makeServer(T);
        const conn = establishedConn(ws);
        conn.close(1000, "bye");

        expect(time.scheduler.pendingCount).toBe(0);
    });

    it("server.stop 后无遗留定时器", async () => {
        const { server, ws, time } = makeServer(T);
        establishedConn(ws);
        await server.stop();

        expect(time.scheduler.pendingCount).toBe(0);
    });

    it("阈值 0 = 禁用全部检测", () => {
        const { ws, time } = makeServer({ helloTimeoutMs: 0, idleTimeoutMs: 0 });
        const conn = new FakeWsConnection();
        ws.accept(conn);

        time.scheduler.advance(1_000_000);
        expect(conn.closed).toBeNull();
        expect(time.scheduler.pendingCount).toBe(0);
    });
});

describe("KurobotServer 帧容错与生命周期", () => {
    it("坏 JSON 与校验失败的帧被丢弃，不崩不影响后续", () => {
        const { ws } = makeServer();
        const conn = new FakeWsConnection();
        ws.accept(conn);
        conn.receive("not json");
        conn.receive(
            JSON.stringify({
                header: { type: "chat", id: UUID },
                body: { channel: "10001", sender: "x", content: "y" },
            }),
        );
        conn.receive(helloText());

        expect(JSON.parse(conn.sent[0] ?? "{}").header.type).toBe("hello_ack");
    });

    it("连接关闭后从对端集合移除；stop 关闭全部", async () => {
        const { server, ws } = makeServer();
        const conn = establishedConn(ws);
        conn.close(1000, "bye");
        expect(server.establishedPeerCount).toBe(0);

        await server.stop();
        expect(ws.stopped).toBe(true);
    });
});
