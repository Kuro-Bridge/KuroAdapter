/**
 * core 的 ConfigStore Node 实现（MVP 阶段一）。
 *
 * - 路径：`<服务器根>/plugins/kurobot/config.json`（相对子进程 cwd——Java 以服务器
 *   根目录拉起 Node，见架构书 §6「配置 JSON 放 plugins/kurobot/，Node 读写」）。
 * - 缺失 → 生成默认配置（`{ "channels": [] }`）落盘后返回。
 * - watch：轮询 mtime（默认 2s，unref 不阻止退出）。选轮询而非 fs.watch：
 *   Windows/网络盘的 fs.watch 事件语义不可靠且平台差异大，轮询实现更简单可测
 *   （任务书 §1.2「文件监听 vs 控制台命令」二选一的决策，理由见 MVP1-NOTES）。
 * - watch 只投递合法配置；解析失败记 error 日志并跳过该次变更（等服主修复）。
 * - load 在文件非法时抛 ConfigError（调用方决定降级策略）。
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { Logger } from "@kuro-bridge/bridge-core";
import {
    ConfigError,
    type ConfigStore,
    defaultConfig,
    type KurobotConfig,
    parseConfig,
} from "@kuro-bridge/bridge-core";

export interface NodeConfigStoreOptions {
    readonly logger: Logger;
    /** 服务器根目录（配置解析基准）；缺省 process.cwd() */
    readonly serverRoot?: string;
    /** 轮询间隔毫秒（缺省 2000；0 表示不轮询——纯 load 模式，测试用） */
    readonly pollIntervalMs?: number;
}

const CONFIG_RELATIVE = join("plugins", "kurobot", "config.json");

export class NodeConfigStore implements ConfigStore {
    private readonly logger: Logger;
    private readonly configPath: string;
    private readonly pollIntervalMs: number;
    private lastMtimeMs: number | null = null;
    private lastSize: number | null = null;

    constructor(options: NodeConfigStoreOptions) {
        this.logger = options.logger;
        const root = resolve(options.serverRoot ?? process.cwd());
        this.configPath = join(root, CONFIG_RELATIVE);
        this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    }

    async load(): Promise<KurobotConfig> {
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
        await this.rememberStat();
        return this.parseOrThrow(text);
    }

    watch(onChange: (config: KurobotConfig) => void): () => void {
        if (this.pollIntervalMs <= 0) {
            return () => undefined;
        }
        const timer = setInterval(() => {
            void this.poll(onChange);
        }, this.pollIntervalMs);
        timer.unref();
        return () => {
            clearInterval(timer);
        };
    }

    private async poll(onChange: (config: KurobotConfig) => void): Promise<void> {
        let mtimeMs: number | null;
        let size: number | null;
        try {
            const stats = await stat(this.configPath);
            mtimeMs = stats.mtimeMs;
            size = stats.size;
        } catch {
            return; // 文件暂时不可读（如编辑器原子替换的空窗）——下轮再试
        }
        if (mtimeMs === this.lastMtimeMs && size === this.lastSize) {
            return;
        }
        this.lastMtimeMs = mtimeMs;
        this.lastSize = size;
        let text: string;
        try {
            text = await readFile(this.configPath, "utf8");
        } catch {
            return;
        }
        let config: KurobotConfig;
        try {
            config = parseConfig(JSON.parse(text));
        } catch (error: unknown) {
            this.logger.error(
                `配置变更解析失败，保留旧绑定（修复后自动生效）：${this.configPath}`,
                error,
            );
            return;
        }
        this.logger.info(`检测到配置变更：${this.configPath}`);
        onChange(config);
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
        await this.rememberStat();
    }

    private async rememberStat(): Promise<void> {
        try {
            const stats = await stat(this.configPath);
            this.lastMtimeMs = stats.mtimeMs;
            this.lastSize = stats.size;
        } catch {
            this.lastMtimeMs = null;
            this.lastSize = null;
        }
    }

    private parseOrThrow(text: string): KurobotConfig {
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
