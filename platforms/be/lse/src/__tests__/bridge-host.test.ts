/**
 * 一次「node shim 拉起尝试」的编排契约（裁决册 §4.2/§4.4）：
 * - 路径推导：pluginFilePath → dirname² = BDS 根；binDir = <root>/plugins/kurobridge/bin；
 *   node 缺失时回落 PATH 上的 node。命令串整段路径加引号（quote 最保守形态），携带
 *   --server-root / --game-port（20000-40000 随机）/ --game-token（randomGuid 去连字符），
 *   newProcess 以 timeLimit -1 fire-and-forget 拉起。
 * - happy path：newProcess true → GameChannel 握手（令牌+ready）→ 事件桥接开通（mc.listen 四事件）
 *   → ready resolve ready.autoRestart（缺省 true）。
 * - 失败源归一（AttemptHandle 双结算）：ready 前失败（newProcess false / 退出回调 /
 *   握手失败）→ ready reject；up 态（ready 后）通道失联 → done reject（修复 1 契约，
 *   看护器据此退避重生）；同一尝试的二次失败源在已结算后 no-op（不双计）。
 * quote/dirname/join 为模块私有未导出——经 newProcess 命令串这一观测缝间接断言（见报告缺口）。
 */
import { encodeFrame } from "@kuro-bridge/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attemptOnce } from "../bridge-host.js";
import type { AttemptHandle } from "../supervisor.js";

const PLUGIN_FILE = "/srv/bds/plugins/kurobridge";
const BIN = "/srv/bds/plugins/kurobridge/bin";
const GUID = "abcd-1234-efgh";
const TOKEN = "abcd1234efgh";

// 注意（见报告「疑似缺陷」）：bridge-host 的 root = dirname(dirname(filePath)) 只有在
// filePath 取「插件目录」时才得到 §4.1 部署布局的 <BDS 根>；裁决册 §4.2 把该公式与
// 「部署布局 <root>/plugins/kurobridge/index.js」（主脚本绝对路径）并写，两者互相矛盾
// （按主脚本解释会推出 <root>/plugins/plugins/kurobridge/bin）。此处按插件目录解释锚定
// （该解释与 §4.1 布局自洽）；公式本身已按裁决册 §4.2 原文锁定。

type ClientListener = (payload: never) => void;

/** 与 game-channel.test.ts 同款可编程 WSClient 假体（领地红线只许新建 *.test.ts，故就地复制） */
class FakeWSClient {
    static instances: FakeWSClient[] = [];

    readonly listeners = new Map<string, ClientListener>();
    readonly sent: string[] = [];
    closeCalls = 0;

    constructor() {
        FakeWSClient.instances.push(this);
    }

    listen(event: string, callback: ClientListener): boolean {
        this.listeners.set(event, callback);
        return true;
    }

    connectAsync(_target: string, callback: (success: boolean) => void): boolean {
        this.pendingConnect = callback;
        return true;
    }

    send(msg: string): boolean {
        this.sent.push(msg);
        return true;
    }

    close(): boolean {
        this.closeCalls += 1;
        return true;
    }

    private pendingConnect: ((success: boolean) => void) | null = null;

    answerConnect(success: boolean): void {
        this.pendingConnect?.(success);
        this.pendingConnect = null;
    }

    emitText(text: string): void {
        (this.listeners.get("onTextReceived") as unknown as ((msg: string) => void) | undefined)?.(
            text,
        );
    }

    emitLost(code: number): void {
        (
            this.listeners.get("onLostConnection") as unknown as
                | ((code: number) => void)
                | undefined
        )?.(code);
    }
}

type LogMock = ReturnType<typeof vi.fn<(message: string) => void>>;

interface LseStubs {
    readonly newProcess: ReturnType<typeof vi.fn>;
    readonly exitCallback: () => ((code: number, output: string) => void) | null;
    readonly listenEvents: string[];
    readonly logger: {
        readonly debug: LogMock;
        readonly info: LogMock;
        readonly warn: LogMock;
        readonly error: LogMock;
    };
}

