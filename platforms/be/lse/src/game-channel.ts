/**
 * 游戏通道：壳 ↔ node shim 的回环 WS 客户端封装（WSClient）。
 *
 * open = connectAsync 重试（固定间隔）→ 令牌明文首帧 → 等 ready 帧，总 deadline 由
 * 调用方给定（看护器对齐 30s，裁决册 §4.4）；任一环节失败 reject。
 * 令牌投递双路（真机 2026-10-25 裁定，裁决册 §6.2）：connectAsync 回调路径
 * （QuickJS 等后端，连上即发）+ 令牌泵（LSE-nodejs 的 connectAsync 回调实测不触发，
 * 事件面正常；泵每 200ms 试 send，连接建立即成功送达，tokenSent 守卫保证只发一次）。
 * 未送达令牌期的 onError / onLostConnection 按连接尝试失败推进重试，不悬挂至 deadline。
 * 握手完成后每个文本帧经 decodeHostInbound 分派给 onFrame 注册方（ready 帧同样投递，
 * 看护器据其读取 autoRestart）；onError / onLostConnection 均视为失连，通知 onLost 注册方。
 * 实例单次使用（每轮看护尝试新建），close 后不得复用。
 */
import { decodeHostInbound, type HostInbound } from "./frames.js";
import {
    cancelTimer,
    createWsClient,
    logDebug,
    scheduleTimer,
    type TimerHandle,
} from "./lse-env.js";

const CONNECT_RETRY_DELAY_MS = 500;
/** 令牌泵间隔：send 即时返回（未连接 false / 已连接 true），以此探测连接就绪 */
const TOKEN_PUMP_INTERVAL_MS = 200;

/** open 等待期的事件汇（握手结算入口；open 后置回 null，改走 frameHandlers 分派） */
type SinkEvent = { kind: "text"; text: string } | { kind: "error"; message: string };

export class GameChannel {
    private client: WSClient | null = null;
    private opened = false;
    private sink: ((event: SinkEvent) => void) | null = null;
    private readonly frameHandlers: ((frame: HostInbound) => void)[] = [];
    private readonly lostHandlers: ((reason: string) => void)[] = [];

    get isOpen(): boolean {
        return this.opened;
    }

