/**
 * napuketto CLI spawner（MVP-4，ADR-029）：以子进程拉起 @napuketto/cli。
 * KuroAdapter 不重造 supervisor/QR/凭据，只做拉起、stdio 捕获→logger、生命周期接线。
 *
 * 进程树（ADR-022 换真身）：Java → node（本进程）→ napuketto CLI（supervisor）→
 * boot → self-host（最深四层）。
 *
 * 生命周期（NapukettoQQ 仓考据：boot 层无信号处理器、全链无父死监测——只杀 CLI 本体
 * 必留 self-host 孤儿持 instance.lock）：
 * - 优雅关停 stop()：Windows `taskkill /PID <pid> /T /F` 树杀（napuketto 自家
 *   `napuketto stop` 同款，/T 连带 boot/self-host）→ 有界等待 exit → resolve；
 * - 意外退出 onUnexpectedExit：bootstrap 收到后 node exit(1)，交 Java 看护器退避重启
 *   （凭据在腾讯原生层，重启后 quick-login 自动恢复）；
 * - 强杀 node：CLI 树预期随 Node 26 Job Object 级联死亡（DEBT-2 发现，沙盒复验）。
 *
 * 全部副作用可注入（spawnFn / killTree / platform / cliExists），vitest 不发真进程。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import type { KurobotConfig, Logger } from "@kurobot/bridge-core";

/** CLI 嵌包在 bin 目录下的固定布局（scripts/embed.ts 产 zip、:core EmbeddedRuntime 解压共同约定） */
const CLI_ENTRY_PARTS = ["napuketto", "node_modules", "@napuketto", "cli", "dist", "index.mjs"];
const DEFAULT_CONFIG_RELATIVE = join("plugins", "kurobot", "napuketto.toml");
const DEFAULT_DATA_RELATIVE = join("plugins", "kurobot", "napuketto-data");

/** napuketto 分支的启动决策（守卫与路径解析全部纯函数化，bootstrap 只做接线） */
export type NapukettoLaunchDecision =
    | { action: "spawn"; configPath: string; dataDir: string; cliEntry: string }
    | { action: "skip"; reason: string }
    | { action: "fatal"; reason: string };

export interface DecideNapukettoLaunchInput {
    config: KurobotConfig;
    /** 宿主平台（注入便于测试；生产 = process.platform） */
    platform: NodeJS.Platform;
    /** 相对路径（configPath/dataDir）的解析基准 = 服务器根（node 子进程 cwd） */
    cwd: string;
    /** index.mjs 所在目录（bin）——CLI 嵌包按 <bin>/napuketto/node_modules 布局解析 */
    binDir: string;
    /** 缺省 node:fs.existsSync */
    cliExists?: (path: string) => boolean;
}

/** 前置：调用方须已判定 embedded.napuketto.enabled === true（否则走既有 stub 路径） */
export function decideNapukettoLaunch(input: DecideNapukettoLaunchInput): NapukettoLaunchDecision {
    if (input.platform !== "win32") {
        return {
            action: "skip",
            reason:
                "QQ 宿主（napuketto self-host）当前仅支持 Windows，napuketto 不拉起" +
                "（本进程继续作为纯 kurobot WS 服务端，external 对端不受影响；wine 支持记债务）",
        };
    }
    if (input.config.ws?.port === undefined) {
        return {
            action: "fatal",
            reason:
                "embedded.napuketto.enabled=true 要求配置 ws.port 固定端口：" +
                "napuketto.toml 的 url 是静态的，动态端口无法喂给它" +
                "（快速失败，重启收敛于 Java 看护器退避；请补 config 的 ws.port 后重启）",
        };
    }
    const napuketto = input.config.embedded?.napuketto;
    const configPath = resolveRelative(input.cwd, napuketto?.configPath, DEFAULT_CONFIG_RELATIVE);
    const dataDir = resolveRelative(input.cwd, napuketto?.dataDir, DEFAULT_DATA_RELATIVE);
    const cliEntry = join(input.binDir, ...CLI_ENTRY_PARTS);
    const exists = input.cliExists ?? existsSync;
    if (!exists(cliEntry)) {
        return {
            action: "fatal",
            reason:
                `未找到嵌入的 napuketto CLI 入口：${cliEntry}` +
                "（JAR 模式应随 embedded/napuketto.zip 解压；开发覆盖模式请先在 bin 同布局安装 @napuketto/cli）",
        };
    }
    return { action: "spawn", configPath, dataDir, cliEntry };
}

