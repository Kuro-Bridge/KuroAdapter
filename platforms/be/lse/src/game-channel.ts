/**
 * 游戏通道：壳 ↔ node shim 的回环 WS 客户端封装（WSClient）。
 *
 * open = connectAsync 重试（固定间隔）→ 连上即发令牌明文首帧 → 等 ready 帧，
 * 总 deadline 由调用方给定（看护器对齐 30s，裁决册 §4.4）；任一环节失败 reject。
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
            let retryTimer: TimerHandle | null = null;
            const startedAt = Date.now();
            const cleanup = (): void => {
                cancelTimer(deadlineTimer);
                if (retryTimer !== null) {
                    cancelTimer(retryTimer);
                    retryTimer = null;
                }
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
            const attemptConnect = (): void => {
                if (settled) {
                    return;
                }
                const launched = client.connectAsync(url, (success) => {
                    if (settled) {
                        return;
                    }
                    if (!success) {
                        scheduleRetry();
                        return;
                    }
                    connected = true;
                    if (!client.send(token)) {
                        fail("游戏通道令牌首帧发送失败");
                    }
                });
                if (!launched) {
                    scheduleRetry();
                }
            };
            this.sink = (event) => {
                if (event.kind === "error") {
                    // 连接建立前的传输错误交 connectAsync 回调裁决，避免双重重试
                    if (connected) {
                        fail(event.message);
                    }
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
