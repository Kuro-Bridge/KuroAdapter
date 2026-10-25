/**
 * core 的 ConfigStore Node 实现（MVP 阶段一；ADR-040 起 JSONC 化）。
 *
 * - 路径：优先 `<服务器根>/plugins/kurobridge/config.jsonc`；缺失且存在旧版
 *   `config.json` 时回退读取（JSONC 解析器是 JSON 超集，旧文件原样可读，不迁移不重命名）；
 *   两文件都缺 → 生成带注释 JSONC 模板落盘（含随机 token，开箱即鉴权，对齐 Pure 线）。
 * - watch：轮询 mtime（默认 2s，unref 不阻止退出）。选轮询而非 fs.watch：
 *   Windows/网络盘的 fs.watch 事件语义不可靠且平台差异大，轮询实现更简单可测
 *   （任务书 §1.2「文件监听 vs 控制台命令」二选一的决策，理由见 MVP1-NOTES）。
 *   轮询目标 = load 时实际命中的文件（jsonc 优先；改用 jsonc 后重启即切回）。
 * - watch 只投递合法配置；解析失败记 error 日志并跳过该次变更（等服主修复）。
 * - load 在文件非法时抛 ConfigError（调用方决定降级策略）。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { Logger } from "@kuro-bridge/bridge-core";
import {
    ConfigError,
    type ConfigStore,
    defaultConfig,
    defaultConfigJsonc,
    type KurobridgeConfig,
    parseConfig,
    parseJsonc,
} from "@kuro-bridge/bridge-core";

export interface NodeConfigStoreOptions {
    readonly logger: Logger;
    /** 服务器根目录（配置解析基准）；缺省 process.cwd() */
    readonly serverRoot?: string;
    /** 轮询间隔毫秒（缺省 2000；0 表示不轮询——纯 load 模式，测试用） */
    readonly pollIntervalMs?: number;
}

const CONFIG_RELATIVE = join("plugins", "kurobridge", "config.jsonc");
const LEGACY_CONFIG_RELATIVE = join("plugins", "kurobridge", "config.json");

/** 首启随机 token 的字节数（16 字节 → 32 位小写 hex，形状对齐 Pure 线 ConfigBootstrap） */
const TOKEN_BYTES = 16;

export class NodeConfigStore implements ConfigStore {
    private readonly logger: Logger;
    private readonly configPath: string;
    private readonly legacyConfigPath: string;
    /** watch 轮询目标 = load 时实际命中的文件（jsonc 优先，回退旧 json） */
    private activePath: string;
    private pollIntervalMs: number;
    private lastMtimeMs: number | null = null;
    private lastSize: number | null = null;

    constructor(options: NodeConfigStoreOptions) {
        this.logger = options.logger;
        const root = resolve(options.serverRoot ?? process.cwd());
        this.configPath = join(root, CONFIG_RELATIVE);
        this.legacyConfigPath = join(root, LEGACY_CONFIG_RELATIVE);
        this.activePath = this.configPath;
        this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    }

    async load(): Promise<KurobridgeConfig> {
        let text: string | null = null;
        try {
            text = await readFile(this.configPath, "utf8");
            this.activePath = this.configPath;
        } catch (error: unknown) {
            if (!isNotFound(error)) {
                throw new ConfigError(`读取配置失败：${this.configPath}`, error);
            }
            try {
                text = await readFile(this.legacyConfigPath, "utf8");
                this.activePath = this.legacyConfigPath;
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
        await this.rememberStat();
        return this.parseOrThrow(text);
    }

    watch(onChange: (config: KurobridgeConfig) => void): () => void {
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

    private async poll(onChange: (config: KurobridgeConfig) => void): Promise<void> {
        let mtimeMs: number | null;
        let size: number | null;
        try {
            const stats = await stat(this.activePath);
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
            text = await readFile(this.activePath, "utf8");
        } catch {
            return;
        }
        let config: KurobridgeConfig;
        try {
            config = parseConfig(parseJsonc(text));
        } catch (error: unknown) {
            this.logger.error(
                `配置变更解析失败，保留旧绑定（修复后自动生效）：${this.activePath}`,
                error,
            );
            return;
        }
        this.logger.info(`检测到配置变更：${this.activePath}`);
        onChange(config);
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
        await this.rememberStat();
    }

    private async rememberStat(): Promise<void> {
        try {
            const stats = await stat(this.activePath);
            this.lastMtimeMs = stats.mtimeMs;
            this.lastSize = stats.size;
        } catch {
            this.lastMtimeMs = null;
            this.lastSize = null;
        }
    }

    private parseOrThrow(text: string): KurobridgeConfig {
        let raw: unknown;
        try {
            raw = parseJsonc(text);
        } catch (error: unknown) {
            throw new ConfigError(`配置不是合法 JSONC：${this.activePath}`, error);
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
