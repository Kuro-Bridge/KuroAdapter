/**
 * 游戏通道握手与传输契约（裁决册 §4.2 鉴权 / §4.4 尝试）：
 * - open = connectAsync 重试（固定 500ms 间隔）→ 连上即发令牌明文首帧 → ready 帧到达
 *   才 resolve（总 deadline 由调用方给定，看护器 30s，裁决册 §4.4）。
 * - 失败源：connectAsync 持续失败 → 重试至 deadline reject；onError / onLostConnection →
 *   onLost 注册方；ready 前收到其他帧（乱序 broadcast）按握手失败结算，不悬挂不崩。
 * - 握手后：帧经 decodeHostInbound 分派 onFrame；畸形帧丢弃；send 在关闭态静默丢弃。
 * WSClient 全程打桩（可编程 FakeWSClient），定时用 fake timers（lse-env 走全局 setTimeout）。
 */
import { encodeFrame } from "@kuro-bridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GameChannel } from "../game-channel.js";

type ClientListener = (payload: never) => void;

/** 可编程 WSClient 假体：三件套（connectAsync/send/listen）行为可逐用例定制 */
class FakeWSClient {
    static instances: FakeWSClient[] = [];
    /** 预置下一个实例的初值：connectAsync 首调在 open() 内同步发生，只能类级预置 */
    static nextLaunched = true;
    static nextAutoConnect: boolean | null = null;

    readonly listeners = new Map<string, ClientListener>();
    readonly sent: string[] = [];
    closeCalls = 0;
    connectAsyncCalls = 0;
    /** connectAsync 的返回值（是否成功启动连接尝试） */
    launchedResult: boolean;
    /** null = 不自动应答（测试手动驱动回调）；否则 connectAsync 同步应答该结果 */
    autoConnectResult: boolean | null;
    sendResult = true;

    constructor() {
        FakeWSClient.instances.push(this);
        this.launchedResult = FakeWSClient.nextLaunched;
        FakeWSClient.nextLaunched = true;
        this.autoConnectResult = FakeWSClient.nextAutoConnect;
        FakeWSClient.nextAutoConnect = null;
    }

    listen(event: string, callback: ClientListener): boolean {
        this.listeners.set(event, callback);
        return true;
    }

    connectAsync(_target: string, callback: (success: boolean) => void): boolean {
        this.connectAsyncCalls += 1;
        if (!this.launchedResult) {
            return false;
        }
        if (this.autoConnectResult !== null) {
            callback(this.autoConnectResult);
        } else {
            this.pendingConnect = callback;
        }
        return true;
    }

    send(msg: string): boolean {
        this.sent.push(msg);
        return this.sendResult;
    }

    close(): boolean {
        this.closeCalls += 1;
        return true;
    }

    private pendingConnect: ((success: boolean) => void) | null = null;

    /** 测试驱动：应答 connectAsync（成功后 send 已携带令牌的断言由用例负责） */
    answerConnect(success: boolean): void {
        this.pendingConnect?.(success);
        this.pendingConnect = null;
    }

    emitText(text: string): void {
        (this.listeners.get("onTextReceived") as unknown as ((msg: string) => void) | undefined)?.(
            text,
        );
    }

