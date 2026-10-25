/**
 * 配置注入接口（MVP 阶段一）：core 平台无关，配置读写全部经此抽象（ADR-007）。
 *
 * Node 实现（plugins/kurobridge/config.jsonc 读取与监听）在 bridge/embedded 引导层；
 * 配置文件由服主手工编辑，kurobridge 只读 + 缺失时生成默认（落盘职责在实现侧）。
 *
 * v0.3.0（DEBT-1）扩展：token（WS 鉴权）与 admins（群管理员映射）；
 * runtime 段（DEBT-2）保持不变。
 * MVP-3 扩展：顶层可选 ws 段（WS 监听 host/port 的形状 SSOT；消费方在 embedded 引导层，
 * 监听参数是宿主事务，core 的 WsServer 接口不感知）。
 * ADR-040 扩展：配置文件 JSONC 化（stripJsonc / parseJsonc / defaultConfigJsonc 同住本层，
 * 首启生成随机 token）；ADR-041 扩展：embedded.napuketto 增 qq / logLevel（内联注入
 * 托管面的业务字段）。
 */
import { z } from "zod";

/** 群管理员映射条目：channel 命中且 userId 在 users 内 → 视为管理员（command 放行） */
export interface AdminMapping {
    readonly channel: string;
    readonly users: readonly string[];
}

/** kurobridge 配置形状（v0.3.0：绑定频道 + 鉴权 + 管理员映射；DEBT-2 增 runtime 宿主参数段；MVP-3 增 ws 监听段） */
export interface KurobridgeConfig {
    readonly channels: readonly string[];
    /** WS 握手鉴权 token；空串 = 不鉴权（向后兼容） */
    readonly token: string;
    /** 群管理员映射（缺省 []：无人可经 command 执行命令） */
    readonly admins: readonly AdminMapping[];
    /** 宿主运行参数（DEBT-2）：node 异常退出后 Java 侧是否自动重启 */
    readonly runtime: {
        readonly autoRestart: boolean;
    };
    /**
     * WS 监听段（MVP-3，可选）：external 对端连入点。整段缺省 = 动态端口 + 全部接口
     * （embedded 形态现状）；只配 host 不配 port = 动态端口 + 指定地址（合法）。
     * 消费方在 embedded 引导层（NodeWsServer），本包只定形状。
     */
    readonly ws?: {
        readonly host?: string | undefined;
        readonly port?: number | undefined;
    };
    /**
     * 嵌入段（MVP-4，可选）：JAR 内嵌 napuketto CLI（ADR-029）。整段缺省 = 现状
     * （stub 孙进程 / external 对端）。形状 SSOT 在此（ADR-028 先例），消费方在
     * embedded 引导层（spawner / 守卫 / QR 交接均是宿主事务）。
     * ADR-041 起连接参数（url/token）由宿主经 NAPKETTO_CONFIG_JSON 内联注入，
     * napuketto.toml 不再是服主交互面。
     */
    readonly embedded?: {
        readonly napuketto: {
            /** 显式声明不给缺省：嵌入是重行为（拉起 QQ 协议端整树） */
            readonly enabled: boolean;
            /** napuketto toml 路径（相对服务器根）；仅旧版 CLI（无内联注入能力）回退使用 */
            readonly configPath?: string | undefined;
            /** napuketto 数据目录（相对服务器根）；缺省 plugins/kurobridge/napuketto-data */
            readonly dataDir?: string | undefined;
            /**
             * 机器人 QQ 号（ADR-041）：embedded 托管面唯一必填业务字段，随内联配置注入；
             * 缺失/占位值由启动守卫拦截（配置未就绪语义，exit 2，不触发看护器重启）
             */
            readonly qq?: string | undefined;
            /** napuketto 控制台日志级别（透传 NAPUKETTO_LOG_LEVEL）；缺省 info */
            readonly logLevel?: string | undefined;
        };
    };
    /**
     * 服务器标识段（ADR-034，可选）：id 缺省 "kurobridge"（消费方 embedded 引导层兜底，
     * 非 config 默认值），经 hello_ack 上报给对端——消除原型期 "kurobridge-spike" 硬编码
     * 残留。形状 SSOT 在此（先例 ADR-028）；「serverId 多实例互联」全案仍是债务（STATUS 索引）。
     */
    readonly server?: {
        readonly id?: string | undefined;
    };
}

