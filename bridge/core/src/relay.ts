/**
 * Relay：IPC ↔ WS 的转发装配（MVP 阶段一：绑定表驱动的转发规则；v0.3.0：command/query/
 * death/config_reload）。
 *
 * - IPC game_chat / player_join / player_quit / player_death（Java → Node）→ 按绑定表
 *   fan-out：每个绑定频道一帧，推给全部已握手对端（无绑定时不出帧）。
 * - IPC status → WS status（全服状态，无频道，直发；server.sendStatus 顺带更新 query 缓存）。
 * - WS chat（平台 → 游戏）→ 绑定频道过滤（未绑定 → 丢弃 + debug 日志）→
 *   IPC broadcast 请求（UUID 关联，等 broadcast_result，携带来源 channel）。
 * - WS command（群指令，v0.3.0）→ AdminTable 管理员判定（非管理员 → forbidden + warn，
 *   不触发 IPC）→ IPC execute_command 透传 → 结果（含 output）原样回 command_result。
 * - 配置变更（ConfigStore.watch）→ AdminTable.replace + BindingTable.replace → 集合变化时
 *   推 bindings_updated 给已握手对端（ADR-004）。
 * - IPC config_reload（/kurobot reload，v0.3.0）→ 重读配置 → 复用 watch 的变更处理路径。
 * - IPC shutdown（Java → Node）→ 通知 onShutdown（引导层负责退出进程）。
 *
 * 健壮性（MVP 阶段一）：
 * - IPC 请求超时（ipcRequestTimeoutMs，默认 10s 对齐 Java 侧；0 禁用）——在途请求
 *   超时以 IpcRequestError 拒绝，不再无限悬挂。
 * - 断连降级（候选 E）：ipcOpen 暴露 IPC 健康状态，上层（含 /kurobot send 回执路径）
 *   可感知失败做降级决策；消息排队/补发留 MVP-2。
 */
import {
    type BroadcastBody,
    type CommandBody,
    type CommandResultBody,
    type ExecuteCommandBody,
    encodeFrame,
    ipcNodeInboundFrame,
    type PlatformChatBody,
    type ResultBody,
} from "@kurobot/protocol";

import type { AdminTable } from "./business/admins.js";
import type { BindingTable } from "./business/bindings.js";
import type { ConfigStore, KurobotConfig } from "./business/config.js";
import { gameEventChannels, platformChatTarget } from "./business/forwarding.js";
import type { CancelFn } from "./clock.js";
import type { CoreContext } from "./context.js";
import type { KurobotServer } from "./server.js";
import type { IpcChannel } from "./transport.js";

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
    /** v0.3.0 起 resolve 体为命令结果体（ok 分支可带 output）；通用结果体是其结构子集 */
    resolve: (body: CommandResultBody) => void;
    reject: (error: Error) => void;
}

export interface RelayOptions {
    readonly context: CoreContext;
    readonly server: KurobotServer;
    readonly ipc: IpcChannel;
    /** 绑定表（转发规则数据源；与 server.channelBindings 共享同一实例） */
    readonly bindings: BindingTable;
    /** 管理员映射表（command 判定数据源；配置变更/重载时 replace 刷新，v0.3.0） */
    readonly admins: AdminTable;
    /** 配置源（变更 → 绑定表替换 + bindings_updated 推送） */
    readonly configStore: ConfigStore;
    /** 收到 Java 的 shutdown 帧（stdin EOF 之外的正常关机路径） */
    readonly onShutdown?: (reason: string) => void;
    /** IPC 请求超时毫秒（缺省 10s 对齐 Java 侧；0 禁用） */
    readonly ipcRequestTimeoutMs?: number;
}

export class Relay {
    private readonly context: CoreContext;
    private readonly server: KurobotServer;
    private readonly ipc: IpcChannel;
    private readonly bindings: BindingTable;
    private readonly admins: AdminTable;
    private readonly configStore: ConfigStore;
    private readonly onShutdown: ((reason: string) => void) | undefined;
    private readonly ipcRequestTimeoutMs: number;
    private readonly pending = new Map<string, PendingRequest>();
    private disposed = false;

