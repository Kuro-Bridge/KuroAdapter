/**
 * CoreContext：注入的 logger / 身份标识 / id 工厂 / 时钟与定时器持有者（core 无全局单例）。
 *
 * newRequestId 由宿主注入（UUID 生成依赖平台能力）；clock / scheduler 同理
 * （setTimeout/Date.now 是宿主能力，core 保持平台无关，ADR-007）。
 */
import type { Clock, TimerScheduler } from "./clock.js";
import type { Logger } from "./transport.js";

export interface CoreOptions {
    logger: Logger;
    /** 本服务器标识（hello_ack 上报给对端） */
    serverId: string;
    /** kurobot 版本（hello_ack 上报给对端） */
    version: string;
    /**
     * WS 握手鉴权 token（v0.3.0，DEBT-1）：非空时 hello 必须携带相同 token。
     * 缺省/空串 = 不鉴权（向后兼容）。exactOptionalPropertyTypes 下经 ?? "" 归一。
     */
    token?: string;
    /** 请求-响应关联 id 工厂（宿主注入 UUID 实现） */
    newRequestId: () => string;
    /** 时钟（超时/空闲检测用） */
    clock: Clock;
    /** 一次性定时器调度器（hello 超时/心跳空闲/IPC 请求超时用） */
    scheduler: TimerScheduler;
}

export class CoreContext {
    readonly logger: Logger;
    readonly serverId: string;
    readonly version: string;
    /** 鉴权 token（"" = 不鉴权）；进程生命周期内固定（bootstrap 注入，reload 不刷新） */
    readonly token: string;
    readonly newRequestId: () => string;
    readonly clock: Clock;
    readonly scheduler: TimerScheduler;

    constructor(options: CoreOptions) {
        this.logger = options.logger;
        this.serverId = options.serverId;
        this.version = options.version;
        this.token = options.token ?? "";
        this.newRequestId = options.newRequestId;
        this.clock = options.clock;
        this.scheduler = options.scheduler;
    }
}
