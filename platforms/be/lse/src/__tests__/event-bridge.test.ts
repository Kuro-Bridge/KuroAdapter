/**
 * 事件桥接契约（裁决册 §4.3）：
 * - install 注册 mc.listen 四事件（onChat/onJoin/onLeft/onPlayerDie）+ 通道帧订阅。
 * - 事件 → IPC 方言事件帧（playerName 取 realName、死亡 message 恒空串）。
 * - broadcast → mc.runcmd("say <message>") + 立即回 broadcast_result{ok:true}（同 id）。
 * - execute_command → mc.runcmdEx + 回执 ok=success、output 按行拆分；抛异常 → ok:false。
 * - 通道未就绪/已停用：事件与请求静默丢弃不抛（对齐 JE ipc==null 语义）。
 * LSE 全局（mc）全程打桩，通道用可编程 fake（isOpen 可翻转）。
 */
import {
    broadcastResultFrame,
    executeCommandResultFrame,
    gameChatEventFrame,
    playerDeathEventFrame,
    playerJoinEventFrame,
    playerQuitEventFrame,
} from "@kuro-bridge/protocol";
import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { EventBridge } from "../event-bridge.js";
import type { HostInbound } from "../frames.js";
import type { GameChannel } from "../game-channel.js";

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

interface ListenCall {
    readonly event: string;
    readonly listener: (...args: unknown[]) => void;
}

interface McStub {
    readonly listens: ListenCall[];
    readonly runcmd: MockInstance<(command: string) => boolean>;
    readonly runcmdEx: MockInstance<(command: string) => { success: boolean; output: string }>;
}

/** mc 命名空间打桩：记录 listen 注册，runcmd/runcmdEx 可编程 */
function stubMc(): McStub {
    const listens: ListenCall[] = [];
    const mc = {
        listen: (event: string, listener: (...args: unknown[]) => void): boolean => {
            listens.push({ event, listener });
            return true;
        },
        runcmd: vi.fn((_command: string) => true),
        runcmdEx: vi.fn((_command: string) => ({ success: true, output: "" })),
        regConsoleCmd: vi.fn(
            (_command: string, _description: string, _callback: (args: string[]) => void) => true,
        ),
    };
    vi.stubGlobal("mc", mc);
    return {
        listens,
        runcmd: mc.runcmd,
        runcmdEx: mc.runcmdEx,
    };
}

/** 可编程通道 fake：isOpen 可翻转（关闭语义），send/onFrame 捕获 */
function stubChannel(open: boolean): {
    readonly channel: GameChannel;
    readonly sent: string[];
    readonly frameHandlers: ((frame: HostInbound) => void)[];
    setOpen: (open: boolean) => void;
} {
    const sent: string[] = [];
    const frameHandlers: ((frame: HostInbound) => void)[] = [];
    let isOpen = open;
    const channel = {
        get isOpen(): boolean {
            return isOpen;
        },
        send: (text: string): void => {
            sent.push(text);
        },
        onFrame: (handler: (frame: HostInbound) => void): void => {
            frameHandlers.push(handler);
        },
    };
    return {
        channel: channel as unknown as GameChannel,
        sent,
        frameHandlers,
        setOpen: (value: boolean): void => {
            isOpen = value;
        },
    };
}

function playerOf(realName: string): Player {
    return { realName } as unknown as Player;
}

function listenerFor(listens: ListenCall[], event: string): (...args: unknown[]) => void {
    const found = listens.find((entry) => entry.event === event);
    expect(found, `应已注册 ${event} 监听`).toBeDefined();
    if (found === undefined) {
        return (): void => undefined;
    }
    return found.listener;
}

