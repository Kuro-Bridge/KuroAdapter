/**
 * Relay：IPC ↔ WS 的占位业务（spike 假规则：「绑定了就转发」）。
 *
 * - IPC game_chat（Java → Node）→ WS chat 推给已握手对端（游戏 → 平台）。
 * - WS chat（平台 → 游戏）→ IPC broadcast 请求（UUID 关联，等 broadcast_result）。
 * - IPC shutdown（Java → Node）→ 通知 onShutdown（引导层负责退出进程）。
 */
import {
    encodeFrame,
    ipcNodeInboundFrame,
    type PlatformChatBody,
    type ResultBody,
} from "@kurobot/protocol";

import type { CoreContext } from "./context.js";
import type { KurobotServer } from "./server.js";
import type { IpcChannel } from "./transport.js";

/** IPC 请求被拒/失败的类型化错误 */
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
    resolve: (body: ResultBody) => void;
    reject: (error: Error) => void;
}

export interface RelayOptions {
    readonly context: CoreContext;
    readonly server: KurobotServer;
    readonly ipc: IpcChannel;
    /** 收到 Java 的 shutdown 帧（stdin EOF 之外的正常关机路径） */
    readonly onShutdown?: (reason: string) => void;
}

export class Relay {
    private readonly context: CoreContext;
    private readonly server: KurobotServer;
    private readonly ipc: IpcChannel;
    private readonly onShutdown: ((reason: string) => void) | undefined;
    private readonly pending = new Map<string, PendingRequest>();
    private disposed = false;

    constructor(options: RelayOptions) {
        this.context = options.context;
        this.server = options.server;
        this.ipc = options.ipc;
        this.onShutdown = options.onShutdown;
        this.ipc.onMessage((text) => {
            this.handleIpcMessage(text);
        });
        this.ipc.onClose(() => {
            // 通道已死：在途请求全部拒绝，且不再接受新请求
            this.disposed = true;
            this.failAllPending(new IpcRequestError("ipc", "channel closed"));
        });
        this.server.onPlatformChat((body) => {
            void this.forwardToGame(body).catch((error: unknown) => {
                this.context.logger.error("转发平台消息失败", error);
            });
        });
    }

    /** 平台 → 游戏：发 broadcast 请求并等待结果（无超时；IPC 关闭时全部拒绝） */
    forwardToGame(body: PlatformChatBody): Promise<ResultBody> {
        if (this.disposed) {
            return Promise.reject(new IpcRequestError("broadcast", "relay disposed"));
        }
        const id = this.context.newRequestId();
        const promise = new Promise<ResultBody>((resolve, reject) => {
            this.pending.set(id, { frameType: "broadcast", resolve, reject });
        });
        this.ipc.send(
            encodeFrame({
                type: "broadcast",
                id,
                body: { message: `<${body.sender}> ${body.content}` },
            }),
        );
        return promise;
    }

    /** 放弃所有在途请求（进程退出前调用） */
    dispose(): void {
        this.disposed = true;
        this.failAllPending(new IpcRequestError("ipc", "relay disposed"));
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
            this.server.sendGameChat(message.body);
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
        if (body.ok) {
            pending.resolve(body);
        } else {
            pending.reject(new IpcRequestError(pending.frameType, body.error));
        }
    }

    private failAllPending(error: Error): void {
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
    }
}