/** 配置读写抽象（宿主注入；watch 返回取消订阅函数） */
export interface ConfigStore {
    /** 读取并解析当前配置；非法配置抛 ConfigError */
    load(): Promise<KurobridgeConfig>;
    /** 订阅配置变更（实现方负责去抖/错误兜底，只投递合法配置） */
    watch(onChange: (config: KurobridgeConfig) => void): () => void;
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

const wsListenSchema = z.object({
    /** 绑定地址（如 127.0.0.1 只听本机）；缺省 = 全部接口 */
    host: z.string().min(1).optional(),
    /** 监听端口（1-65535）；缺省 = 动态端口 */
    port: z.number().int().min(1).max(65535).optional(),
});

const napukettoSchema = z.object({
    /** 显式声明不给缺省：嵌入是重行为（拉起 QQ 协议端整树），要求服主写明 */
    enabled: z.boolean(),
    /** napuketto toml 路径（相对服务器根）；仅旧版 CLI（无内联注入）回退使用 */
    configPath: z.string().min(1).optional(),
    /** napuketto 数据目录（相对服务器根）；缺省 plugins/kurobridge/napuketto-data */
    dataDir: z.string().min(1).optional(),
    /** 机器人 QQ 号（ADR-041）：内联注入的业务字段，缺失/占位值由启动守卫拦截 */
    qq: z.string().min(1).optional(),
    /** napuketto 控制台日志级别（透传 NAPUKETTO_LOG_LEVEL）；缺省 info */
    logLevel: z.string().min(1).optional(),
});

const serverSchema = z.object({
    /** 服务器标识（hello_ack 上报给对端）；缺省 "kurobridge"（embedded 引导层兜底，ADR-034） */
    id: z.string().min(1).optional(),
});

const configSchema = z.object({
    channels: z.array(z.string().min(1)),
    /** WS 鉴权 token（v0.3.0）；缺省 "" = 不鉴权 */
    token: z.string().default(""),
    /** 群管理员映射（v0.3.0）；缺省 [] */
    admins: z.array(adminMappingSchema).default([]),
    /** 宿主运行参数段（v0.2.1 起随 ready 上报 autoRestart；缺省整段按 true） */
    runtime: runtimeSchema.default({ autoRestart: true }),
    /** WS 监听段（MVP-3）；整段缺省 = 动态端口 + 全部接口（现状不变） */
    ws: wsListenSchema.optional(),
    /** 嵌入段（MVP-4）；整段缺省 = 无 napuketto 分支（现状不变） */
    embedded: z
        .object({
            napuketto: napukettoSchema,
        })
        .optional(),
    /** 服务器标识段（ADR-034）；整段缺省 = 引导层兜底 "kurobridge" */
    server: serverSchema.optional(),
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
export function parseConfig(raw: unknown): KurobridgeConfig {
    let parsed: z.infer<typeof configSchema>;
    try {
        parsed = configSchema.parse(raw);
    } catch (error: unknown) {
        throw new ConfigError(
            "配置不合法（期望 { channels: string[], token?: string, admins?: {channel, users}[], runtime?: { autoRestart?: boolean }, ws?: { host?: string, port?: number }, embedded?: { napuketto: { enabled: boolean, configPath?: string, dataDir?: string, qq?: string, logLevel?: string } }, server?: { id?: string } }）",
            error,
        );
    }
    const channels: string[] = [];
    for (const channel of parsed.channels) {
        if (!channels.includes(channel)) {
            channels.push(channel);
        }
    }
    // 可选段条件展开（exactOptionalPropertyTypes：段缺省时不产生对应 undefined 键）
    const ws = parsed.ws;
    const embedded = parsed.embedded;
    const server = parsed.server;
    return {
        channels,
        token: parsed.token,
        admins: normalizeAdmins(parsed.admins),
        runtime: { autoRestart: parsed.runtime.autoRestart },
        ...(ws === undefined ? {} : { ws }),
        ...(embedded === undefined ? {} : { embedded }),
        ...(server === undefined ? {} : { server }),
    };
}

/**
 * 默认配置（无绑定、无管理员——平台消息不进游戏，直到服主写入绑定；
 * **不含 ws 段**：生成的默认配置维持动态端口现状，external 形态由服主显式添加）。
 * token 缺省 ""（内存降级路径用）；首启落盘场景由调用方生成随机值传入（ADR-040，
 * 全形态开箱即鉴权，对齐 Pure 线）。
 */
export function defaultConfig(token = ""): KurobridgeConfig {
    return { channels: [], token, admins: [], runtime: { autoRestart: true } };
}

/** 进程退出码契约（ADR-041）：2 = 配置/环境确定性错误（重启无意义），宿主看护器不退避重启；1 = 可重试崩溃；0 = 优雅关停 */
export const CONFIG_NOT_READY_EXIT_CODE = 2;

/**
 * 默认配置的 JSONC 模板（ADR-040，「生成件即文档」）：首启落盘用，注释即引导。
 * token 由调用方生成注入（core 禁 Node API，不碰 crypto）；模板内可选段以注释形态
 * 给出示例，取消注释即启用。模板形状由单测「parseJsonc + parseConfig 回环」锁死，
 * 与 configSchema 漂移即红。
 */
export function defaultConfigJsonc(token: string): string {
    return `// KuroBridge 配置文件（JSONC：支持行注释、块注释与行尾逗号；VS Code 原生识别 .jsonc）
// 字段权威参考：docs/reference/config.md（与代码不一致时以代码为准）
// 改完保存即生效的字段只有 channels 和 admins，其余见各条注释里的"生效"说明
{
    // 绑定频道列表（必填，可为空数组）：群聊消息只有命中表内频道才进游戏，
    // 游戏事件按此表逐频道 fan-out。重复项只保留首个。
    // 例："channels": ["123456789", "987654321"]
    "channels": [],

    // WS 握手鉴权 token：首启已自动生成随机值，对端连入时必须携带同一令牌。
    // 清空（""）= 不鉴权（不建议，配置 ws 段后空 token 启动会告警）；改后需重启。
    // embedded 模式下本值自动注入内嵌协议端，无需二次配置。
    "token": "${token}",

    // 群管理员映射（缺省 [] = 无人可经 command 执行命令）：
    // 频道命中且用户 ID 在 users 内才放行。运行期可热载。
    // 例："admins": [{ "channel": "123456789", "users": ["10001"] }]
    "admins": [],

    // 宿主运行参数
    "runtime": {
        // Node 子进程异常退出后看护器是否自动重启（1s/5s/15s 退避、10 分钟窗 3 次放弃，不可配置）。
        // 启动时随 ready 帧上报一次，改后重启生效。
        "autoRestart": true
    }

    // ---- 以下可选段默认不生成，需要时取消注释即可 ----

    // WS 监听段：对端连入点。整段缺省 = 动态端口 + 全部接口；只配 host 不配 port 也合法。
    // 端口建议避开 25565（MC）与 25575（RCON）；端口被占则启动失败退出。
    // "ws": {
    //     "host": "127.0.0.1",
    //     "port": 25580
    // },

    // 内嵌 napuketto 段（QQ 协议端，仅 Windows）：整段缺省 = 不内嵌。
    // enabled 必填（重行为要求显式声明），开启后必须同时配 ws.port（连接 url 静态拼入）；
    // qq 为机器人 QQ 号（必填，缺失或占位值会被启动守卫拦截，给出单行引导）；
    // logLevel 可选（napuketto 控制台日志级别，缺省 info）。
    // 连接参数由宿主注入托管，无需手工编辑 napuketto.toml。
    // "embedded": {
    //     "napuketto": {
    //         "enabled": true,
    //         "qq": "10001",
    //         "logLevel": "info"
    //     }
    // },

    // 服务器标识：经 hello_ack.serverId 上报给对端，缺省 "kurobridge"。
    // "server": {
    //     "id": "my-server"
    // }
}
`;
}
