import { PROTOCOL_VERSION } from "@kuro-bridge/protocol";
import { describe, expect, it, vi } from "vitest";

import { AdminTable } from "./business/admins.js";
import { BindingTable } from "./business/bindings.js";
import { ConfigError, defaultConfig, type KurobridgeConfig } from "./business/config.js";
import { IpcRequestError, Relay } from "./relay.js";
import { KurobridgeServer } from "./server.js";
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

const UUID = "123e4567-e89b-12d3-a456-426614174000";
/** 夹具默认绑定频道（平台消息放行、游戏事件 fan-out 目标） */
const BOUND = "10001";
/** 测试用 IPC 请求超时（远小于默认值） */
const IPC_TIMEOUT_MS = 500;

/** 构造 KurobridgeConfig（runtime 用缺省 true） */
function cfg(channels: string[]): KurobridgeConfig {
    return { ...defaultConfig(), channels };
}

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
    bindings: BindingTable;
    admins: AdminTable;
    config: FakeConfigStore;
    ws: FakeWsServer;
    ipc: FakeIpc;
    logger: FakeLogger;
    conn: FakeWsConnection;
    shutdownReasons: string[];
    time: ReturnType<typeof manualTime>;
}

function makeFixture(ipcRequestTimeoutMs?: number, channels: string[] = [BOUND]): Fixture {
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
    const bindings = new BindingTable(channels);
    const admins = new AdminTable([]);
    const config = new FakeConfigStore(cfg(channels));
    const server = new KurobridgeServer({
        context,
        wsServer: ws,
        channelBindings: () => bindings.channels(),
        // 关闭 server 侧超时：本文件只测 Relay 的定时器（pendingCount 断言不混入 server 任务）
        timeouts: { helloTimeoutMs: 0, idleTimeoutMs: 0 },
    });
    const shutdownReasons: string[] = [];
    const relay = new Relay({
        context,
        server,
        ipc,
        bindings,
        admins,
        configStore: config,
        onShutdown: (reason) => {
            shutdownReasons.push(reason);
        },
        ...(ipcRequestTimeoutMs === undefined ? {} : { ipcRequestTimeoutMs }),
    });
    const conn = new FakeWsConnection();
    ws.accept(conn);
    conn.receive(helloText());
    return { relay, bindings, admins, config, ws, ipc, logger, conn, shutdownReasons, time };
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

describe("Relay 游戏 → 平台（绑定频道 fan-out）", () => {
    it("IPC game_chat → 每个绑定频道一帧 chat", () => {
        const { ipc, conn } = makeFixture(undefined, ["10001", "10002"]);
        ipc.receive(
            JSON.stringify({
                header: { type: "game_chat" },
                body: { playerName: "Steve", content: "yo" },
            }),
        );

        expect(conn.sent).toHaveLength(3); // hello_ack + 2 帧 chat
        expect(JSON.parse(conn.sent[1] ?? "{}")).toEqual({
            header: { type: "chat" },
            body: { channel: "10001", playerName: "Steve", content: "yo" },
        });
        expect(JSON.parse(conn.sent[2] ?? "{}").body.channel).toBe("10002");
    });

    it("无绑定频道 → 不出帧", () => {
        const { ipc, conn, logger } = makeFixture(undefined, []);
        ipc.receive(
            JSON.stringify({
                header: { type: "game_chat" },
                body: { playerName: "Steve", content: "yo" },
            }),
        );

        expect(conn.sent).toHaveLength(1); // 只有 hello_ack
        expect(logger.debugs.some((d) => d.includes("未出帧"))).toBe(true);
    });

    it("IPC player_join / player_quit → 每个绑定频道一帧 join / leave", () => {
        const { ipc, conn } = makeFixture(undefined, ["10001", "10002"]);
        ipc.receive(
            JSON.stringify({ header: { type: "player_join" }, body: { playerName: "Steve" } }),
        );
        ipc.receive(
            JSON.stringify({ header: { type: "player_quit" }, body: { playerName: "Steve" } }),
        );

        const join1 = JSON.parse(conn.sent[1] ?? "{}");
        const join2 = JSON.parse(conn.sent[2] ?? "{}");
        const leave1 = JSON.parse(conn.sent[3] ?? "{}");
        const leave2 = JSON.parse(conn.sent[4] ?? "{}");
        expect(join1).toEqual({
            header: { type: "join" },
            body: { channel: "10001", playerName: "Steve" },
        });
        expect(join2.body.channel).toBe("10002");
        expect(leave1).toEqual({
            header: { type: "leave" },
            body: { channel: "10001", playerName: "Steve" },
        });
        expect(leave2.body.channel).toBe("10002");
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

describe("Relay 平台 → 游戏（绑定过滤 + broadcast 请求-响应）", () => {
    it("绑定频道的平台 chat → broadcast 请求携带 channel；result ok → promise 解决", async () => {
        const { relay, ipc } = makeFixture();
        const promise = relay.forwardToGame({
            channel: BOUND,
            sender: "小明",
            content: "大家好",
        });

        expect(ipc.sent).toHaveLength(1);
        const requestId = requestIdAt(ipc, 0);
        expect(JSON.parse(ipc.sent[0] ?? "{}")).toEqual({
            header: { type: "broadcast", id: requestId },
            body: { channel: BOUND, message: "<小明> 大家好" },
        });

        ipc.receive(resultText(requestId, true));
        await expect(promise).resolves.toEqual({ ok: true });
    });

    it("未绑定频道的平台 chat 被丢弃（不发 broadcast）并记 debug 日志", () => {
        const { ipc, conn, logger } = makeFixture();
        conn.receive(
            JSON.stringify({
                header: { type: "chat" },
                body: { channel: "99999", sender: "小明", content: "大家好" },
            }),
        );

        expect(ipc.sent).toHaveLength(0);
        expect(logger.debugs.some((d) => d.includes("未绑定频道 99999"))).toBe(true);
    });

    it("result error → promise 以 IpcRequestError 拒绝", async () => {
        const { relay, ipc } = makeFixture();
        const promise = relay.forwardToGame({ channel: BOUND, sender: "a", content: "b" });
        ipc.receive(resultText(requestIdAt(ipc, 0), false, "no players"));

        await expect(promise).rejects.toBeInstanceOf(IpcRequestError);
        await expect(promise).rejects.toMatchObject({ reason: "no players" });
    });

    it("WS 平台 chat（绑定频道）自动触发 broadcast；失败被捕获进日志不外泄", async () => {
        const { ipc, conn, logger } = makeFixture();
        conn.receive(
            JSON.stringify({
                header: { type: "chat" },
                body: { channel: BOUND, sender: "小明", content: "大家好" },
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
        const first = relay.forwardToGame({ channel: BOUND, sender: "a", content: "b" });
        const second = relay.forwardToGame({ channel: BOUND, sender: "c", content: "d" });
        ipc.emitClose();

        await expect(first).rejects.toBeInstanceOf(IpcRequestError);
        await expect(second).rejects.toBeInstanceOf(IpcRequestError);
        await expect(
            relay.forwardToGame({ channel: BOUND, sender: "e", content: "f" }),
        ).rejects.toBeInstanceOf(IpcRequestError);
    });

    it("IPC 断开后定时器无泄漏", () => {
        const { relay, ipc, time } = makeFixture(IPC_TIMEOUT_MS);
        void relay
            .forwardToGame({ channel: BOUND, sender: "a", content: "b" })
            .catch(() => undefined);
        ipc.emitClose();

        expect(time.scheduler.pendingCount).toBe(0);
    });
});

describe("Relay 配置变更 → bindings_updated（验收 §4.3c）", () => {
    it("绑定集合变化 → 推送变更后完整列表给已握手对端", () => {
        const { config, conn } = makeFixture();
        config.notify(cfg([BOUND, "10002"]));

        const frame = JSON.parse(conn.sent[1] ?? "{}");
        expect(frame).toEqual({
            header: { type: "bindings_updated" },
            body: { channelBindings: [BOUND, "10002"] },
        });
    });

    it("集合未变（重排/重复）→ 不推送", () => {
        const { config, conn } = makeFixture(undefined, [BOUND, "10002"]);
        config.notify(cfg(["10002", BOUND]));

        expect(conn.sent).toHaveLength(1); // 只有 hello_ack
    });

    it("配置变更影响 hello_ack 快照（新握手对端拿到新列表）", () => {
        const { config, ws } = makeFixture();
        config.notify(cfg([BOUND, "10003"]));

        const conn2 = new FakeWsConnection();
        ws.accept(conn2);
        conn2.receive(helloText());
        const ack = JSON.parse(conn2.sent[0] ?? "{}");
        expect(ack.body.channelBindings).toEqual([BOUND, "10003"]);
    });

    it("清空绑定后游戏事件不再出帧", () => {
        const { config, ipc, conn } = makeFixture();
        config.notify(cfg([]));
        ipc.receive(
            JSON.stringify({
                header: { type: "game_chat" },
                body: { playerName: "Steve", content: "yo" },
            }),
        );

        expect(conn.sent).toHaveLength(2); // hello_ack + bindings_updated
    });
});

describe("Relay IPC 请求超时（对齐 Java 侧 10s 语义）", () => {
    it("无响应 → 超时以 IpcRequestError 拒绝；迟到的响应被忽略不崩", async () => {
        const { relay, ipc, logger, time } = makeFixture(IPC_TIMEOUT_MS);
        const promise = relay.forwardToGame({ channel: BOUND, sender: "a", content: "b" });

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
        const promise = relay.forwardToGame({ channel: BOUND, sender: "a", content: "b" });
        ipc.receive(resultText(requestIdAt(ipc, 0), true));
        await expect(promise).resolves.toEqual({ ok: true });

        time.scheduler.advance(IPC_TIMEOUT_MS * 3);
        expect(time.scheduler.pendingCount).toBe(0);
    });

    it("ipcRequestTimeoutMs=0 禁用超时", async () => {
        const { relay, time } = makeFixture(0);
        void relay
            .forwardToGame({ channel: BOUND, sender: "a", content: "b" })
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

describe("Relay command 请求（v0.3.0：管理员判定 + IPC 透传）", () => {
    function commandText(command: string, channel = "stub-channel", userId = "stub-admin"): string {
        return JSON.stringify({
            header: { type: "command", id: UUID },
            body: { command, source: { channel, userId } },
        });
    }

    it("非管理员来源 → command_result ok:false forbidden + warn，不触发 IPC", async () => {
        const f = makeFixture();
        f.conn.receive(commandText("whitelist list", "stub-channel", "intruder"));
        await Promise.resolve();
        await Promise.resolve();
        const reply = JSON.parse(f.conn.sent[1] ?? "{}");
        expect(reply.header.type).toBe("command_result");
        expect(reply.body).toEqual({ ok: false, error: "forbidden" });
        expect(f.ipc.sent).toHaveLength(0);
        expect(f.logger.warns.some((m) => m.includes("非管理员来源"))).toBe(true);
    });

    it("管理员来源 → IPC execute_command 请求透传，结果（含 output）原样回 command_result", async () => {
        const f = makeFixture();
        f.admins.replace([{ channel: "stub-channel", users: ["stub-admin"] }]);
        f.conn.receive(commandText("whitelist list"));
        await Promise.resolve();
        const request = JSON.parse(f.ipc.sent[0] ?? "{}");
        expect(request.header.type).toBe("execute_command");
        expect(request.body).toEqual({ command: "whitelist list" });
        // Java 回 execute_command_result（带 output）
        f.ipc.receive(
            JSON.stringify({
                header: { type: "execute_command_result", id: request.header.id },
                body: { ok: true, output: ["Whitelisted players: Steve"] },
            }),
        );
        await vi.waitFor(() => expect(f.conn.sent).toHaveLength(2));
        const reply = JSON.parse(f.conn.sent[1] ?? "{}");
        expect(reply).toEqual({
            header: { type: "command_result", id: UUID },
            body: { ok: true, output: ["Whitelisted players: Steve"] },
        });
    });

    it("管理员来源 + IPC 结果 ok:false → command_result ok:false（错误文本透传）", async () => {
        const f = makeFixture();
        f.admins.replace([{ channel: "stub-channel", users: ["stub-admin"] }]);
        f.conn.receive(commandText("stop"));
        await Promise.resolve();
        const request = JSON.parse(f.ipc.sent[0] ?? "{}");
        f.ipc.receive(
            JSON.stringify({
                header: { type: "execute_command_result", id: request.header.id },
                body: { ok: false, error: "调度命令执行到主线程失败" },
            }),
        );
        await vi.waitFor(() => expect(f.conn.sent).toHaveLength(2));
        const reply = JSON.parse(f.conn.sent[1] ?? "{}");
        expect(reply.body.ok).toBe(false);
        expect(reply.body.error).toContain("调度命令执行到主线程失败");
    });

    it("配置变更刷新管理员映射：原本 forbidden 的来源在 admins 更新后放行", async () => {
        const f = makeFixture();
        f.conn.receive(commandText("list"));
        await Promise.resolve();
        await Promise.resolve();
        expect(JSON.parse(f.conn.sent[1] ?? "{}").body.ok).toBe(false);

        f.config.notify({
            ...defaultConfig(),
            channels: [BOUND],
            admins: [{ channel: "stub-channel", users: ["stub-admin"] }],
        });
        f.conn.receive(commandText("list"));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        // 第二次命令已发往 IPC（管理员放行）
        expect(f.ipc.sent.some((t) => t.includes("execute_command"))).toBe(true);
    });
});

describe("Relay player_death fan-out（v0.3.0）", () => {
    it("IPC player_death → 每个绑定频道一帧 death（player/message 原样）", () => {
        const f = makeFixture();
        f.ipc.receive(
            JSON.stringify({
                header: { type: "player_death" },
                body: { player: "Steve", message: "Steve 掉出了这个世界" },
            }),
        );
        const deathFrames = f.conn.sent
            .map((t) => JSON.parse(t) as { header: { type: string }; body: unknown })
            .filter((frame) => frame.header.type === "death");
        expect(deathFrames.map((frame) => frame.body)).toEqual([
            { channel: BOUND, player: "Steve", message: "Steve 掉出了这个世界" },
        ]);
    });
});

describe("Relay config_reload（v0.3.0：/kurobridge reload 复用 watch 路径）", () => {
    it("IPC config_reload → 重读配置，绑定集合变化 → bindings_updated 推送", async () => {
        const f = makeFixture();
        const updated = { ...defaultConfig(), channels: ["10002"] };
        f.config.setLoadResult({ ok: true, config: updated });
        f.ipc.receive(JSON.stringify({ header: { type: "config_reload" }, body: {} }));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        const pushed = f.conn.sent
            .map(
                (t) =>
                    JSON.parse(t) as {
                        header: { type: string };
                        body: { channelBindings?: string[] };
                    },
            )
            .filter((frame) => frame.header.type === "bindings_updated");
        expect(pushed[pushed.length - 1]?.body.channelBindings).toEqual(["10002"]);
        expect(f.bindings.channels()).toEqual(["10002"]);
    });

    it("重载后配置非法（load 抛错）→ 保留旧绑定，不崩不推送", async () => {
        const f = makeFixture();
        f.config.setLoadResult({ ok: false, error: new ConfigError("boom") });
        f.ipc.receive(JSON.stringify({ header: { type: "config_reload" }, body: {} }));
        await Promise.resolve();
        await Promise.resolve();
        expect(f.bindings.channels()).toEqual([BOUND]);
        expect(f.logger.errors.length).toBeGreaterThan(0);
    });
});