/** 打桩 lse-env 全部 LSE 全局触点（ll/system/file/WSClient/mc）；newProcess 可编程返回值 */
function stubLse(options: { newProcessResult: boolean; nodeExeExists: boolean }): LseStubs {
    let onExit: ((code: number, output: string) => void) | null = null;
    const newProcess = vi.fn(
        (_command: string, callback: (code: number, output: string) => void) => {
            onExit = callback;
            return options.newProcessResult;
        },
    );
    const listenEvents: string[] = [];
    vi.stubGlobal("ll", {
        getCurrentPluginInfo: (): { filePath: string } => ({ filePath: PLUGIN_FILE }),
    });
    vi.stubGlobal("system", {
        newProcess,
        randomGuid: (): string => GUID,
    });
    vi.stubGlobal("file", { exists: vi.fn((): boolean => options.nodeExeExists) });
    vi.stubGlobal("WSClient", FakeWSClient);
    vi.stubGlobal("mc", {
        listen: (event: string, _listener: (...args: unknown[]) => void): boolean => {
            listenEvents.push(event);
            return true;
        },
    });
    const logger = {
        debug: vi.fn<(message: string) => void>(() => undefined),
        info: vi.fn<(message: string) => void>(() => undefined),
        warn: vi.fn<(message: string) => void>(() => undefined),
        error: vi.fn<(message: string) => void>(() => undefined),
    };
    return {
        newProcess,
        exitCallback: (): ((code: number, output: string) => void) | null => onExit,
        listenEvents,
        logger,
    };
}

function lastClient(): FakeWSClient {
    const client = FakeWSClient.instances[FakeWSClient.instances.length - 1];
    expect(client, "应已创建 WSClient").toBeDefined();
    return client as FakeWSClient;
}

/** 完成 令牌首帧 + ready 握手（happy path 收尾，同时撤销 30s deadline 定时器） */
function handshakeReady(client: FakeWSClient, wsPort: number): void {
    client.answerConnect(true);
    client.emitText(encodeFrame({ type: "ready", body: { wsPort } }));
}

/** done 生命线的吞异常挂载（生产由 supervisor 常挂 handler；测试避免无主 rejection） */
function observeDone(handle: AttemptHandle): void {
    void handle.done.catch(() => undefined);
}

