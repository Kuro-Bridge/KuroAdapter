import { PROTOCOL_VERSION } from "@kuro-bridge/protocol";
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

function makeServer(timeouts?: ServerTimeouts, token?: string): ServerFixture {
    const logger = new FakeLogger();
    const ws = new FakeWsServer();
    const time = manualTime();
    const context = makeContext({
        logger,
        clock: time.clock,
        scheduler: time.scheduler,
        ...(token === undefined ? {} : { token }),
    });
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

describe("KurobotServer 版本协商兼容区间（v0.3.0，ADR-026）", () => {
    it("0.2.0 旧对端连 0.3.0 服务端：主版本相同 → 兼容可握手", () => {
        const { server, ws } = makeServer();
        const conn = new FakeWsConnection();
        ws.accept(conn);
        conn.receive(helloText("0.2.0"));
        expect(server.establishedPeerCount).toBe(1);
        expect(JSON.parse(conn.sent[0] ?? "{}").body.ok).toBe(true);
    });

    it("1.x 对端：主版本不同 → 拒绝（hello_ack error + 1002）", () => {
        const { server, ws } = makeServer();
        const conn = new FakeWsConnection();
        ws.accept(conn);
        conn.receive(helloText("1.0.0"));
        expect(server.establishedPeerCount).toBe(0);
        expect(JSON.parse(conn.sent[0] ?? "{}").body.ok).toBe(false);
        expect(conn.closed?.code).toBe(1002);
    });

    it("hello_ack 回服务端实际版本（非对端版本）", () => {
        const { ws } = makeServer();
        const conn = new FakeWsConnection();
        ws.accept(conn);
        conn.receive(helloText("0.2.0"));
        expect(JSON.parse(conn.sent[0] ?? "{}").body.protocolVersion).toBe(PROTOCOL_VERSION);
    });
});

describe("KurobotServer 鉴权 token（v0.3.0）", () => {
    it("配置非空 token：hello 未带 token → auth failed + close 1008", () => {
        const { server, ws } = makeServer(undefined, "s3cret");
        const conn = new FakeWsConnection();
        ws.accept(conn);
        conn.receive(helloText());
        expect(server.establishedPeerCount).toBe(0);
        const ack = JSON.parse(conn.sent[0] ?? "{}");
        expect(ack.body).toEqual({ ok: false, reason: "auth failed" });
        expect(conn.closed?.code).toBe(1008);
    });

    it("配置非空 token：token 带错 → 拒绝；带对 → 握手成功", () => {
        const { server, ws } = makeServer(undefined, "s3cret");
        const wrong = new FakeWsConnection();
        ws.accept(wrong);
        wrong.receive(
            JSON.stringify({
                header: { type: "hello", id: UUID },
                body: {
                    peerId: "peer-1",
                    platform: "stub",
                    version: "0.0.1",
                    protocolVersion: PROTOCOL_VERSION,
                    token: "wrong",
                },
            }),
        );
        expect(wrong.closed?.code).toBe(1008);

        const right = new FakeWsConnection();
        ws.accept(right);
        right.receive(
            JSON.stringify({
                header: { type: "hello", id: UUID },
                body: {
                    peerId: "peer-2",
                    platform: "stub",
                    version: "0.0.1",
                    protocolVersion: PROTOCOL_VERSION,
                    token: "s3cret",
                },
            }),
        );
        expect(server.establishedPeerCount).toBe(1);
        expect(JSON.parse(right.sent[0] ?? "{}").body.ok).toBe(true);
    });

    it("token 为空（缺省）：全部放行（向后兼容，对端带不带 token 均可握手）", () => {
        const { server, ws } = makeServer();
        for (const [index, token] of [undefined, "whatever"].entries()) {
            const conn = new FakeWsConnection();
            ws.accept(conn);
            conn.receive(
                JSON.stringify({
                    header: { type: "hello", id: `123e4567-e89b-12d3-a456-42661417400${index}` },
                    body: {
                        peerId: `peer-${index}`,
                        platform: "stub",
                        version: "0.0.1",
                        protocolVersion: PROTOCOL_VERSION,
                        ...(token === undefined ? {} : { token }),
                    },
                }),
            );
        }
        expect(server.establishedPeerCount).toBe(2);
    });
});

describe("KurobotServer 未知帧容忍（v0.3.0，ADR-026）", () => {
    it("未知请求帧（带 id）→ 回同 id 的 <type>_result ok:false，不断连", () => {
        const { ws, logger } = makeServer();
        const conn = establishedConn(ws);
        conn.receive(
            JSON.stringify({ header: { type: "stub_unknown", id: UUID }, body: { any: 1 } }),
        );
        const reply = JSON.parse(conn.sent[1] ?? "{}");
        expect(reply).toEqual({
            header: { type: "stub_unknown_result", id: UUID },
            body: { ok: false, error: "unknown frame type" },
        });
        expect(conn.closed).toBeNull();
        expect(logger.debugs.some((m) => m.includes("未知请求帧"))).toBe(true);
    });

    it("未知事件帧（无 id）→ 忽略 + debug 日志，不断连不出帧", () => {
        const { ws, logger } = makeServer();
        const conn = establishedConn(ws);
        conn.receive(JSON.stringify({ header: { type: "stub_unknown_event" }, body: {} }));
        expect(conn.sent).toHaveLength(1); // 只有 hello_ack
        expect(conn.closed).toBeNull();
        expect(logger.debugs.some((m) => m.includes("未知事件帧"))).toBe(true);
    });

    it("未知 _result 响应帧（带 id）→ 不回执（防乒乓循环），不断连", () => {
        const { ws } = makeServer();
        const conn = establishedConn(ws);
        conn.receive(
            JSON.stringify({ header: { type: "mystery_result", id: UUID }, body: { ok: true } }),
        );
        expect(conn.sent).toHaveLength(1);
        expect(conn.closed).toBeNull();
    });

    it("未知请求帧的容忍在握手前同样生效（无状态依赖）", () => {
        const { ws } = makeServer();
        const conn = new FakeWsConnection();
        ws.accept(conn);
        conn.receive(JSON.stringify({ header: { type: "probe", id: UUID }, body: null }));
        expect(JSON.parse(conn.sent[0] ?? "{}").header.type).toBe("probe_result");
        expect(conn.closed).toBeNull();
    });
});

describe("KurobotServer query 本地作答（v0.3.0）", () => {
    it("query bindings → ok:true data 为绑定快照（闭包实时取值）", () => {
        const { ws } = makeServer();
        const conn = establishedConn(ws);
        conn.receive(
            JSON.stringify({ header: { type: "query", id: UUID }, body: { kind: "bindings" } }),
        );
        const reply = JSON.parse(conn.sent[1] ?? "{}");
        expect(reply.header.type).toBe("query_result");
        expect(reply.body).toEqual({ ok: true, data: CHANNELS });
    });

    it("query status：从未收到 status → ok:false no status yet", () => {
        const { ws } = makeServer();
        const conn = establishedConn(ws);
        conn.receive(
            JSON.stringify({ header: { type: "query", id: UUID }, body: { kind: "status" } }),
        );
        expect(JSON.parse(conn.sent[1] ?? "{}").body).toEqual({
            ok: false,
            error: "no status yet",
        });
    });

    it("query status：sendStatus 之后 → 缓存的最近一帧快照", () => {
        const { server, ws } = makeServer();
        const conn = establishedConn(ws);
        server.sendStatus({ tps: 19.8, onlinePlayers: 3, uptimeSeconds: 120 });
        conn.receive(
            JSON.stringify({ header: { type: "query", id: UUID }, body: { kind: "status" } }),
        );
        const reply = JSON.parse(conn.sent[2] ?? "{}");
        expect(reply.body).toEqual({
            ok: true,
            data: { tps: 19.8, onlinePlayers: 3, uptimeSeconds: 120 },
        });
    });
});

describe("KurobotServer command 分发（v0.3.0）", () => {
    it("已注册 handler：body 交给 handler，resolve 值按同 id 回 command_result", async () => {
        const { server, ws } = makeServer();
        const received: unknown[] = [];
        server.onCommand(async (body) => {
            received.push(body);
            return { ok: true, output: ["Steve"] };
        });
        const conn = establishedConn(ws);
        conn.receive(
            JSON.stringify({
                header: { type: "command", id: UUID },
                body: {
                    command: "whitelist list",
                    source: { channel: "10001", userId: "alice" },
                },
            }),
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(received).toHaveLength(1);
        expect(JSON.parse(conn.sent[1] ?? "{}")).toEqual({
            header: { type: "command_result", id: UUID },
            body: { ok: true, output: ["Steve"] },
        });
    });

    it("handler 拒绝（如 IPC 失败）→ command_result ok:false + error 文本", async () => {
        const { server, ws } = makeServer();
        server.onCommand(async () => {
            throw new Error("IPC execute_command 失败：响应超时");
        });
        const conn = establishedConn(ws);
        conn.receive(
            JSON.stringify({
                header: { type: "command", id: UUID },
                body: { command: "stop", source: { channel: "10001", userId: "alice" } },
            }),
        );
        await Promise.resolve();
        await Promise.resolve();
        const reply = JSON.parse(conn.sent[1] ?? "{}");
        expect(reply.body.ok).toBe(false);
        expect(reply.body.error).toContain("响应超时");
    });

    it("未注册 handler → ok:false command handler not available", () => {
        const { ws } = makeServer();
        const conn = establishedConn(ws);
        conn.receive(
            JSON.stringify({
                header: { type: "command", id: UUID },
                body: { command: "list", source: { channel: "10001", userId: "a" } },
            }),
        );
        expect(JSON.parse(conn.sent[1] ?? "{}").body).toEqual({
            ok: false,
            error: "command handler not available",
        });
    });

    it("握手前 command 被丢弃（不触发 handler）", () => {
        const { server, ws } = makeServer();
        let called = 0;
        server.onCommand(async () => {
            called += 1;
            return { ok: true };
        });
        const conn = new FakeWsConnection();
        ws.accept(conn);
        conn.receive(
            JSON.stringify({
                header: { type: "command", id: UUID },
                body: { command: "list", source: { channel: "10001", userId: "a" } },
            }),
        );
        expect(called).toBe(0);
        expect(conn.sent.filter((t) => t.includes("command_result"))).toHaveLength(0);
    });
});
