/**
 * GameGate 契约（壳接入点，裁决册 §4.2 鉴权 + D-08 脐带语义）：
 * - 鉴权：首帧必须等于令牌原文（明文，非 JSON）；匹配 → 包装 core IpcChannel 交 onChannel；
 *   不匹配 → close(1008, "unauthorized")，槽位释放、不触发脐带。
 * - 单租户：已有租户时新连接直接关闭，原通道不受影响。
 * - 脐带（D-08）：已鉴权连接断开 → IpcChannel.onClose + onChannelLost（引导层据此关机）；
 *   未鉴权连接的断开（端口扫描连断/令牌不匹配/鉴权超时）一律只清租户槽位，不触发脐带；
 *   gate.close() 主动关停亦不触发（closing 抑制）。
 * - IpcChannel 双向：onMessage 收壳帧；send 推帧给壳。
 * 真实 node 环境 + 真 ws 客户端连 127.0.0.1 临时端口。
 * 鉴权超时经 GameGateOptions.authTimeoutMs 注入短时限，确定性覆盖超时路径。
 */
import { type AddressInfo, createServer } from "node:net";
import type { IpcChannel } from "@kuro-bridge/bridge-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket as ClientSocket, WebSocket } from "ws";

import { GameGate } from "./game-gate.js";

const TOKEN = "session-token-abc";
const gates: GameGate[] = [];
const sockets: ClientSocket[] = [];

interface GateHarness {
    readonly gate: GameGate;
    readonly port: number;
    readonly channels: IpcChannel[];
    readonly lost: number;
}

async function startedGate(options: { authTimeoutMs?: number } = {}): Promise<GateHarness> {
    // GameGate.start() 不回报端口（端口由壳下发）：先占一个空闲端口再绑定（对齐 embedded 测试手法）
    const port = await freePort();
    const gate = new GameGate({
        port,
        token: TOKEN,
        logger: fakeLogger(),
        authTimeoutMs: options.authTimeoutMs,
    });
    gates.push(gate);
    const channels: IpcChannel[] = [];
    let lost = 0;
    gate.onChannel((ipc) => {
        channels.push(ipc);
    });
    gate.onChannelLost(() => {
        lost += 1;
    });
    await gate.start();
    return {
        gate,
        port,
        channels,
        get lost() {
            return lost;
        },
    };
}

function fakeLogger() {
    return {
        debug: vi.fn((_message: string) => undefined),
        info: vi.fn((_message: string) => undefined),
        warn: vi.fn((_message: string) => undefined),
        error: vi.fn((_message: string, _error?: unknown) => undefined),
    };
}

async function freePort(): Promise<number> {
    const occupant = createServer();
    await new Promise<void>((resolve) => {
        occupant.listen(0, () => resolve());
    });
    const port = (occupant.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
        occupant.close(() => resolve());
    });
    return port;
}

/** 裸 ws 客户端（gate 不校验子协议） */
function rawConnect(port: number): ClientSocket {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    return ws;
}

async function opened(ws: ClientSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("连入失败")));
    });
}

interface CloseInfo {
    code: number;
    reason: string;
}

/** 客户端侧 close 事件捕获 */
function clientClose(ws: ClientSocket): Promise<CloseInfo> {
    return new Promise<CloseInfo>((resolve) => {
        ws.addEventListener("close", (event: WebSocket.CloseEvent) => {
            resolve({ code: event.code, reason: event.reason });
        });
    });
}

/** 建立已鉴权通道：连接 → 发令牌首帧 → 等待 onChannel */
async function authenticatedChannel(
    harness: GateHarness,
): Promise<{ ws: ClientSocket; ipc: IpcChannel }> {
    const ws = rawConnect(harness.port);
    await opened(ws);
    ws.send(TOKEN);
    await vi.waitFor(() => {
        expect(harness.channels).toHaveLength(1);
    });
    return { ws, ipc: harness.channels[harness.channels.length - 1] as IpcChannel };
}

afterEach(async () => {
    for (const ws of sockets.splice(0)) {
        ws.terminate();
    }
    for (const gate of gates.splice(0)) {
        await gate.close().catch(() => undefined);
    }
});

