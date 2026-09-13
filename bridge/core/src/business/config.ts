/**
 * 配置注入接口（MVP 阶段一）：core 平台无关，配置读写全部经此抽象（ADR-007）。
 *
 * Node 实现（plugins/kurobot/config.json 轮询监听）在 bridge/embedded 引导层；
 * 配置文件由服主手工编辑，kurobot 只读 + 缺失时生成默认（落盘职责在实现侧）。
 */
import { z } from "zod";

/** kurobot 配置形状（MVP：绑定频道列表；DEBT-2 增 runtime 宿主参数段） */
export interface KurobotConfig {
    readonly channels: readonly string[];
    /** 宿主运行参数（DEBT-2）：node 异常退出后 Java 侧是否自动重启 */
    readonly runtime: {
        readonly autoRestart: boolean;
    };
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

const runtimeSchema = z.object({
    /** node 异常退出后 Java 侧自动重启（DEBT-2）；缺省 true */
    autoRestart: z.boolean().default(true),
});

const configSchema = z.object({
    channels: z.array(z.string().min(1)),
    /** 宿主运行参数段（v0.2.1 起随 ready 上报 autoRestart；缺省整段按 true） */
    runtime: runtimeSchema.default({ autoRestart: true }),
});

/** 解析配置（纯函数）：channels 去重保序；形状/内容非法抛 ConfigError */
export function parseConfig(raw: unknown): KurobotConfig {
    let parsed: z.infer<typeof configSchema>;
    try {
        parsed = configSchema.parse(raw);
    } catch (error: unknown) {
        throw new ConfigError(
            "配置不合法（期望 { channels: string[], runtime?: { autoRestart?: boolean } }）",
            error,
        );
    }
    const channels: string[] = [];
    for (const channel of parsed.channels) {
        if (!channels.includes(channel)) {
            channels.push(channel);
        }
    }
    return { channels, runtime: { autoRestart: parsed.runtime.autoRestart } };
}

/** 默认配置（无绑定——平台消息不进游戏，直到服主写入绑定） */
export function defaultConfig(): KurobotConfig {
    return { channels: [], runtime: { autoRestart: true } };
}
