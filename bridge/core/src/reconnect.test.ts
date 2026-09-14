import { PROTOCOL_VERSION } from "@kuro-bridge/protocol";
import { describe, expect, it } from "vitest";
import { AdminTable } from "./business/admins.js";
import { BindingTable } from "./business/bindings.js";
import { defaultConfig, type KurobotConfig } from "./business/config.js";
import { Relay } from "./relay.js";
import { KurobotServer } from "./server.js";
import {
    FakeConfigStore,
    FakeIpc,
    FakeLogger,
    FakeWsConnection,
    FakeWsServer,
    makeContext,
    manualTime,
    sequentialIdFactory,
} from "./test-fakes.js";

/**
 * 断连清理与重连一致性（DEBT-2）：对端断开 → 资源清理 → 重连 → 重新握手 → 双向恢复。
 * 验收 §4.6：多轮断开后握手、绑定快照、send 送达数正确、定时器 pending=0 零泄漏。
 */

const UUID = "123e4567-e89b-12d3-a456-426614174000";
/** 服务端短超时（hello 50ms / idle 100ms，ManualScheduler 手动推进） */
const T = { helloTimeoutMs: 50, idleTimeoutMs: 100 };

function helloText(peerId = "peer-1"): string {
    return JSON.stringify({
        header: { type: "hello", id: UUID },
        body: { peerId, platform: "stub", version: "0.0.1", protocolVersion: PROTOCOL_VERSION },
    });
}

function gameChatText(): string {
    return JSON.stringify({
        header: { type: "chat" },
        body: { channel: "10001", sender: "小明", content: "你好" },
    });
}

interface Fixture {
    server: KurobotServer;
    ws: FakeWsServer;
    logger: FakeLogger;
    bindings: BindingTable;
    config: FakeConfigStore;
    time: ReturnType<typeof manualTime>;
}

function makeFixture(timeouts: { helloTimeoutMs: number; idleTimeoutMs: number } = T): Fixture {
    const logger = new FakeLogger();
    const ws = new FakeWsServer();
    const time = manualTime();
    const context = makeContext({
        logger,
        newRequestId: sequentialIdFactory(),
        clock: time.clock,
        scheduler: time.scheduler,
    });
    const config = new FakeConfigStore(defaultConfig());
    const bindings = new BindingTable(["10001"]);
    // 绑定快照经闭包实时取值——重连握手测试用 configStore 驱动同一 BindingTable
    const server = new KurobotServer({
        context,
        wsServer: ws,
        channelBindings: () => bindings.channels(),
        ...(timeouts === undefined ? {} : { timeouts }),
    });
    return { server, ws, logger, bindings, config, time };
}

/** 连入并完成握手；返回连接 */
function handshake(ws: FakeWsServer, peerId = "peer-1"): FakeWsConnection {
    const conn = new FakeWsConnection();
    ws.accept(conn);
    conn.receive(helloText(peerId));
    return conn;
}

function cfg(channels: string[]): KurobotConfig {
    return { ...defaultConfig(), channels };
}

describe("对端断开 → 重连一致性（DEBT-2）", () => {
    it("断开后 send* 送达数归 0（不抛错），重连握手后恢复非 0", () => {
        const { server, ws, bindings } = makeFixture();
        const conn = handshake(ws);
        expect(server.establishedPeerCount).toBe(1);
        expect(server.sendGameChat({ channel: "10001", playerName: "Steve", content: "yo" })).toBe(
            1,
        );

        conn.close(1000, "client gone");
        expect(server.establishedPeerCount).toBe(0);
        expect(server.sendGameChat({ channel: "10001", playerName: "Steve", content: "yo" })).toBe(
            0,
        );
        expect(server.sendJoin({ channel: "10001", playerName: "Steve" })).toBe(0);
        expect(server.sendLeave({ channel: "10001", playerName: "Steve" })).toBe(0);
        expect(server.sendStatus({ tps: 20, onlinePlayers: 0, uptimeSeconds: 1 })).toBe(0);
        expect(server.sendBindingsUpdated({ channelBindings: [...bindings.channels()] })).toBe(0);

        handshake(ws, "peer-2");
        expect(server.establishedPeerCount).toBe(1);
        expect(server.sendGameChat({ channel: "10001", playerName: "Steve", content: "yo" })).toBe(
            1,
        );
    });

    it("断开期间绑定变更 → 重连握手拿到新快照（hello_ack 闭包实时取值）", () => {
        const { server, ws, bindings } = makeFixture();
        const conn1 = handshake(ws);
        expect(JSON.parse(conn1.sent[0] ?? "{}").body.channelBindings).toEqual(["10001"]);
        conn1.close(1000, "bye");

        bindings.replace(["10001", "10002"]);
        const conn2 = handshake(ws, "peer-2");
        const ack = JSON.parse(conn2.sent[0] ?? "{}");
        expect(ack.body.channelBindings).toEqual(["10001", "10002"]);
        expect(server.establishedPeerCount).toBe(1);
    });

    it("被服务端超时断开（hello 等待超时 1002）后重连不受旧状态污染", () => {
        const { server, ws, time } = makeFixture();
        const conn = new FakeWsConnection();
        ws.accept(conn); // 不发 hello → 50ms 后超时关闭

        time.scheduler.advance(60);
        expect(conn.closed).toEqual({ code: 1002, reason: "hello timeout" });
        expect(server.establishedPeerCount).toBe(0);

        const conn2 = handshake(ws, "peer-2");
        expect(server.establishedPeerCount).toBe(1);
        expect(JSON.parse(conn2.sent[0] ?? "{}").body.ok).toBe(true);
        // 新对端握手后持有活跃的 idle 定时器（1 个），旧连接的定时器已在断开时清空
        expect(time.scheduler.pendingCount).toBe(1);
        conn2.close(1000, "bye");
        expect(time.scheduler.pendingCount).toBe(0);
    });

    it("被服务端空闲超时断开（1001）后重连恢复双向", () => {
        const { server, ws, time } = makeFixture();
        const conn = handshake(ws);
        time.scheduler.advance(T.idleTimeoutMs + 10); // 握手后无任何帧 → idle 断开
        expect(conn.closed).toEqual({ code: 1001, reason: "idle timeout" });
        expect(server.sendGameChat({ channel: "10001", playerName: "A", content: "x" })).toBe(0);

        const conn2 = handshake(ws, "peer-2");
        conn2.receive(gameChatText()); // 新对端双向：平台 chat 仍可被处理（handler 未挂，无副作用）
        expect(server.sendGameChat({ channel: "10001", playerName: "A", content: "x" })).toBe(1);
    });

    it("反复 20 轮连入→握手→断开：状态无污染、定时器零泄漏", () => {
        const { server, ws, time } = makeFixture();
        for (let round = 0; round < 20; round++) {
            const conn = handshake(ws, `peer-${round}`);
            expect(server.establishedPeerCount).toBe(1);
            expect(server.sendGameChat({ channel: "10001", playerName: "A", content: "x" })).toBe(
                1,
            );
            conn.close(1000, `round ${round}`);
            expect(server.establishedPeerCount).toBe(0);
        }
        expect(time.scheduler.pendingCount).toBe(0);
        expect(server.establishedPeerCount).toBe(0);
    });

    it("server.stop() 关闭全部对端后定时器零泄漏、send 全部归 0", async () => {
        const { server, ws, time } = makeFixture();
        handshake(ws, "peer-1");
        handshake(ws, "peer-2");
        expect(server.establishedPeerCount).toBe(2);

        await server.stop();
        expect(server.sendGameChat({ channel: "10001", playerName: "A", content: "x" })).toBe(0);
        expect(time.scheduler.pendingCount).toBe(0);
    });
});