function resolveRelative(cwd: string, value: string | undefined, fallback: string): string {
    const raw = value ?? fallback;
    return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

export interface NapukettoSpawnSpec {
    cliEntry: string;
    configPath: string;
    dataDir: string;
}

export interface NapukettoDeps {
    logger: Logger;
    /** 注入便于测试；缺省 process.platform */
    platform?: NodeJS.Platform | undefined;
    /** 注入便于测试；缺省 node:child_process.spawn */
    spawnFn?: typeof spawn | undefined;
    /** 注入便于测试；缺省 Windows taskkill 树杀 / POSIX SIGTERM */
    killTree?: ((pid: number) => void) | undefined;
    /** 优雅关停等待上限（对齐 napuketto FORCE_EXIT_MS=5000） */
    stopTimeoutMs?: number | undefined;
    /** 捕获流出现 QR URL 日志时回调（接线 QR 状态文件用）；缺省不检测 */
    onQrUrl?: ((url: string) => void) | undefined;
}

export interface UnexpectedExit {
    code: number | null;
    error?: Error | undefined;
}

export interface NapukettoHandle {
    stop(): Promise<void>;
    /** 非关停路径的退出（CLI 崩溃/spawn 失败）；bootstrap 收到后应退出本进程交看护器重启 */
    onUnexpectedExit(cb: (info: UnexpectedExit) => void): void;
}

/** 拉起 napuketto CLI：stdio 全 pipe（绝不 inherit——node 的 stdout 是 IPC 通道），env 指路 + 原样透传 */
export function spawnNapuketto(spec: NapukettoSpawnSpec, deps: NapukettoDeps): NapukettoHandle {
    const logger = deps.logger;
    const platform = deps.platform ?? process.platform;
    const spawnFn = deps.spawnFn ?? spawn;
    const stopTimeoutMs = deps.stopTimeoutMs ?? 5000;
    const killTreeFn =
        deps.killTree ??
        ((pid: number) => {
            if (platform === "win32") {
                spawnFn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
            } else {
                // 非 Windows 守卫使此路径生产不可达；保留 POSIX 语义供测试与未来 wine 债务
                try {
                    process.kill(pid, "SIGTERM");
                } catch {
                    // 进程已死，无需处理
                }
            }
        });

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        NAPKETTO_CONFIG: spec.configPath,
        NAPKETTO_DATA: spec.dataDir,
    };
    const child = spawnFn(process.execPath, [spec.cliEntry], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
    });
    logger.info(`napuketto CLI 已拉起（pid=${child.pid ?? "?"}）：${spec.cliEntry}`);

    let stopping = false;
    let reported = false;
    const exitCbs: Array<(info: UnexpectedExit) => void> = [];

    pipeLines(child.stdout, logger, deps.onQrUrl);
    pipeLines(child.stderr, logger, deps.onQrUrl);

    const reportOnce = (code: number | null, error?: Error): void => {
        if (reported) {
            return;
        }
        reported = true;
        if (stopping) {
            logger.info(`napuketto CLI 已退出（code=${code ?? "null"}，关停路径）`);
            return;
        }
        for (const cb of exitCbs) {
            cb({ code, error });
        }
    };
    child.on("exit", (code) => reportOnce(code));
    // spawn 失败（如 ENOENT）只有 error 没有 exit：一并收敛到同一报告点
    child.on("error", (error: Error) => {
        logger.error(`napuketto CLI error 事件：${String(error)}`);
        reportOnce(null, error);
    });

    return {
        stop: () => {
            stopping = true;
            return new Promise<void>((resolveStop) => {
                if (child.pid === undefined || child.exitCode !== null) {
                    resolveStop();
                    return;
                }
                const timer = setTimeout(resolveStop, stopTimeoutMs);
                timer.unref();
                child.once("exit", () => {
                    clearTimeout(timer);
                    resolveStop();
                });
                killTreeFn(child.pid);
            });
        },
        onUnexpectedExit: (cb) => {
            exitCbs.push(cb);
        },
    };
}

/** CLI 逐行输出里的 pino-pretty 级别字样（大写、词边界，防正文误伤） */
const LOG_LEVEL_ERROR = /\bERROR\b/;
const LOG_LEVEL_WARN = /\bWARN\b/;
/** QR URL 日志（napuketto kernel 固定文案，全角括号；URL 解析 best-effort——格式变更即失效，PNG 路径为主） */
const QR_URL_LOG = /请扫描二维码登录（保存:\s*.+?\s*\|\s*URL:\s*(\S+?)）/;
/** 级别字样 + QR 日志匹配在行级热路径，预编译为顶层常量（lint/performance/useTopLevelRegex） */

/** 逐行捕获并按 pino-pretty 固定的级别字样分流（ASCII 二维码/BANNER 无级别字样 → info 透传） */
function pipeLines(
    stream: Readable | null,
    logger: Logger,
    onQrUrl: ((url: string) => void) | undefined,
): void {
    if (stream === null) {
        return;
    }
    const rl = createInterface({ input: stream, terminal: false });
    rl.on("line", (line: string) => {
        const text = `[napuketto] ${line}`;
        if (LOG_LEVEL_ERROR.test(line)) {
            logger.error(text);
        } else if (LOG_LEVEL_WARN.test(line)) {
            logger.warn(text);
        } else {
            logger.info(text);
        }
        if (onQrUrl !== undefined) {
            const match = QR_URL_LOG.exec(line);
            if (match !== null && match[1] !== undefined) {
                onQrUrl(match[1]);
            }
        }
    });
}
