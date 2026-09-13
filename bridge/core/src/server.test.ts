import { PROTOCOL_VERSION } from "@kurobot/protocol";
import { describe, expect, it } from "vitest";

import { KurobotServer } from "./server.js";
import { FakeLogger, FakeWsConnection, FakeWsServer, makeContext } from "./test-fakes.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const CHANNELS = ["10001", "10002"];

function helloText(protocolVersion: string = PROTOCOL_VERSION): string {
    return JSON.stringify({
        header: { type: "hello", id: UUID },
        body: { peerId: "peer-1", platform: "stub", version: "0.0.1", protocolVersion },
    });
}

function makeServer(): { server: KurobotServer; ws: FakeWsServer; logger: FakeLogger } {
    const logger = new FakeLogger();
    const ws = new FakeWsServer();
    const server = new KurobotServer({
        context: makeContext({ logger }),
        wsServer: ws,
        channelBindings: () => CHANNELS,
    });
    return { server, ws, logger };
}

/** 建立一个已握手连接 */
function establishedConn(ws: FakeWsServer): FakeWsConnection {
    const conn = new FakeWsConnection();
    ws.accept(conn);
    conn.receive(helloText());
    return conn;
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
        conn.receive(
            JSON.stringify({ header: { type: "ping", id: UUID }, body: { timestamp: 1 } }),
        );

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

    it("sendGameChat 推给已握手对端；无对端时安全丢弃", () => {
        const { server, ws } = makeServer();
        server.sendGameChat({ channel: "10001", playerName: "Steve", content: "hi" });

        const conn = establishedConn(ws);
        server.sendGameChat({ channel: "10001", playerName: "Steve", content: "hi" });

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