    emitError(message: string): void {
        (this.listeners.get("onError") as unknown as ((msg: string) => void) | undefined)?.(
            message,
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

function readyText(wsPort: number): string {
    return encodeFrame({ type: "ready", body: { wsPort } });
}

function lastClient(): FakeWSClient {
    const client = FakeWSClient.instances[FakeWSClient.instances.length - 1];
    expect(client, "GameChannel 应已创建 WSClient 实例").toBeDefined();
    return client as FakeWSClient;
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("open：令牌明文首帧 + ready 握手（裁决册 §4.2 鉴权序列）", () => {
    it("connectAsync 成功 → 首帧发令牌明文（非 JSON）→ ready 到达后 resolve 且 isOpen=true", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("WSClient", FakeWSClient);
        const channel = new GameChannel();
        const frames: unknown[] = [];
        channel.onFrame((frame) => {
            frames.push(frame);
        });
        const opening = channel.open("ws://127.0.0.1:23456", "tok-abc", 30_000);
        const client = lastClient();
        // 三件套事件在连接尝试前注册（onTextReceived / onError / onLostConnection）
        expect([...client.listeners.keys()].sort()).toEqual([
            "onError",
            "onLostConnection",
            "onTextReceived",
        ]);
        client.answerConnect(true);
        expect(client.sent).toEqual(["tok-abc"]);
        expect(() => JSON.parse(client.sent[0] ?? "")).toThrow();
        client.emitText(readyText(34567));
        await expect(opening).resolves.toBeUndefined();
        expect(channel.isOpen).toBe(true);
        // ready 帧同样投递 onFrame（看护器据其读取 autoRestart）
        expect(frames).toEqual([{ type: "ready", body: { wsPort: 34567 } }]);
        channel.close();
    });

    it("connectAsync 返回 false（未启动）→ 500ms 后重试，最终 connectAsync 再次被调", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("WSClient", FakeWSClient);
        FakeWSClient.nextLaunched = false;
        const channel = new GameChannel();
        const opening = channel.open("ws://127.0.0.1:23456", "tok", 30_000);
        const client = lastClient();
        expect(client.connectAsyncCalls).toBe(1);
        // connectAsync 返回 false：无回调可答，重试只能靠定时器（固定 500ms 间隔）
        await vi.advanceTimersByTimeAsync(500);
        expect(client.connectAsyncCalls).toBe(2);
        await vi.advanceTimersByTimeAsync(500);
        expect(client.connectAsyncCalls).toBe(3);
        // 尝试启动成功后走正常握手收尾，避免悬挂定时器
        client.launchedResult = true;
        client.answerConnect(true);
        client.emitText(readyText(1));
        await expect(opening).resolves.toBeUndefined();
        channel.close();
    });

    it("connectAsync 持续失败 → 固定间隔重试至 deadline，reject「重试耗尽」且尝试次数有界", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("WSClient", FakeWSClient);
        FakeWSClient.nextAutoConnect = false;
        const channel = new GameChannel();
        const opening = channel.open("ws://127.0.0.1:23456", "tok", 3_000);
        // 先挂 reject 断言再推时钟：拒绝发生在定时器 tick 内，避免无主 rejection
        const rejection = expect(opening).rejects.toThrow("重试耗尽");
        const client = lastClient();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(client.connectAsyncCalls).toBe(5); // t=0,500,1000,1500,2000；尚未失败
        await vi.advanceTimersByTimeAsync(500);
        await rejection;
        expect(client.connectAsyncCalls).toBe(6); // t=2500：下一次重试越界，按 deadline 结算
        expect(channel.isOpen).toBe(false);
    });

    it("connectAsync 启动但永不应答 → deadline 超时 reject「握手超时」", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("WSClient", FakeWSClient);
        const channel = new GameChannel();
        const opening = channel.open("ws://127.0.0.1:23456", "tok", 30_000);
        const rejection = expect(opening).rejects.toThrow("握手超时");
        await vi.advanceTimersByTimeAsync(30_000);
        await rejection;
    });

    it("令牌已发（connected）后 onError → reject「WS 错误」", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("WSClient", FakeWSClient);
        const channel = new GameChannel();
        const opening = channel.open("ws://127.0.0.1:23456", "tok", 30_000);
        const client = lastClient();
        client.answerConnect(true);
        client.emitError("boom");
        await expect(opening).rejects.toThrow("WS 错误");
        expect(channel.isOpen).toBe(false);
    });

