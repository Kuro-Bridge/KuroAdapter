/**
 * 配置注入接口（MVP 阶段一）：core 平台无关，配置读写全部经此抽象（ADR-007）。
 *
 * Node 实现（plugins/kurobot/config.json 轮询监听）在 bridge/embedded 引导层；
 * 配置文件由服主手工编辑，kurobot 只读 + 缺失时生成默认（落盘职责在实现侧）。
 */
import { z } from "zod";

/** kurobot 配置形状（MVP：仅绑定频道列表） */
export interface KurobotConfig {
    readonly channels: readonly string[];
}

/** 配置读写抽象（宿主注入；watch 返回取消订阅函数） */
export interface ConfigStore {
    /** 读取并解析当前配置；非法配置抛 ConfigError */
    load(): Promise<KurobotConfig>;
    /** 订阅配置变更（实现方负责去抖/错误兜底，只投递合法配置） */
    watch(onChange: (config: KurobotConfig) => void): () => void;
}

/** 配置读取/解析失败的类型化错误 */
export class ConfigError extends Error {
    readonly cause?: unknown;

    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = "ConfigError";
        this.cause = cause;
    }
}

const configSchema = z.object({
    channels: z.array(z.string().min(1)),
});

/** 解析配置（纯函数）：去重保序；形状/内容非法抛 ConfigError */
export function parseConfig(raw: unknown): KurobotConfig {
    let parsed: z.infer<typeof configSchema>;
    try {
        parsed = configSchema.parse(raw);
    } catch (error: unknown) {
        throw new ConfigError("配置不合法（期望 { channels: string[] }，频道为非空字符串）", error);
    }
    const channels: string[] = [];
    for (const channel of parsed.channels) {
        if (!channels.includes(channel)) {
            channels.push(channel);
        }
    }
    return { channels };
}

/** 默认配置（无绑定——平台消息不进游戏，直到服主写入绑定） */
export function defaultConfig(): KurobotConfig {
    return { channels: [] };
}
