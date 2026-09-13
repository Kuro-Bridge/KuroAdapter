/**
 * Relay：IPC ↔ WS 的转发装配（spike 假规则，MVP 阶段一维持：「占位频道全量转发」）。
 *
 * - IPC game_chat / player_join / player_quit（Java → Node）→ 按占位频道 fan-out 推给
 *   已握手对端（阶段 3 用绑定表替换假规则：游戏事件 → 全部绑定频道）。
 * - IPC status → WS status（全服状态，无频道，直发）。
 * - WS chat（平台 → 游戏）→ IPC broadcast 请求（UUID 关联，等 broadcast_result）；
 *   v0.2 起携带来源 channel。
 * - IPC shutdown（Java → Node）→ 通知 onShutdown（引导层负责退出进程）。
 *
 * 健壮性（MVP 阶段一）：
 * - IPC 请求超时（ipcRequestTimeoutMs，默认 10s 对齐 Java 侧；0 禁用）——在途请求
 *   超时以 IpcRequestError 拒绝，不再无限悬挂。
 * - 断连降级（候选 E）：ipcOpen 暴露 IPC 健康状态，上层（含 /kurobot send 回执路径）
 *   可感知失败做降级决策；消息排队/补发留 MVP-2。
 */
import {
    encodeFrame,
    ipcNodeInboundFrame,
    type PlatformChatBody,
    type ResultBody,
} from "@kurobot/protocol";

import type { CancelFn } from "./clock.js";
import type { CoreContext } from "./context.js";
import type { KurobotServer } from "./server.js";
import type { IpcChannel } from "./transport.js";

/**
 * 假规则的占位频道（MVP 阶段一）：绑定表落地（阶段 3）前的临时 fan-out 目标。
 * 外部对端（koishi-plugin-kurobot）不会收到它——仅开发期 stub / 沙盒观测用。
 */
const FANOUT_PLACEHOLDER_CHANNEL = "spike";

export const DEFAULT_IPC_REQUEST_TIMEOUT_MS = 10_000;

/** IPC 请求被拒/失败/超时的类型化错误 */
export class IpcRequestError extends Error {
    readonly frameType: string;
    readonly reason: string;

    constructor(frameType: string, reason: string) {
        super(`IPC ${frameType} 失败：${reason}`);
        this.name = "IpcRequestError";
        this.frameType = frameType;
        this.reason = reason;
    }
}

interface PendingRequest {
    readonly frameType: string;
    cancelTimer: CancelFn | null;
    resolve: (body: ResultBody) => void;
    reject: (error: Error) => void;
}

export interface RelayOptions {
    readonly context: CoreContext;
    readonly server: KurobotServer;
    readonly ipc: IpcChannel;
    /** 收到 Java 的 shutdown 帧（stdin EOF 之外的正常关机路径） */
    readonly onShutdown?: (reason: string) => void;
    /** IPC 请求超时毫秒（缺省 10s 对齐 Java 侧；0 禁用） */
    readonly ipcRequestTimeoutMs?: number;
}

export class Relay {
    private readonly context: CoreContext;
    private readonly server: KurobotServer;
    private readonly ipc: IpcChannel;
    private readonly onShutdown: ((reason: string) => void) | undefined;
    private readonly ipcRequestTimeoutMs: number;
    private readonly pending = new Map<string, PendingRequest>();
    private disposed = false;

    constructor(options: RelayOptions) {
        this.context = options.context;
        this.server = options.server;
        this.ipc = options.ipc;
        this.onShutdown = options.onShutdown;
        this.ipcRequestTimeoutMs = options.ipcRequestTimeoutMs ?? DEFAULT_IPC_REQUEST_TIMEOUT_MS;
        this.ipc.onMessage((text) => {
            this.handleIpcMessage(text);
        });
        this.ipc.onClose(() => {
            // 通道已死：在途请求全部拒绝，且不再接受新请求
            this.markDisposed(new IpcRequestError("ipc", "channel closed"));
        });
        this.server.onPlatformChat((body) => {
            void this.forwardToGame(body).catch((error: unknown) => {
                this.context.logger.error("转发平台消息失败", error);
            });
        });
    }