    it("ready 前收到 broadcast（乱序）→ 握手按失败结算，不悬挂不崩", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("WSClient", FakeWSClient);
        const channel = new GameChannel();
        const opening = channel.open("ws://127.0.0.1:23456", "tok", 30_000);
        const client = lastClient();
        client.answerConnect(true);
        client.emitText(
            encodeFrame({
                type: "broadcast",
                id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
                body: { channel: "c", message: "m" },
            }),
        );
        await expect(opening).rejects.toThrow("非预期帧：broadcast");
        expect(channel.isOpen).toBe(false);
    });

    it("open 后令牌发送失败（send=false）→ reject，不悬挂", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("WSClient", FakeWSClient);
        const channel = new GameChannel();
        const opening = channel.open("ws://127.0.0.1:23456", "tok", 30_000);
        const client = lastClient();
        client.sendResult = false;
        client.answerConnect(true);
        await expect(opening).rejects.toThrow("令牌首帧发送失败");
    });

    it("实例单次使用：open 在途时再 open 直接 reject（每轮尝试新建，close 后允许重开）", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("WSClient", FakeWSClient);
        const channel = new GameChannel();
        const first = channel.open("ws://127.0.0.1:1", "tok", 30_000);
        // 首次 open 仍在途（client 已占位）→ 第二次 open 被拒
        await expect(channel.open("ws://127.0.0.1:1", "tok", 30_000)).rejects.toThrow("不可复用");
        // 首次 open 走通握手后 close 归位；close 置空 client，下一轮看护尝试可新建
        const client = lastClient();
        client.answerConnect(true);
        client.emitText(readyText(1));
        await first;
        channel.close();
        expect(client.closeCalls).toBe(1);
    });
});

describe("握手后：帧分派 / 失连通知 / 关闭语义", () => {
    interface Opened {
        readonly channel: GameChannel;
        readonly client: FakeWSClient;
        readonly frames: unknown[];
        readonly lost: string[];
    }

    /** 直接搭好已开通通道（ready 已交换） */
    async function openEstablished(): Promise<Opened> {
        vi.useFakeTimers();
        vi.stubGlobal("WSClient", FakeWSClient);
        const channel = new GameChannel();
        const frames: unknown[] = [];
        const lost: string[] = [];
        channel.onFrame((frame) => {
            frames.push(frame);
        });
        channel.onLost((reason) => {
            lost.push(reason);
        });
        const opening = channel.open("ws://127.0.0.1:23456", "tok", 30_000);
        const client = lastClient();
        client.answerConnect(true);
        client.emitText(readyText(1));
        await opening;
        frames.length = 0; // 握手期 ready 帧不计入后续分派断言
        return { channel, client, frames, lost };
    }

    it("文本帧经 decodeHostInbound 分派 onFrame；畸形帧静默丢弃", async () => {
        const { channel, client, frames } = await openEstablished();
        client.emitText(
            encodeFrame({
                type: "broadcast",
                id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
                body: { channel: "c", message: "m" },
            }),
        );
        client.emitText("{garbage");
        expect(frames).toEqual([
            {
                type: "broadcast",
                id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
                body: { channel: "c", message: "m" },
            },
        ]);
        channel.close();
    });

    it("onLostConnection → onLost handler 触发（reason 含 code），isOpen 翻 false", async () => {
        const { channel, client, lost } = await openEstablished();
        client.emitLost(1006);
        expect(lost).toHaveLength(1);
        expect(lost[0]).toContain("1006");
        expect(channel.isOpen).toBe(false);
        channel.close();
    });

    it("onError（握手后）同样视为失连并通知 onLost", async () => {
        const { channel, client, lost } = await openEstablished();
        client.emitError("reset");
        expect(lost).toHaveLength(1);
        expect(lost[0]).toContain("reset");
        channel.close();
    });

    it("开启态 send 走 client.send；client.send=false 时静默不抛", async () => {
        const { channel, client } = await openEstablished();
        channel.send(encodeFrame({ type: "game_chat", body: { playerName: "S", content: "hi" } }));
        expect(client.sent).toEqual([
            "tok",
            encodeFrame({ type: "game_chat", body: { playerName: "S", content: "hi" } }),
        ]);
        client.sendResult = false;
        expect(() => {
            channel.send("x");
        }).not.toThrow();
        channel.close();
    });

    it("close：client.close 被调、isOpen=false、其后 send 静默丢弃", async () => {
        const { channel, client } = await openEstablished();
        channel.close();
        expect(client.closeCalls).toBe(1);
        expect(channel.isOpen).toBe(false);
        const sentBefore = client.sent.length;
        channel.send("late");
        expect(client.sent).toHaveLength(sentBefore);
    });

    it("close 对 client.close 抛错免疫（对端已死收尾不抛）", async () => {
        const { channel, client } = await openEstablished();
        client.close = (): boolean => {
            throw new Error("already dead");
        };
        expect(() => {
            channel.close();
        }).not.toThrow();
    });
});