function sentFrame(sent: string[], index: number): Record<string, unknown> {
    const text = sent[index];
    expect(text).toBeDefined();
    return JSON.parse(text ?? "") as Record<string, unknown>;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("install：mc.listen 四事件 + 通道帧订阅（裁决册 §4.3 事件词汇）", () => {
    it("注册事件名精确为 onChat/onJoin/onLeft/onPlayerDie，且订阅通道帧", () => {
        const mc = stubMc();
        const bridge = new EventBridge();
        const { channel, frameHandlers } = stubChannel(true);
        bridge.install(channel);
        expect(mc.listens.map((entry) => entry.event)).toEqual([
            "onChat",
            "onJoin",
            "onLeft",
            "onPlayerDie",
        ]);
        expect(frameHandlers).toHaveLength(1);
        bridge.uninstall();
    });

    it("重复 install 幂等（不重复注册监听）", () => {
        const mc = stubMc();
        const bridge = new EventBridge();
        const first = stubChannel(true);
        bridge.install(first.channel);
        bridge.install(first.channel);
        expect(mc.listens).toHaveLength(4);
        bridge.uninstall();
    });
});

describe("游戏事件 → 事件帧（通道开启时逐事件发出）", () => {
    it("chat：realName 作为 playerName，可被 gameChatEventFrame 解析回", () => {
        const mc = stubMc();
        const bridge = new EventBridge();
        const { channel, sent } = stubChannel(true);
        bridge.install(channel);
        listenerFor(mc.listens, "onChat")(playerOf("Steve"), "hello world");
        expect(sent).toHaveLength(1);
        const wire = sentFrame(sent, 0);
        expect(wire["header"]).toEqual({ type: "game_chat" });
        const parsed = gameChatEventFrame.safeParse(wire);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.body).toEqual({ playerName: "Steve", content: "hello world" });
        }
        bridge.uninstall();
    });

    it("join/left：player_join 与 player_quit 各一帧（realName）", () => {
        const mc = stubMc();
        const bridge = new EventBridge();
        const { channel, sent } = stubChannel(true);
        bridge.install(channel);
        listenerFor(mc.listens, "onJoin")(playerOf("Alex"));
        listenerFor(mc.listens, "onLeft")(playerOf("Alex"));
        expect(sent).toHaveLength(2);
        const join = playerJoinEventFrame.safeParse(sentFrame(sent, 0));
        const quit = playerQuitEventFrame.safeParse(sentFrame(sent, 1));
        expect(join.success && join.data.body).toEqual({ playerName: "Alex" });
        expect(quit.success && quit.data.body).toEqual({ playerName: "Alex" });
        bridge.uninstall();
    });

    it("die：player_death 帧 message 恒空串（onPlayerDie 无文案参数）", () => {
        const mc = stubMc();
        const bridge = new EventBridge();
        const { channel, sent } = stubChannel(true);
        bridge.install(channel);
        listenerFor(mc.listens, "onPlayerDie")(playerOf("Steve"), "fall");
        expect(sent).toHaveLength(1);
        const parsed = playerDeathEventFrame.safeParse(sentFrame(sent, 0));
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.body).toEqual({ player: "Steve", message: "" });
        }
        bridge.uninstall();
    });
});

describe("通道不可用：静默丢弃不抛（对齐 JE ipc==null 语义）", () => {
    it("isOpen=false 时四事件与请求均不出帧、不执行命令", () => {
        const mc = stubMc();
        const bridge = new EventBridge();
        const { channel, sent, frameHandlers } = stubChannel(false);
        bridge.install(channel);
        listenerFor(mc.listens, "onChat")(playerOf("Steve"), "hi");
        listenerFor(mc.listens, "onJoin")(playerOf("Steve"));
        listenerFor(mc.listens, "onLeft")(playerOf("Steve"));
        listenerFor(mc.listens, "onPlayerDie")(playerOf("Steve"), "fall");
        frameHandlers[0]?.({
            type: "broadcast",
            id: UUID,
            body: { channel: "114514", message: "hi" },
        });
        expect(sent).toHaveLength(0);
        expect(mc.runcmd).not.toHaveBeenCalled();
        expect(mc.runcmdEx).not.toHaveBeenCalled();
        bridge.uninstall();
    });

    it("uninstall 后事件静默丢弃（不反注册，处理器内自判）", () => {
        const mc = stubMc();
        const bridge = new EventBridge();
        const { channel, sent } = stubChannel(true);
        bridge.install(channel);
        bridge.uninstall();
        expect(() => {
            listenerFor(mc.listens, "onChat")(playerOf("Steve"), "hi");
        }).not.toThrow();
        expect(sent).toHaveLength(0);
    });

    it("通道中途关闭：翻转 isOpen 后事件开始丢弃", () => {
        const mc = stubMc();
        const bridge = new EventBridge();
        const { channel, sent, setOpen } = stubChannel(true);
        bridge.install(channel);
        listenerFor(mc.listens, "onJoin")(playerOf("Steve"));
        setOpen(false);
        listenerFor(mc.listens, "onJoin")(playerOf("Alex"));
        expect(sent).toHaveLength(1);
        bridge.uninstall();
    });
});

