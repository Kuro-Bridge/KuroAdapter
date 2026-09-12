import { PROTOCOL_VERSION } from "@kurobot/protocol";
import { describe, expect, it } from "vitest";

import { KurobotServer } from "./server.js";
import { FakeLogger, FakeWsConnection, FakeWsServer, makeContext } from "./test-fakes.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

function helloText(protocolVersion: string = PROTOCOL_VERSION): string {
    return JSON.stringify({
        header: { type: "hello", id: UUID },
        body: { peerId: "peer-1", platform: "stub", version: "0.0.1", protocolVersion },
    });
}

function makeServer(): { server: KurobotServer; ws: FakeWsServer; logger: FakeLogger } {
    const logger = new FakeLogger();
    const ws = new FakeWsServer();
    const server = new KurobotServer({ context: makeContext({ logger }), wsServer: ws });
    return { server, ws, logger };
}

describe("KurobotServer 握手", () => {
    it("合法 hello → hello_ack ok（携带服务端身份）", () => {
        const { server, ws } = makeServer();
        const conn = new FakeWsConnection();
        ws.accept(conn);
        conn.receive(helloText());

        expect(server.establishedPeerCount).toBe(1);
        const ack = JSON.parse(conn.sent[0] ?? "{}");
        expect(ack).toEqual({
            header: { type: "hello_ack", id: UUID },
            body: {
                ok: true,
                serverId: "srv-1",
                version: "0.1.0",
                protocolVersion: PROTOCOL_VERSION,
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
        const conn = new FakeWsConnection();
        ws.accept(conn);
        conn.receive(helloText());
        conn.receive(helloText());

        expect(server.establishedPeerCount).toBe(1);
        expect(conn.sent.filter((t) => JSON.parse(t).header.type === "hello_ack")).toHaveLength(1);
    });
});

describe("KurobotServer 心跳", () => {
    it("握手后 ping → 同 id pong，回带 timestamp", () => {
        const { ws } = makeServer();
        const conn = new FakeWsConnection();
        ws.accept(conn);
        conn.receive(helloText());
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
    it("握手后平台 chat 触发 onPlatformChat；握手前丢弃", () => {
        const { server, ws } = makeServer();
        const received: { sender: string; content: string }[] = [];
        server.onPlatformChat((body) => {
            received.push(body);
        });
        const conn = new FakeWsConnection();
        ws.accept(conn);
        conn.receive(
            JSON.stringify({ header: { type: "chat" }, body: { sender: "小明", content: "早" } }),
        );
        expect(received).toHaveLength(0);

        conn.receive(helloText());
        conn.receive(
            JSON.stringify({ header: { type: "chat" }, body: { sender: "小明", content: "早" } }),
        );
        expect(received).toEqual([{ sender: "小明", content: "早" }]);
    });

    it("sendGameChat 推给已握手对端；无对端时安全丢弃", () => {
        const { server, ws } = makeServer();
        server.sendGameChat({ playerName: "Steve", content: "hi" });

        const conn = new FakeWsConnection();
        ws.accept(conn);
        conn.receive(helloText());
        server.sendGameChat({ playerName: "Steve", content: "hi" });

        const chat = JSON.parse(conn.sent[1] ?? "{}");
        expect(chat).toEqual({
            header: { type: "chat" },
            body: { playerName: "Steve", content: "hi" },
        });
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
                body: { sender: "x", content: "y" },
            }),
        );
        conn.receive(helloText());

        expect(JSON.parse(conn.sent[0] ?? "{}").header.type).toBe("hello_ack");
    });

    it("连接关闭后从对端集合移除；stop 关闭全部", async () => {
        const { server, ws } = makeServer();
        const conn = new FakeWsConnection();
        ws.accept(conn);
        conn.receive(helloText());
        conn.close(1000, "bye");
        expect(server.establishedPeerCount).toBe(0);

        await server.stop();
        expect(ws.stopped).toBe(true);
    });
});
