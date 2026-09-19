/**
 * 回环 e2e（加分项）：起真 shim 关键件——GameGate + NodeWsServer + 真 core
 * （CoreContext/KurobridgeServer/Relay/BindingTable/AdminTable/FileConfigStore），组装镜像
 * runtime/index.ts 启动序列（不 import runtime/index.ts：该入口 import 即自跑 main）。
 *
 * 真 ws 客户端扮演两端：
 * - 壳端连 GameGate：令牌明文首帧 → 收 ready{wsPort, autoRestart}（FileConfigStore 实配驱动）。
 * - koishi 端连 NodeWsServer：hello（子协议 + token）→ hello_ack → 双向业务帧。
 * 只覆盖 gate↔Relay 边界（游戏事件出、broadcast/execute_command 进、回执回流闭环），
 * core 行为本身已有单测覆盖，此处不复刻。
 * 全部连接走 127.0.0.1 临时端口；config 落临时目录并在收尾清理。
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AdminTable,
    BindingTable,
    CoreContext,
    type IpcChannel,
    type KurobridgeConfig,
    KurobridgeServer,
    Relay,
} from "@kuro-bridge/bridge-core";
import {
    broadcastRequestFrame,
    commandResultFrame,
    encodeFrame,
    executeCommandRequestFrame,
    gameChatFrame,
    PROTOCOL_VERSION,
    readyFrame,
    WS_SUBPROTOCOL,
} from "@kuro-bridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket as ClientSocket, WebSocket } from "ws";

import { FileConfigStore } from "./config-store.js";
import { GameGate } from "./game-gate.js";
import { NodeClock, NodeScheduler } from "./platform.js";
import { NodeWsServer } from "./ws-server.js";

const CHANNEL = "114514";
const KOISHI_TOKEN = "koishi-secret";
const GAME_TOKEN = "game-session-token";
const TEXT_TIMEOUT_MS = 2_000;

type LogMock = ReturnType<typeof vi.fn<(message: string) => void>>;

/** 日志桩：各方法为带类型 mock（形状满足 core Logger），可按需断言 */
function makeLogger(): {
    readonly debug: LogMock;
    readonly info: LogMock;
    readonly warn: LogMock;
    readonly error: LogMock;
} {
    return {
        debug: vi.fn<(message: string) => void>(() => undefined),
        info: vi.fn<(message: string) => void>(() => undefined),
        warn: vi.fn<(message: string) => void>(() => undefined),
        error: vi.fn<(message: string) => void>(() => undefined),
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

interface ClientHandle {
    readonly ws: ClientSocket;
    readonly nextText: () => Promise<string>;
    sendText: (text: string) => void;
}

/** 文本帧队列：乱序到达的帧缓存，nextText 按序取（带超时防悬挂） */
function attachTextQueue(ws: ClientSocket): () => Promise<string> {
    const queue: string[] = [];
    const waiters: ((text: string) => void)[] = [];
    ws.on("message", (data) => {
        const text = data.toString();
        const waiter = waiters.shift();
        if (waiter !== undefined) {
            waiter(text);
            return;
        }
        queue.push(text);
    });
    return async (): Promise<string> => {
        const buffered = queue.shift();
        if (buffered !== undefined) {
            return buffered;
        }
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`等待对端帧超时（${TEXT_TIMEOUT_MS}ms）`));
            }, TEXT_TIMEOUT_MS);
        });
        try {
            return await Promise.race([
                new Promise<string>((resolve) => {
                    waiters.push(resolve);
                }),
                timeout,
            ]);
        } finally {
            clearTimeout(timer);
        }
    };
}

interface ShimHarness {
    readonly logger: ReturnType<typeof makeLogger>;
    readonly wsPort: number;
    readonly gatePort: number;
    relay: Relay | null;
    readonly server: KurobridgeServer;
    readonly wsServer: NodeWsServer;
    readonly gate: GameGate;
    readonly serverRoot: string;
    /** 脐带通知计数（修复 2 契约：仅已鉴权租户断开 +1） */
    readonly lost: number;
}

let harness: ShimHarness | null = null;
let koishiHandle: ClientHandle | null = null;