    constructor(options: RelayOptions) {
        this.context = options.context;
        this.server = options.server;
        this.ipc = options.ipc;
        this.bindings = options.bindings;
        this.admins = options.admins;
        this.configStore = options.configStore;
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
            this.handlePlatformChat(body);
        });
        this.server.onCommand((body) => {
            return this.handleCommandRequest(body);
        });
        this.configStore.watch((config) => {
            this.handleConfigChange(config);
        });
    }

    /** IPC 通道是否可用（候选 E：上层可观测的降级信号） */
    get ipcOpen(): boolean {
        return !this.disposed;
    }

    /** 平台 → 游戏：发 broadcast 请求并等待结果（超时/IPC 关闭均拒绝） */
    forwardToGame(body: PlatformChatBody): Promise<ResultBody> {
        return this.ipcRequest("broadcast", {
            channel: body.channel,
            message: `<${body.sender}> ${body.content}`,
        });
    }

    /** 放弃所有在途请求（进程退出前调用） */
    dispose(): void {
        this.markDisposed(new IpcRequestError("ipc", "relay disposed"));
    }

    private handlePlatformChat(body: PlatformChatBody): void {
        const target = platformChatTarget(this.bindings.channels(), body);
        if (target === null) {
            this.context.logger.debug(`平台消息来自未绑定频道 ${body.channel}，丢弃`);
            return;
        }
        void this.forwardToGame(target).catch((error: unknown) => {
            this.context.logger.error("转发平台消息失败", error);
        });
    }

    /**
     * WS command 请求的业务处理（管理员判定全在 core，Java 只 dispatch）：
     * 非管理员 → forbidden（不触发 IPC）；管理员 → IPC execute_command 透传，
     * 结果体（含 output）原样回 command_result；IPC 失败/超时经拒绝路径转为 error 回执。
     */
    private async handleCommandRequest(body: CommandBody): Promise<CommandResultBody> {
        if (!this.admins.isAdmin(body.source.channel, body.source.userId)) {
            this.context.logger.warn(
                `非管理员来源执行命令被拒绝：channel=${body.source.channel} userId=${body.source.userId} command=${body.command}`,
            );
            return { ok: false, error: "forbidden" };
        }
        return this.ipcRequest("execute_command", { command: body.command });
    }

    /** 发送 IPC 请求帧并等待结果（broadcast / execute_command 共用；超时/断开拒绝） */
    private ipcRequest(
        frameType: "broadcast" | "execute_command",
        body: BroadcastBody | ExecuteCommandBody,
    ): Promise<CommandResultBody> {
        if (this.disposed) {
            return Promise.reject(new IpcRequestError(frameType, "relay disposed"));
        }
        const id = this.context.newRequestId();
        const promise = new Promise<CommandResultBody>((resolve, reject) => {
            this.pending.set(id, { frameType, cancelTimer: null, resolve, reject });
        });
        this.armRequestTimeout(id);
        this.ipc.send(encodeFrame({ type: frameType, id, body }));
        return promise;
    }

    private handleConfigChange(config: KurobotConfig): void {
        // admins 无条件刷新（绑定集合未变时管理员映射仍可能已变）
        this.admins.replace(config.admins);
        if (!this.bindings.replace(config.channels)) {
            return;
        }
        const channels = this.bindings.channels();
        this.context.logger.info(`绑定表已更新：[${channels.join(", ")}]`);
        this.server.sendBindingsUpdated({ channelBindings: channels });
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
                new IpcRequestError(expired.frameType, `响应超时（${this.ipcRequestTimeoutMs}ms）`),
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
            this.fanoutGameEvent((channel) =>
                this.server.sendGameChat({
                    channel,
                    playerName: message.body.playerName,
                    content: message.body.content,
                }),
            );
            return;
        }
        if (message.type === "player_join") {
            this.fanoutGameEvent((channel) =>
                this.server.sendJoin({ channel, playerName: message.body.playerName }),
            );
            return;
        }
        if (message.type === "player_quit") {
            this.fanoutGameEvent((channel) =>
                this.server.sendLeave({ channel, playerName: message.body.playerName }),
            );
            return;
        }
        if (message.type === "player_death") {
            this.fanoutGameEvent((channel) =>
                this.server.sendDeath({
                    channel,
                    player: message.body.player,
                    message: message.body.message,
                }),
            );
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
        if (message.type === "config_reload") {
            this.context.logger.info("收到配置重载通知（config_reload），重新读取配置");
            void this.reloadConfig();
            return;
        }
        // broadcast_result / execute_command_result：按 id 关联在途请求
        this.settlePending(message.id, message.body);
    }

    /** /kurobot reload 路径：重读配置并复用 watch 的变更处理（读取失败保留旧配置） */
    private async reloadConfig(): Promise<void> {
        try {
            this.handleConfigChange(await this.configStore.load());
        } catch (error: unknown) {
            this.context.logger.error("重载配置读取失败，保留旧配置", error);
        }
    }

    /** 游戏事件按绑定表逐频道出帧（未来按频道差异化规则在 forwarding.ts 扩展） */
    private fanoutGameEvent(send: (channel: string) => number): void {
        let delivered = 0;
        for (const channel of gameEventChannels(this.bindings.channels())) {
            delivered += send(channel);
        }
        if (delivered === 0) {
            this.context.logger.debug("游戏事件无绑定频道或无已握手对端，未出帧");
        }
    }

    private settlePending(id: string, body: CommandResultBody): void {
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
