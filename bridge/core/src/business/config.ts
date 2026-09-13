/**
 * 配置注入接口（MVP 阶段一）：core 平台无关，配置读写全部经此抽象（ADR-007）。
 *
 * Node 实现（plugins/kurobot/config.json 轮询监听）在 bridge/embedded 引导层；
 * 配置文件由服主手工编辑，kurobot 只读 + 缺失时生成默认（落盘职责在实现侧）。
 *
 * v0.3.0（DEBT-1）扩展：token（WS 鉴权）与 admins（群管理员映射）；
 * runtime 段（DEBT-2）保持不变。
 */
import { z } from "zod";

/** 群管理员映射条目：channel 命中且 userId 在 users 内 → 视为管理员（command 放行） */
export interface AdminMapping {
    readonly channel: string;
    readonly users: readonly string[];
}

/** kurobot 配置形状（v0.3.0：绑定频道 + 鉴权 + 管理员映射；DEBT-2 增 runtime 宿主参数段） */
export interface KurobotConfig {
    readonly channels: readonly string[];
    /** WS 握手鉴权 token；空串 = 不鉴权（向后兼容） */
    readonly token: string;
    /** 群管理员映射（缺省 []：无人可经 command 执行命令） */
    readonly admins: readonly AdminMapping[];
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

const adminMappingSchema = z.object({
    channel: z.string().min(1),
    users: z.array(z.string().min(1)),
});

const configSchema = z.object({
    channels: z.array(z.string().min(1)),
    /** WS 鉴权 token（v0.3.0）；缺省 "" = 不鉴权 */
    token: z.string().default(""),
    /** 群管理员映射（v0.3.0）；缺省 [] */
    admins: z.array(adminMappingSchema).default([]),
    /** 宿主运行参数段（v0.2.1 起随 ready 上报 autoRestart；缺省整段按 true） */
    runtime: runtimeSchema.default({ autoRestart: true }),
});

/** 去重保序 */
function dedupe(values: readonly string[]): string[] {
    const unique: string[] = [];
    for (const value of values) {
        if (!unique.includes(value)) {
            unique.push(value);
        }
    }
    return unique;
}

/** 管理员映射归一：entry 按 channel 去重（保留首个）、entry 内 users 去重保序（语义对齐 channels） */
function normalizeAdmins(admins: readonly { channel: string; users: string[] }[]): AdminMapping[] {
    const byChannel = new Map<string, AdminMapping>();
    for (const entry of admins) {
        if (!byChannel.has(entry.channel)) {
            byChannel.set(entry.channel, { channel: entry.channel, users: dedupe(entry.users) });
        }
    }
    return [...byChannel.values()];
}

/**
 * 解析配置（纯函数）：channels / admins 各自去重保序；形状/内容非法抛 ConfigError。
 * 多余字段剥离（zod 非严格 object），旧配置缺新字段按缺省补齐（向后兼容）。
 */
export function parseConfig(raw: unknown): KurobotConfig {
    let parsed: z.infer<typeof configSchema>;
    try {
        parsed = configSchema.parse(raw);
    } catch (error: unknown) {
        throw new ConfigError(
            "配置不合法（期望 { channels: string[], token?: string, admins?: {channel, users}[], runtime?: { autoRestart?: boolean } }）",
            error,
        );
    }
    const channels: string[] = [];
    for (const channel of parsed.channels) {
        if (!channels.includes(channel)) {
            channels.push(channel);
        }
    }
    return {
        channels,
        token: parsed.token,
        admins: normalizeAdmins(parsed.admins),
        runtime: { autoRestart: parsed.runtime.autoRestart },
    };
}

/** 默认配置（无绑定、不鉴权、无管理员——平台消息不进游戏，直到服主写入绑定） */
export function defaultConfig(): KurobotConfig {
    return { channels: [], token: "", admins: [], runtime: { autoRestart: true } };
}