/** 组装 shim 关键件（镜像 runtime/index.ts 序列：配置 → core → 先绑 koishi WS → 再绑游戏通道） */
async function startShim(): Promise<ShimHarness> {
    const logger = makeLogger();
    const serverRoot = await mkdtemp(join(tmpdir(), "kurobridge-loopback-"));
    await mkdir(join(serverRoot, "plugins", "kurobridge"), { recursive: true });
    const configPath = join(serverRoot, "plugins", "kurobridge", "config.json");
    await writeFile(
        configPath,
        JSON.stringify({
            channels: [CHANNEL],
            token: KOISHI_TOKEN,
            admins: [{ channel: CHANNEL, users: ["admin-u"] }],
            runtime: { autoRestart: true },
        }),
        "utf8",
    );
    const configStore = new FileConfigStore({ logger, serverRoot });
    const config: KurobridgeConfig = await configStore.load();

    const context = new CoreContext({
        logger,
        serverId: "kurobridge",
        version: "0.1.0",
        token: config.token,
        newRequestId: randomUUID,
        clock: new NodeClock(),
        scheduler: new NodeScheduler(),
    });
    const bindings = new BindingTable(config.channels);
    const wsServer = new NodeWsServer({ host: "127.0.0.1", port: 0, logger });
    const server = new KurobridgeServer({
        context,
        wsServer,
        channelBindings: () => bindings.channels(),
    });
    const wsPort = await server.start();
    const gatePort = await freePort();
    const gate = new GameGate({ port: gatePort, token: GAME_TOKEN, logger });
    let lost = 0;
    gate.onChannelLost(() => {
        lost += 1;
    });
    const local: ShimHarness = {
        logger,
        wsPort,
        gatePort,
        relay: null,
        server,
        wsServer,
        gate,
        serverRoot,
        get lost() {
            return lost;
        },
    };
    gate.onChannel((ipc: IpcChannel) => {
        local.relay = new Relay({
            context,
            server,
            ipc,
            bindings,
            admins: new AdminTable(config.admins),
            configStore,
            ipcRequestTimeoutMs: 0, // 回执即时结算，不引入 10s 真定时器
        });
        // 鉴权即发 ready（autoRestart 随 ready 上报，v0.2.1）
        ipc.send(
            encodeFrame({
                type: "ready",
                body: { wsPort, autoRestart: config.runtime.autoRestart },
            }),
        );
    });
    await gate.start();
    harness = local;
    return local;
}

afterEach(async () => {
    const current = harness;
    harness = null;
    koishiHandle = null;
    if (current === null) {
        return;
    }
    current.relay?.dispose();
    await current.server.stop();
    await current.wsServer.stop();
    await current.gate.close().catch(() => undefined);
    await rm(current.serverRoot, { recursive: true, force: true });
});

/** 壳端：连 gate → 令牌明文首帧 → 收 ready（裁决册 §4.2 鉴权序列） */
async function connectShell(h: ShimHarness): Promise<ClientHandle> {
    const ws = new WebSocket(`ws://127.0.0.1:${h.gatePort}`);
    await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("壳连入 gate 失败")));
    });
    const nextText = attachTextQueue(ws);
    ws.send(GAME_TOKEN);
    const readyText = await nextText();
    const parsed = readyFrame.safeParse(JSON.parse(readyText));
    expect(parsed.success, "ready 帧应符合协议 readyFrame schema").toBe(true);
    if (parsed.success) {
        expect(parsed.data.body).toEqual({ wsPort: h.wsPort, autoRestart: true });
    }
    return { ws, nextText, sendText: (text: string) => void ws.send(text) };
}

/** koishi 端：子协议连入 → hello（token 鉴权）→ hello_ack ok */
async function connectKoishi(h: ShimHarness): Promise<ClientHandle> {
    const ws = new WebSocket(`ws://127.0.0.1:${h.wsPort}`, WS_SUBPROTOCOL);
    await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("koishi 连入失败")));
    });
    const nextText = attachTextQueue(ws);
    ws.send(
        JSON.stringify({
            header: { type: "hello", id: randomUUID() },
            body: {
                peerId: "loopback-e2e",
                platform: "stub",
                version: "0.0.1",
                protocolVersion: PROTOCOL_VERSION,
                token: KOISHI_TOKEN,
            },
        }),
    );
    const ack = JSON.parse(await nextText()) as {
        header: { type: string };
        body: { ok: boolean; channelBindings: readonly string[] };
    };
    expect(ack.header.type).toBe("hello_ack");
    expect(ack.body.ok).toBe(true);
    expect(ack.body.channelBindings).toEqual([CHANNEL]);
    const handle: ClientHandle = { ws, nextText, sendText: (text: string) => void ws.send(text) };
    koishiHandle = handle;
    return handle;
}

