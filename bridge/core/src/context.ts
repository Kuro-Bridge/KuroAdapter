/**
 * CoreContext：注入的 logger / 身份标识 / id 工厂持有者（core 无全局单例）。
 *
 * newRequestId 由宿主注入（UUID 生成依赖平台能力，core 保持平台无关）。
 */
import type { Logger } from "./transport.js";

export interface CoreOptions {
    logger: Logger;
    /** 本服务器标识（hello_ack 上报给对端） */
    serverId: string;
    /** kurobot 版本（hello_ack 上报给对端） */
    version: string;
    /** 请求-响应关联 id 工厂（宿主注入 UUID 实现） */
    newRequestId: () => string;
}

export class CoreContext {
    readonly logger: Logger;
    readonly serverId: string;
    readonly version: string;
    readonly newRequestId: () => string;

    constructor(options: CoreOptions) {
        this.logger = options.logger;
        this.serverId = options.serverId;
        this.version = options.version;
        this.newRequestId = options.newRequestId;
    }
}
