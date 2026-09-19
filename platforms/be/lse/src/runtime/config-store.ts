/**
 * core 的 ConfigStore Node 实现（lse node shim 侧；读写策略对齐 bridge/embedded/config-store）：
 * 路径 <serverRoot>/plugins/kurobridge/config.json；缺失 → 生成默认落盘（'wx'，不覆盖
 * 服主手写内容）；非法 → ConfigError（调用方降级空绑定运行）。
 * watch 不做轮询：LSE 无插件级配置重载触发点（裁决册 §4.3 差异项），配置改动以
 * 重启 shim（看护器重拉）为准。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
    ConfigError,
    type ConfigStore,
    defaultConfig,
    type KurobridgeConfig,
    type Logger,
    parseConfig,
} from "@kuro-bridge/bridge-core";

export interface FileConfigStoreOptions {
    readonly logger: Logger;
    /** 服务器根目录（--server-root 显式传入，消解子进程 cwd 依赖，裁决册 §6.1） */
    readonly serverRoot: string;
}

export class FileConfigStore implements ConfigStore {
    private readonly logger: Logger;
    private readonly configPath: string;

    constructor(options: FileConfigStoreOptions) {
        this.logger = options.logger;
        this.configPath = join(options.serverRoot, "plugins", "kurobridge", "config.json");
    }

    async load(): Promise<KurobridgeConfig> {
        let text: string;
        try {
            text = await readFile(this.configPath, "utf8");
        } catch (error: unknown) {
            if (isNotFound(error)) {
                await this.writeDefault();
                return defaultConfig();
            }
            throw new ConfigError(`读取配置失败：${this.configPath}`, error);
        }
        return this.parseOrThrow(text);
    }

    watch(_onChange: (config: KurobridgeConfig) => void): () => void {
        this.logger.debug("lse shim 不做配置文件轮询（配置改动以重启 shim 为准）");
        return () => undefined;
    }

    private async writeDefault(): Promise<void> {
        try {
            await mkdir(dirname(this.configPath), { recursive: true });
            await writeFile(this.configPath, `${JSON.stringify(defaultConfig(), null, 4)}\n`, {
                flag: "wx", // 已存在（并发）则放弃，不覆盖服主手写内容
            });
            this.logger.info(`配置缺失，已生成默认配置：${this.configPath}`);
        } catch (error: unknown) {
            if (!isExists(error)) {
                throw new ConfigError(`生成默认配置失败：${this.configPath}`, error);
            }
        }
    }

    private parseOrThrow(text: string): KurobridgeConfig {
        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch (error: unknown) {
            throw new ConfigError(`配置不是合法 JSON：${this.configPath}`, error);
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