describe("gate↔Relay 边界：壳鉴权与 ready 上报", () => {
    it("壳令牌接入后首帧即 ready{wsPort, autoRestart}（wsPort 为 koishi WS 实际端口）", async () => {
        const h = await startShim();
        await connectShell(h);
    });

    it("未鉴权连接连断：不触发脐带、槽位释放，随后壳接入业务照常（修复 2 集成锚定）", async () => {
        const h = await startShim();
        const koishi = await connectKoishi(h);
        // 端口扫描形态：连入 gate、不交令牌、立即断开（此时租户槽位被该连接占住）
        const scanner = new WebSocket(`ws://127.0.0.1:${h.gatePort}`);
        await new Promise<void>((resolve, reject) => {
            scanner.addEventListener("open", () => resolve());
            scanner.addEventListener("error", () => reject(new Error("扫描连接失败")));
        });
        const scannerClosed = new Promise<void>((resolve) => {
            scanner.addEventListener("close", () => resolve());
        });
        scanner.close();
        await scannerClosed;
        // 未鉴权断开不得触发脐带（误触发 = shim 误关机 = 端口扫描即可杀服）
        expect(h.lost).toBe(0);
        // 槽位已释放：壳正常接入，且 game_chat 照常 fan-out 到 koishi
        const shell = await connectShell(h);
        shell.sendText(
            encodeFrame({
                type: "game_chat",
                body: { playerName: "Steve", content: "still alive" },
            }),
        );
        const chatText = await koishi.nextText();
        expect(JSON.parse(chatText).header.type).toBe("chat");
    });
});

describe("gate↔Relay 边界：游戏事件出（game_chat → WS chat）", () => {
    it("壳发 game_chat → 已握手 koishi 收到绑定频道的 chat 帧（协议 schema 校验）", async () => {
        const h = await startShim();
        const koishi = await connectKoishi(h);
        const shell = await connectShell(h);
        shell.sendText(
            encodeFrame({
                type: "game_chat",
                body: { playerName: "Steve", content: "hello gate" },
            }),
        );
        const chatText = await koishi.nextText();
        const parsed = gameChatFrame.safeParse(JSON.parse(chatText));
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.body).toEqual({
                channel: CHANNEL,
                playerName: "Steve",
                content: "hello gate",
            });
        }
    });
});

describe("gate↔Relay 边界：平台→游戏请求进 + 回执闭环", () => {
    it("koishi chat → 壳收 broadcast 请求（<sender> content、绑定频道）", async () => {
        const h = await startShim();
        await connectKoishi(h);
        const shell = await connectShell(h);
        koishiHandle?.sendText(
            JSON.stringify({
                header: { type: "chat" },
                body: { channel: CHANNEL, sender: "Admin", content: "hi all" },
            }),
        );
        const requestText = await shell.nextText();
        const parsed = broadcastRequestFrame.safeParse(JSON.parse(requestText));
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.body).toEqual({ channel: CHANNEL, message: "<Admin> hi all" });
            // 回执送达（Relay 在途请求结算由 core 单测覆盖，此处验证边界不拒绝回执帧）
            shell.sendText(
                encodeFrame({ type: "broadcast_result", id: parsed.data.id, body: { ok: true } }),
            );
        }
    });

    it("koishi command（管理员）→ 壳收 execute_command → 回执 → koishi 收同 id command_result", async () => {
        const h = await startShim();
        const koishi = await connectKoishi(h);
        const shell = await connectShell(h);
        const commandId = randomUUID();
        koishi.sendText(
            JSON.stringify({
                header: { type: "command", id: commandId },
                body: { command: "list", source: { channel: CHANNEL, userId: "admin-u" } },
            }),
        );
        const requestText = await shell.nextText();
        const parsed = executeCommandRequestFrame.safeParse(JSON.parse(requestText));
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.body).toEqual({ command: "list" });
            shell.sendText(
                encodeFrame({
                    type: "execute_command_result",
                    id: parsed.data.id,
                    body: { ok: true, output: ["1 player online"] },
                }),
            );
        }
        const result = commandResultFrame.safeParse(JSON.parse(await koishi.nextText()));
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data).toEqual({
                type: "command_result",
                id: commandId,
                body: { ok: true, output: ["1 player online"] },
            });
        }
    });
});
