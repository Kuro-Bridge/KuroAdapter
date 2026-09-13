/**
 * 测试用假传输层（仅测试导入，不进产物）。
 */

import type { ConfigStore, KurobotConfig } from "./business/config.js";
import { defaultConfig } from "./business/config.js";
import { ManualClock, ManualScheduler } from "./clock.js";
import type { CoreOptions } from "./context.js";
import { CoreContext } from "./context.js";
import type { IpcChannel, Logger, WsConnection, WsServer } from "./transport.js";

/** 假配置源：可预置配置，notify 模拟文件变更 */
export class FakeConfigStore implements ConfigStore {
    private current: KurobotConfig;
    private readonly watchers: ((config: KurobotConfig) => void)[] = [];
    /** load() 覆写（config_reload 测试专用）：返回指定配置或抛错，不影响 watch/current */
    private loadResult: { ok: true; config: KurobotConfig } | { ok: false; error: unknown } | null =
        null;

    constructor(initial: KurobotConfig = defaultConfig()) {
        this.current = initial;
    }

    async load(): Promise<KurobotConfig> {
        if (this.loadResult !== null) {
            if (this.loadResult.ok) {
                return this.loadResult.config;
            }
            throw this.loadResult.error;
        }
        return this.current;
    }

    /** 注入 load() 返回值（不触发 watch；验证 config_reload 路径用） */
    setLoadResult(
        result: { ok: true; config: KurobotConfig } | { ok: false; error: unknown },
    ): void {
        this.loadResult = result;
    }

    watch(onChange: (config: KurobotConfig) => void): () => void {
        this.watchers.push(onChange);
        return () => {
            const index = this.watchers.indexOf(onChange);
            if (index >= 0) {
                this.watchers.splice(index, 1);
            }
        };
    }

    /** 测试注入：模拟配置文件变更（投递全部订阅者） */
    notify(config: KurobotConfig): void {
        this.current = config;
        for (const watcher of this.watchers) {
            watcher(config);
        }
    }
}

export class FakeLogger implements Logger {
    readonly debugs: string[] = [];
    readonly infos: string[] = [];
    readonly warns: string[] = [];
    readonly errors: string[] = [];

    debug(message: string): void {
        this.debugs.push(message);
    }

    info(message: string): void {
        this.infos.push(message);
    }

    warn(message: string): void {
        this.warns.push(message);
    }

    error(message: string): void {
        this.errors.push(message);
    }
}

export class FakeWsConnection implements WsConnection {
    readonly sent: string[] = [];
    closed: { code: number; reason: string } | null = null;
    private messageHandler: ((text: string) => void) | null = null;
    private closeHandler: (() => void) | null = null;

    send(text: string): void {
        this.sent.push(text);
    }

    close(code: number, reason: string): void {
        if (this.closed !== null) {
            return;
        }
        this.closed = { code, reason };
        this.closeHandler?.();
    }

    onMessage(handler: (text: string) => void): void {
        this.messageHandler = handler;
    }

    onClose(handler: () => void): void {
        this.closeHandler = handler;
    }

    /** 测试注入：模拟对端发帧 */
    receive(text: string): void {
        this.messageHandler?.(text);
    }
}

export class FakeWsServer implements WsServer {
    started = false;
    stopped = false;
    readonly port = 34567;
    private connectionHandler: ((connection: WsConnection) => void) | null = null;

    async start(): Promise<number> {
        this.started = true;
        return this.port;
    }

    async stop(): Promise<void> {
        this.stopped = true;
    }

    onConnection(handler: (connection: WsConnection) => void): void {
        this.connectionHandler = handler;
    }

    /** 测试注入：模拟对端连入 */
    accept(connection: FakeWsConnection): void {
        this.connectionHandler?.(connection);
    }
}

export class FakeIpc implements IpcChannel {
    readonly sent: string[] = [];
    private closed = false;
    private messageHandler: ((text: string) => void) | null = null;
    private closeHandler: (() => void) | null = null;

    get isOpen(): boolean {
        return !this.closed;
    }

    send(text: string): void {
        this.sent.push(text);
    }

    onMessage(handler: (text: string) => void): void {
        this.messageHandler = handler;
    }

    onClose(handler: () => void): void {
        this.closeHandler = handler;
    }

    /** 测试注入：模拟 Java 发帧 */
    receive(text: string): void {
        this.messageHandler?.(text);
    }

    /** 测试注入：模拟 IPC 断开（stdin EOF） */
    emitClose(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.closeHandler?.();
    }
}

/** 顺序编号的合法 UUID id 工厂（确定性，便于断言） */
export function sequentialIdFactory(): () => string {
    let n = 0;
    return () => {
        n += 1;
        return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
    };
}

/** 手动时钟 + 调度器（默认注入；需要推进时间的测试取回引用后 advance） */
export interface ManualTime {
    readonly clock: ManualClock;
    readonly scheduler: ManualScheduler;
}

export function manualTime(): ManualTime {
    const clock = new ManualClock();
    const scheduler = new ManualScheduler(clock);
    return { clock, scheduler };
}

export function makeContext(overrides?: Partial<CoreOptions>): CoreContext {
    const time = manualTime();
    return new CoreContext({
        logger: new FakeLogger(),
        serverId: "srv-1",
        version: "0.1.0",
        newRequestId: sequentialIdFactory(),
        clock: time.clock,
        scheduler: time.scheduler,
        ...overrides,
    });
}
