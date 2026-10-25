/**
 * core 的 ConfigStore Node 实现（lse node shim 侧；读写策略对齐 bridge/embedded/config-store，
 * ADR-040 起 JSONC 化）：优先 <serverRoot>/plugins/kurobridge/config.jsonc；缺失且存在旧版
 * config.json 时回退读取（JSONC 解析器是 JSON 超集，不迁移不重命名）；两文件都缺 → 生成
 * 带注释 JSONC 模板落盘（含随机 token，'wx'，不覆盖服主手写内容）；非法 → ConfigError
 * （调用方降级空绑定运行）。
 * watch 不做轮询：LSE 无插件级配置重载触发点（裁决册 §4.3 差异项），配置改动以
 * 重启 shim（看护器重拉）为准。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
    ConfigError,
    type ConfigStore,
    defaultConfig,
    defaultConfigJsonc,
    type KurobridgeConfig,
    type Logger,
    parseConfig,
    parseJsonc,
} from "@kuro-bridge/bridge-core";

export interface FileConfigStoreOptions {
    readonly logger: Logger;
    /** 服务器根目录（--server-root 显式传入，消解子进程 cwd 依赖，裁决册 §6.1） */
    readonly serverRoot: string;
}

const CONFIG_RELATIVE = join("plugins", "kurobridge", "config.jsonc");
const LEGACY_CONFIG_RELATIVE = join("plugins", "kurobridge", "config.json");

/** 首启随机 token 的字节数（16 字节 → 32 位小写 hex，形状对齐 embedded 与 Pure 线） */
const TOKEN_BYTES = 16;

export class FileConfigStore implements ConfigStore {
    private readonly logger: Logger;
    private readonly configPath: string;
    private readonly legacyConfigPath: string;

    constructor(options: FileConfigStoreOptions) {
        this.logger = options.logger;
        this.configPath = join(options.serverRoot, CONFIG_RELATIVE);
        this.legacyConfigPath = join(options.serverRoot, LEGACY_CONFIG_RELATIVE);
    }

    async load(): Promise<KurobridgeConfig> {
        let text: string | null = null;
        try {
            text = await readFile(this.configPath, "utf8");
        } catch (error: unknown) {
            if (!isNotFound(error)) {
                throw new ConfigError(`读取配置失败：${this.configPath}`, error);
            }
            try {
                text = await readFile(this.legacyConfigPath, "utf8");
                this.logger.info(
                    `已从旧版 config.json 读取（改名为 config.jsonc 可获得注释模板）：${this.legacyConfigPath}`,
                );
            } catch (legacyError: unknown) {
                if (!isNotFound(legacyError)) {
                    throw new ConfigError(`读取配置失败：${this.legacyConfigPath}`, legacyError);
                }
                // 两文件都缺：生成带注释模板（含随机 token），首启即鉴权闭环（ADR-040）
                const token = randomBytes(TOKEN_BYTES).toString("hex");
                await this.writeDefault(token);
                return defaultConfig(token);
            }
        }
        return this.parseOrThrow(text);
    }

    watch(_onChange: (config: KurobridgeConfig) => void): () => void {
        this.logger.debug("lse shim 不做配置文件轮询（配置改动以重启 shim 为准）");
        return () => undefined;
    }

    private async writeDefault(token: string): Promise<void> {
        try {
            await mkdir(dirname(this.configPath), { recursive: true });
            await writeFile(this.configPath, defaultConfigJsonc(token), {
                flag: "wx", // 已存在（并发）则放弃，不覆盖服主手写内容
            });
            this.logger.info(`配置缺失，已生成默认配置（含随机 token）：${this.configPath}`);
        } catch (error: unknown) {
            if (!isExists(error)) {
                throw new ConfigError(`生成默认配置失败：${this.configPath}`, error);
            }
        }
    }

    private parseOrThrow(text: string): KurobridgeConfig {
        let raw: unknown;
        try {
            raw = parseJsonc(text);
        } catch (error: unknown) {
            throw new ConfigError(`配置不是合法 JSONC：${this.configPath}`, error);
        }
        return parseConfig(raw);
    }
}

function isNotFound(error: unknown): boolean {
    return isNodeException(error) && error.code === "ENOENT";
}

function isExists(error: unknown): boolean {
    return isNodeException(error) && error.code === "EEXIST";
}

function isNodeException(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error;
}