    /** IPC 通道是否可用（候选 E：上层可观测的降级信号） */
    get ipcOpen(): boolean {
        return !this.disposed;
    }

    /** 平台 → 游戏：发 broadcast 请求并等待结果（超时/IPC 关闭均拒绝） */
    forwardToGame(body: PlatformChatBody): Promise<ResultBody> {
        if (this.disposed) {
            return Promise.reject(new IpcRequestError("broadcast", "relay disposed"));
        }
        const id = this.context.newRequestId();
        const promise = new Promise<ResultBody>((resolve, reject) => {
            this.pending.set(id, { frameType: "broadcast", cancelTimer: null, resolve, reject });
        });
        this.armRequestTimeout(id);
        this.ipc.send(
            encodeFrame({
                type: "broadcast",
                id,
                body: { channel: body.channel, message: `<${body.sender}> ${body.content}` },
            }),
        );
        return promise;
    }

    /** 放弃所有在途请求（进程退出前调用） */
    dispose(): void {
        this.markDisposed(new IpcRequestError("ipc", "relay disposed"));
    }

    private armRequestTimeout(id: string): void {
        if (this.ipcRequestTimeoutMs <= 0) {
            return;
        }
        const pending = this.pending.get(id);
        if (pending === undefined) {
            return;
        }
        pending.cancelTimer = this.context.scheduler.schedule(this.ipcRequestTimeoutMs, () => {
            const expired = this.pending.get(id);
            if (expired === undefined) {
                return;
            }
            this.pending.delete(id);
            expired.cancelTimer = null;
            expired.reject(
                new IpcRequestError("broadcast", `响应超时（${this.ipcRequestTimeoutMs}ms）`),
            );
        });
    }

    private markDisposed(error: Error): void {
        this.disposed = true;
        for (const pending of this.pending.values()) {
            pending.cancelTimer?.();
            pending.cancelTimer = null;
            pending.reject(error);
        }
        this.pending.clear();
    }

    private handleIpcMessage(text: string): void {
        if (this.disposed) {
            return;
        }
        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch {
            this.context.logger.warn("IPC 帧不是合法 JSON，丢弃");
            return;
        }
        const parsed = ipcNodeInboundFrame.safeParse(raw);
        if (!parsed.success) {
            this.context.logger.warn(`IPC 帧校验失败，丢弃：${text.slice(0, 200)}`);
            return;
        }
        const message = parsed.data;
        if (message.type === "game_chat") {
            this.server.sendGameChat({
                channel: FANOUT_PLACEHOLDER_CHANNEL,
                playerName: message.body.playerName,
                content: message.body.content,
            });
            return;
        }
        if (message.type === "player_join") {
            this.server.sendJoin({
                channel: FANOUT_PLACEHOLDER_CHANNEL,
                playerName: message.body.playerName,
            });
            return;
        }
        if (message.type === "player_quit") {
            this.server.sendLeave({
                channel: FANOUT_PLACEHOLDER_CHANNEL,
                playerName: message.body.playerName,
            });
            return;
        }
        if (message.type === "status") {
            this.server.sendStatus(message.body);
            return;
        }
        if (message.type === "shutdown") {
            this.context.logger.info(`收到关机通知：${message.body.reason}`);
            this.onShutdown?.(message.body.reason);
            return;
        }
        // broadcast_result / execute_command_result：按 id 关联在途请求
        this.settlePending(message.id, message.body);
    }

    private settlePending(id: string, body: ResultBody): void {
        const pending = this.pending.get(id);
        if (pending === undefined) {
            this.context.logger.warn(`IPC 响应无在途请求，忽略：${id}`);
            return;
        }
        this.pending.delete(id);
        pending.cancelTimer?.();
        pending.cancelTimer = null;
        if (body.ok) {
            pending.resolve(body);
        } else {
            pending.reject(new IpcRequestError(pending.frameType, body.error));
        }
    }
}