describe("Relay 断连 → 重建一致性（DEBT-2）", () => {
    interface RelayFixture {
        relay: Relay;
        server: KurobotServer;
        ws: FakeWsServer;
        ipc: FakeIpc;
        config: FakeConfigStore;
        bindings: BindingTable;
        time: ReturnType<typeof manualTime>;
        logger: FakeLogger;
    }

    function makeRelayFixture(): RelayFixture {
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
        const config = new FakeConfigStore(cfg(["10001"]));
        const bindings = new BindingTable(["10001"]);
        const server = new KurobotServer({
            context,
            wsServer: ws,
            channelBindings: () => bindings.channels(),
            timeouts: { helloTimeoutMs: 0, idleTimeoutMs: 0 },
        });
        const admins = new AdminTable([]);
        const relay = new Relay({
            context,
            server,
            ipc,
            bindings,
            admins,
            configStore: config,
        });
        return { relay, server, ws, ipc, config, bindings, time, logger };
    }

    function handshakeOn(ws: FakeWsServer): FakeWsConnection {
        const conn = new FakeWsConnection();
        ws.accept(conn);
        conn.receive(helloText());
        return conn;
    }

    it("IPC 断开：在途请求拒绝且定时器清零；重建 Relay（重启后）转发恢复", async () => {
        const f = makeRelayFixture();
        const conn = handshakeOn(f.ws);

        const promise = f.relay.forwardToGame({ channel: "10001", sender: "小明", content: "hi" });
        f.ipc.emitClose();
        await expect(promise).rejects.toMatchObject({ name: "IpcRequestError" });
        expect(f.time.scheduler.pendingCount).toBe(0);
        expect(f.relay.ipcOpen).toBe(false);
        expect(conn.sent).toHaveLength(1); // 只有 hello_ack，无新出帧

        // 模拟看护器重启成功：新 IPC 通道 + 新 Relay 实例（绑定表/服务端复用）
        const ipc2 = new FakeIpc();
        const context2 = makeContext({
            logger: f.logger,
            newRequestId: sequentialIdFactory(),
            clock: f.time.clock,
            scheduler: f.time.scheduler,
        });
        const relay2 = new Relay({
            context: context2,
            server: f.server,
            ipc: ipc2,
            bindings: f.bindings,
            admins: new AdminTable([]),
            configStore: f.config,
        });
        expect(relay2.ipcOpen).toBe(true);

        conn.receive(gameChatText()); // 平台 chat 经新 Relay 转发 → 新通道收到 broadcast 请求
        expect(ipc2.sent).toHaveLength(1);
        const broadcast = JSON.parse(ipc2.sent[0] ?? "{}");
        expect(broadcast.header.type).toBe("broadcast");
        expect(f.time.scheduler.pendingCount).toBe(1); // 新请求的 10s 超时定时器在途（非泄漏）
        relay2.dispose();
        expect(f.time.scheduler.pendingCount).toBe(0);
    });

    it("IPC 断开后旧 Relay 不再处理任何入帧（dispose 幂等语义不回归）", () => {
        const f = makeRelayFixture();
        f.relay.dispose();
        f.ipc.receive(
            JSON.stringify({
                header: { type: "game_chat" },
                body: { playerName: "Steve", content: "yo" },
            }),
        );
        expect(f.time.scheduler.pendingCount).toBe(0);
        expect(f.logger.warns.length + f.logger.errors.length).toBe(0);
    });
});