describe("鉴权握手（首帧 = 令牌明文，裁决册 §4.2）", () => {
    it("令牌正确 → onChannel 收到 IpcChannel（isOpen=true），不再有令牌语义务", async () => {
        const harness = await startedGate();
        const { ipc } = await authenticatedChannel(harness);
        expect(ipc.isOpen).toBe(true);
        expect(harness.lost).toBe(0);
    });

    it('令牌错误 → close(1008, "unauthorized")，不产出通道，槽位随后可复用', async () => {
        const harness = await startedGate();
        const ws = rawConnect(harness.port);
        await opened(ws);
        const closed = clientClose(ws);
        ws.send("wrong-token");
        expect(await closed).toEqual({ code: 1008, reason: "unauthorized" });
        expect(harness.channels).toHaveLength(0);
        expect(harness.lost).toBe(0); // 未鉴权断开不触发脐带
        // 槽位已释放：正确令牌的后续连接可接入
        await authenticatedChannel(harness);
    });

    it("未鉴权连接静默断开：只清租户槽位，不触发脐带（端口扫描连断不杀 shim）", async () => {
        // 修复 2 契约：脐带只属于已鉴权租户；未交令牌的断开（扫描形态）不得触发关机信号
        const harness = await startedGate();
        const ws = rawConnect(harness.port);
        await opened(ws);
        const closed = clientClose(ws);
        ws.close();
        await closed;
        // 给误触留出异步观测窗：若实现回归（close 处理器无条件回调 lostHandler），此处即翻红
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
        });
        expect(harness.lost).toBe(0);
        expect(harness.channels).toHaveLength(0);
        // 槽位未泄露：后续租户仍可接入
        await authenticatedChannel(harness);
    });

    it("鉴权超时（authTimeoutMs 注入短时限）→ close(1008, unauthorized)，不动脐带，槽位释放", async () => {
        const harness = await startedGate({ authTimeoutMs: 100 });
        const ws = rawConnect(harness.port);
        await opened(ws);
        const closed = clientClose(ws);
        expect(await closed).toEqual({ code: 1008, reason: "unauthorized" });
        expect(harness.channels).toHaveLength(0);
        expect(harness.lost).toBe(0); // 超时关停 ≠ 脐带断
        await authenticatedChannel(harness); // 槽位已释放
    }, 5_000);
});

describe("IpcChannel 双向通路（鉴权后一帧一 JSON）", () => {
    it("客户端 → ipc.onMessage；ipc.send → 客户端", async () => {
        const harness = await startedGate();
        const { ws, ipc } = await authenticatedChannel(harness);
        const inbound = new Promise<string>((resolve) => {
            ipc.onMessage(resolve);
        });
        ws.send(
            JSON.stringify({ type: "game_chat", body: { playerName: "Steve", content: "hi" } }),
        );
        expect(await inbound).toBe(
            JSON.stringify({ type: "game_chat", body: { playerName: "Steve", content: "hi" } }),
        );

        const outbound = new Promise<string>((resolve) => {
            ws.once("message", (data) => {
                resolve(data.toString());
            });
        });
        ipc.send("push-frame");
        expect(await outbound).toBe("push-frame");
    });
});

describe("单租户（裁决册 §4.2：每轮看护尝试全新 spawn）", () => {
    it("已有租户时新连接被直接关闭，原通道与回执不受影响", async () => {
        const harness = await startedGate();
        const first = await authenticatedChannel(harness);
        const second = rawConnect(harness.port);
        const secondClosed = clientClose(second);
        await opened(second);
        await secondClosed;
        expect(harness.channels).toHaveLength(1); // 第二连接未成为租户
        // 原通道仍双向可用
        const outbound = new Promise<string>((resolve) => {
            first.ws.once("message", (data) => {
                resolve(data.toString());
            });
        });
        first.ipc.send("still-open");
        expect(await outbound).toBe("still-open");
    });
});

describe("脐带语义（D-08：通道断 ⇔ 关机信号）", () => {
    it("已鉴权连接断开 → ipc.onClose 触发 + onChannelLost 触发，槽位释放", async () => {
        const harness = await startedGate();
        const { ws, ipc } = await authenticatedChannel(harness);
        const ipcClosed = new Promise<void>((resolve) => {
            ipc.onClose(resolve);
        });
        ws.close();
        await ipcClosed;
        await vi.waitFor(() => {
            expect(harness.lost).toBe(1);
        });
        expect(ipc.isOpen).toBe(false);
        // 槽位释放：新租户可接入（看护器重拉后壳重连语义）
        await authenticatedChannel(harness);
    });

    it("gate.close() 主动关停：通道 onClose 触发但不触发脐带（closing 抑制），服务端关停", async () => {
        const harness = await startedGate();
        const { ws, ipc } = await authenticatedChannel(harness);
        const clientClosed = clientClose(ws);
        const ipcClosed = new Promise<void>((resolve) => {
            ipc.onClose(resolve);
        });
        await harness.gate.close();
        await ipcClosed;
        await clientClosed; // 客户端侧确认收到服务端主动 close
        expect(ipc.isOpen).toBe(false);
        expect(harness.lost).toBe(0); // 主动关停 ≠ 脐带断（单一出口：引导层自己发起）
        await expect(harness.gate.close()).resolves.toBeUndefined(); // close 幂等
    });
});