beforeEach(() => {
    FakeWSClient.instances.length = 0;
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("命令串拼装与路径推导（quote/dirname/join 经 newProcess 观测缝断言）", () => {
    it("bin/node.exe 存在：整段路径引号包裹，--server-root 指向 BDS 根，端口在 20000-40000，令牌去连字符", async () => {
        vi.useFakeTimers();
        const stubs = stubLse({ newProcessResult: true, nodeExeExists: true });
        const handle = attemptOnce(stubs.logger);
        expect(stubs.newProcess).toHaveBeenCalledTimes(1);
        const [command, , timeLimit] = stubs.newProcess.mock.calls[0] as [string, unknown, number];
        const portMatch = /--game-port (\d+)/.exec(command);
        expect(portMatch).not.toBeNull();
        const port = Number(portMatch?.[1]);
        expect(port).toBeGreaterThanOrEqual(20_000);
        expect(port).toBeLessThanOrEqual(40_000);
        expect(command).toBe(
            `"${BIN}/node.exe" "${BIN}/index.mjs" --server-root "/srv/bds" --game-port ${port} --game-token ${TOKEN}`,
        );
        expect(timeLimit).toBe(-1); // fire-and-forget 不限时（裁决册 §3 R2′）
        expect(
            stubs.logger.info.mock.calls.some(([text]) => String(text).includes("拉起 node shim")),
        ).toBe(true);
        handshakeReady(lastClient(), port);
        await expect(handle.ready).resolves.toEqual({ autoRestart: true });
    });

    it("bin/node.exe 缺失：回落 PATH 上的 node（裸名同样整段加引号）", async () => {
        vi.useFakeTimers();
        const stubs = stubLse({ newProcessResult: true, nodeExeExists: false });
        const handle = attemptOnce(stubs.logger);
        const [command] = stubs.newProcess.mock.calls[0] as [string];
        expect(command.startsWith(`"node" "${BIN}/index.mjs"`)).toBe(true);
        handshakeReady(lastClient(), 1);
        await expect(handle.ready).resolves.toEqual({ autoRestart: true });
    });
});

describe("编排：happy path（ready → 事件桥接开通）", () => {
    it("newProcess 成功 + 令牌 + ready → ready resolve {autoRestart:true}，且 mc.listen 四事件注册", async () => {
        vi.useFakeTimers();
        const stubs = stubLse({ newProcessResult: true, nodeExeExists: true });
        const handle = attemptOnce(stubs.logger);
        handshakeReady(lastClient(), 34567);
        await expect(handle.ready).resolves.toEqual({ autoRestart: true });
        expect(stubs.listenEvents).toEqual(["onChat", "onJoin", "onLeft", "onPlayerDie"]);
        expect(
            stubs.logger.info.mock.calls.some(([text]) => String(text).includes("事件桥接已开通")),
        ).toBe(true);
        expect(
            stubs.logger.info.mock.calls.some(([text]) => String(text).includes("wsPort=34567")),
        ).toBe(true);
    });

    it("ready.autoRestart=false 透传给看护器结算", async () => {
        vi.useFakeTimers();
        const stubs = stubLse({ newProcessResult: true, nodeExeExists: true });
        const handle = attemptOnce(stubs.logger);
        const client = lastClient();
        client.answerConnect(true);
        client.emitText(encodeFrame({ type: "ready", body: { wsPort: 1, autoRestart: false } }));
        await expect(handle.ready).resolves.toEqual({ autoRestart: false });
    });
});

describe("失败源归一（裁决册 §4.4：ready 前 → ready reject）", () => {
    it("newProcess 返 false → ready reject「拉起失败」，不建 WS 连接、不装事件桥", async () => {
        vi.useFakeTimers();
        const stubs = stubLse({ newProcessResult: false, nodeExeExists: true });
        const handle = attemptOnce(stubs.logger);
        observeDone(handle); // ready 前失败同期结算 done，挂载防无主 rejection
        await expect(handle.ready).rejects.toThrow("newProcess 拉起 node shim 失败");
        expect(FakeWSClient.instances).toHaveLength(0);
        expect(stubs.listenEvents).toEqual([]);
    });

    it("退出回调先于 ready → ready reject（含 exit code），且通道关闭收尾（client.close 被调）", async () => {
        vi.useFakeTimers();
        const stubs = stubLse({ newProcessResult: true, nodeExeExists: true });
        const handle = attemptOnce(stubs.logger);
        observeDone(handle);
        const rejection = expect(handle.ready).rejects.toThrow("进程退出（code=1");
        const client = lastClient();
        // 连接已启动（令牌已发）但 ready 未达：进程退出回调先到 = 引导失败
        client.answerConnect(true);
        stubs.exitCallback()?.(1, "boot failure");
        await rejection;
        expect(client.closeCalls).toBe(1);
        expect(stubs.listenEvents).toEqual([]); // 失败路径不开事件桥
    });

    it("退出回调空输出时消息恰为进程退出文案（无输出尾巴）", async () => {
        vi.useFakeTimers();
        const stubs = stubLse({ newProcessResult: true, nodeExeExists: true });
        const handle = attemptOnce(stubs.logger);
        observeDone(handle);
        const rejection = expect(handle.ready).rejects.toThrow(/^node shim 进程退出（code=2）$/u);
        lastClient();
        stubs.exitCallback()?.(2, "");
        await rejection;
    });
});

describe("up 态生命线（修复 1 契约：ready 后失联 → done reject → 看护退避重生）", () => {
    it("ready 后通道失联 → done reject「游戏通道断开」，通道收尾；二次失败源不双计", async () => {
        vi.useFakeTimers();
        const stubs = stubLse({ newProcessResult: true, nodeExeExists: true });
        const handle = attemptOnce(stubs.logger);
        handshakeReady(lastClient(), 34567);
        await expect(handle.ready).resolves.toEqual({ autoRestart: true });
        const client = lastClient();
        const doneRejection = expect(handle.done).rejects.toThrow("游戏通道断开");
        client.emitLost(1006);
        await doneRejection;
        expect(client.closeCalls).toBe(1); // 失联即收尾（事件桥停用与关闭共用 fail 出口）
        stubs.exitCallback()?.(1, "late exit"); // 同一尝试的二次失败源：已结算后 no-op
        expect(client.closeCalls).toBe(1); // 不重复收尾、不双计失败
    });

    it("ready 后进程退出回调 → done reject（code 入消息），与失联路径同出口", async () => {
        vi.useFakeTimers();
        const stubs = stubLse({ newProcessResult: true, nodeExeExists: true });
        const handle = attemptOnce(stubs.logger);
        handshakeReady(lastClient(), 34567);
        await expect(handle.ready).resolves.toEqual({ autoRestart: true });
        const doneRejection = expect(handle.done).rejects.toThrow("进程退出（code=3");
        stubs.exitCallback()?.(3, "");
        await doneRejection;
    });
});