describe("shim 请求 → mc 命令 + 立即回执", () => {
    it('broadcast：mc.runcmd 收到 "say <message>"，并回同 id broadcast_result{ok:true}', () => {
        const mc = stubMc();
        const bridge = new EventBridge();
        const { channel, sent, frameHandlers } = stubChannel(true);
        bridge.install(channel);
        frameHandlers[0]?.({
            type: "broadcast",
            id: UUID,
            body: { channel: "114514", message: "server event" },
        });
        expect(mc.runcmd).toHaveBeenCalledExactlyOnceWith("say server event");
        expect(sent).toHaveLength(1);
        const wire = sentFrame(sent, 0);
        const parsed = broadcastResultFrame.safeParse(wire);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data).toEqual({ type: "broadcast_result", id: UUID, body: { ok: true } });
        }
        bridge.uninstall();
    });

    it("execute_command：mc.runcmdEx 被调，回执 ok=success、output 按行拆分（多行 + 收尾空行 + CRLF）", () => {
        const mc = stubMc();
        mc.runcmdEx.mockReturnValue({ success: true, output: "line1\r\nline2\n\n" });
        const bridge = new EventBridge();
        const { channel, sent, frameHandlers } = stubChannel(true);
        bridge.install(channel);
        frameHandlers[0]?.({ type: "execute_command", id: UUID, body: { command: "list" } });
        expect(mc.runcmdEx).toHaveBeenCalledExactlyOnceWith("list");
        const parsed = executeCommandResultFrame.safeParse(sentFrame(sent, 0));
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data).toEqual({
                type: "execute_command_result",
                id: UUID,
                body: { ok: true, output: ["line1", "line2"] },
            });
        }
        bridge.uninstall();
    });

    it("execute_command：空输出成功回执只有 ok（无 output 字段）", () => {
        const mc = stubMc();
        mc.runcmdEx.mockReturnValue({ success: true, output: "" });
        const bridge = new EventBridge();
        const { channel, sent, frameHandlers } = stubChannel(true);
        bridge.install(channel);
        frameHandlers[0]?.({ type: "execute_command", id: UUID, body: { command: "say hi" } });
        const wire = sentFrame(sent, 0);
        expect(JSON.stringify(wire)).not.toContain("output");
        const parsed = executeCommandResultFrame.safeParse(wire);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.body).toEqual({ ok: true });
        }
        bridge.uninstall();
    });

    it("execute_command：success=false → ok:false + error（output 行合并；空输出兜底文案）", () => {
        const mc = stubMc();
        const bridge = new EventBridge();
        const { channel, sent, frameHandlers } = stubChannel(true);
        bridge.install(channel);

        mc.runcmdEx.mockReturnValue({ success: false, output: "unknown command\n" });
        frameHandlers[0]?.({ type: "execute_command", id: UUID, body: { command: "nope" } });
        const failed = executeCommandResultFrame.safeParse(sentFrame(sent, 0));
        expect(failed.success && failed.data.body).toEqual({ ok: false, error: "unknown command" });

        mc.runcmdEx.mockReturnValue({ success: false, output: "" });
        frameHandlers[0]?.({ type: "execute_command", id: UUID, body: { command: "nope" } });
        const fallback = executeCommandResultFrame.safeParse(sentFrame(sent, 1));
        expect(fallback.success && fallback.data.body).toEqual({
            ok: false,
            error: "命令执行失败",
        });
        bridge.uninstall();
    });

    it("runcmdEx 抛异常 → 回执 ok:false + error 携带异常文本（不向通道层抛）", () => {
        const mc = stubMc();
        mc.runcmdEx.mockImplementation(() => {
            throw new Error("mc exploded");
        });
        const bridge = new EventBridge();
        const { channel, sent, frameHandlers } = stubChannel(true);
        bridge.install(channel);
        expect(() => {
            frameHandlers[0]?.({ type: "execute_command", id: UUID, body: { command: "boom" } });
        }).not.toThrow();
        const parsed = executeCommandResultFrame.safeParse(sentFrame(sent, 0));
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.body).toEqual({ ok: false, error: "Error: mc exploded" });
        }
        bridge.uninstall();
    });
});