    async open(url: string, token: string, deadlineMs: number): Promise<void> {
        if (this.client !== null) {
            return await Promise.reject(new Error("游戏通道实例不可复用（每轮尝试新建）"));
        }
        const client = createWsClient();
        this.client = client;
        client.listen("onTextReceived", (msg) => {
            this.handleText(msg);
        });
        client.listen("onError", (msg) => {
            this.handleTransportDown(`WS 错误：${msg}`);
        });
        client.listen("onLostConnection", (code) => {
            this.handleTransportDown(`WS 断连（code=${code}）`);
        });
        return await new Promise<void>((resolve, reject) => {
            let settled = false;
            let connected = false;
            let tokenSent = false;
            let retryTimer: TimerHandle | null = null;
            let pumpTimer: TimerHandle | null = null;
            const startedAt = Date.now();
            const stopPump = (): void => {
                if (pumpTimer !== null) {
                    cancelTimer(pumpTimer);
                    pumpTimer = null;
                }
            };
            const cleanup = (): void => {
                cancelTimer(deadlineTimer);
                if (retryTimer !== null) {
                    cancelTimer(retryTimer);
                    retryTimer = null;
                }
                stopPump();
                this.sink = null;
            };
            const fail = (reason: string): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                reject(new Error(reason));
            };
            const succeed = (): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                this.opened = true;
                resolve();
            };
            const deadlineTimer = scheduleTimer(() => {
                fail(`游戏通道握手超时（${deadlineMs}ms 内未完成令牌与 ready 握手）`);
            }, deadlineMs);
            const markTokenSent = (): void => {
                tokenSent = true;
                connected = true;
                stopPump();
            };
            const scheduleRetry = (): void => {
                if (settled || retryTimer !== null) {
                    return;
                }
                if (Date.now() - startedAt + CONNECT_RETRY_DELAY_MS >= deadlineMs) {
                    fail("游戏通道连接重试耗尽握手 deadline");
                    return;
                }
                retryTimer = scheduleTimer(() => {
                    retryTimer = null;
                    attemptConnect();
                }, CONNECT_RETRY_DELAY_MS);
            };
            const pump = (): void => {
                pumpTimer = null;
                if (settled || tokenSent) {
                    return;
                }
                if (client.send(token)) {
                    markTokenSent();
                    return;
                }
                pumpTimer = scheduleTimer(pump, TOKEN_PUMP_INTERVAL_MS);
            };
            const attemptConnect = (): void => {
                if (settled) {
                    return;
                }
                const launched = client.connectAsync(url, (success) => {
                    if (settled || tokenSent) {
                        return;
                    }
                    if (!success) {
                        scheduleRetry();
                        return;
                    }
                    // 回调路径（QuickJS 等后端）：连上即发令牌；nodejs 后端回调不触发，由泵补位
                    if (!client.send(token)) {
                        fail("游戏通道令牌首帧发送失败");
                        return;
                    }
                    markTokenSent();
                });
                if (!launched) {
                    scheduleRetry();
                }
                if (pumpTimer === null && !tokenSent) {
                    pumpTimer = scheduleTimer(pump, TOKEN_PUMP_INTERVAL_MS);
                }
            };
            this.sink = (event) => {
                if (event.kind === "error") {
                    // 令牌已送达：连接已建立后的传输错误按握手失败结算
                    if (connected) {
                        fail(event.message);
                        return;
                    }
                    // 令牌未送达：该次连接尝试已死，推进重试（不悬挂至 deadline）
                    scheduleRetry();
                    return;
                }
                const frame = decodeHostInbound(event.text);
                if (frame === null) {
                    return;
                }
                if (frame.type !== "ready") {
                    fail(`ready 前收到非预期帧：${frame.type}`);
                    return;
                }
                this.dispatchFrame(frame);
                succeed();
            };
            attemptConnect();
        });
    }

    /** 通道未开启时静默丢弃（对齐 JE ipc==null 语义） */
    send(text: string): void {
        const client = this.client;
        if (!this.opened || client === null) {
            return;
        }
        if (!client.send(text)) {
            logDebug("游戏通道发送失败（忽略，等待失连通知收尾）");
        }
    }

    onFrame(handler: (frame: HostInbound) => void): void {
        this.frameHandlers.push(handler);
    }

    onLost(handler: (reason: string) => void): void {
        this.lostHandlers.push(handler);
    }

    close(): void {
        this.opened = false;
        this.sink = null;
        const client = this.client;
        this.client = null;
        if (client === null) {
            return;
        }
        try {
            client.close();
        } catch (error: unknown) {
            // 对端已死时 close 可能抛错：收尾失败不影响调用方
            logDebug(`游戏通道关闭收尾异常（忽略）：${String(error)}`);
        }
    }

    private handleText(text: string): void {
        const sink = this.sink;
        if (sink !== null) {
            sink({ kind: "text", text });
            return;
        }
        if (!this.opened) {
            return;
        }
        const frame = decodeHostInbound(text);
        if (frame === null) {
            logDebug("游戏通道收到无法解析的帧，丢弃");
            return;
        }
        this.dispatchFrame(frame);
    }

    private handleTransportDown(message: string): void {
        const sink = this.sink;
        if (sink !== null) {
            sink({ kind: "error", message });
            return;
        }
        if (!this.opened) {
            return;
        }
        this.opened = false;
        for (const handler of [...this.lostHandlers]) {
            handler(message);
        }
    }

    private dispatchFrame(frame: HostInbound): void {
        for (const handler of [...this.frameHandlers]) {
            handler(frame);
        }
    }
}
