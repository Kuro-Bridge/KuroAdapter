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

import type { KurobridgeConfig, Logger } from "@kuro-bridge/bridge-core";

/** CLI 嵌包在 bin 目录下的固定布局（toolings/packaging/embed.ts 产 zip、:core EmbeddedRuntime 解压共同约定） */
const CLI_ENTRY_PARTS = ["napuketto", "node_modules", "@napuketto", "cli", "dist", "index.mjs"];
const DEFAULT_CONFIG_RELATIVE = join("plugins", "kurobridge", "napuketto.toml");
const DEFAULT_DATA_RELATIVE = join("plugins", "kurobridge", "napuketto-data");

/** napuketto 分支的启动决策（守卫与路径解析全部纯函数化，bootstrap 只做接线） */
export type NapukettoLaunchDecision =
    | { action: "spawn"; configPath: string; dataDir: string; cliEntry: string }
    | { action: "skip"; reason: string }
    | { action: "fatal"; reason: string };

export interface DecideNapukettoLaunchInput {
    config: KurobridgeConfig;
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
                "（本进程继续作为纯 kurobridge WS 服务端，external 对端不受影响；wine 支持记债务）",
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
            // taskkill /T /F 树杀的退出码恒为 1（机制产物，非结果信号）——不展示 code，
            // 等 napuketto 上游落地优雅退出（退出码契约）后再恢复语义
            logger.info("napuketto CLI 已关停（树杀）");
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

/** CLI 逐行输出里的 pino-pretty 级别字样（大写、词边界，防正文误伤）；FATAL 并入 error 分流（ADR-034，pino 有 fatal 级） */
const LOG_LEVEL_ERROR = /\bERROR\b/;
const LOG_LEVEL_FATAL = /\bFATAL\b/;
const LOG_LEVEL_WARN = /\bWARN\b/;
/** QR URL 日志（napuketto kernel 固定文案，全角括号；URL 解析 best-effort——格式变更即失效，PNG 路径为主） */
const QR_URL_LOG = /请扫描二维码登录（保存:\s*.+?\s*\|\s*URL:\s*(\S+?)）/;
/** 级别字样 + QR 日志匹配在行级热路径，预编译为顶层常量（lint/performance/useTopLevelRegex） */

/** ANSI 颜色转义（napuketto 无 TTY 检测，pipe 下仍带颜色码） */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 匹配 ANSI 转义序列本就依赖 ESC 控制字符，合法目标
const ANSI_ESCAPE = /\u001B\[[0-9;]*m/g;
/** Unicode 块元素区段（U+2580–U+259F：▀▄█░▒▓ 等）——终端二维码的全部构成字符 */
const QR_ART_BLOCK = /[\u2580-\u259F]/g;

/**
 * napuketto 终端 ASCII 二维码行判定（导出供单测）：
 * 去 ANSI 后块元素 ≥10（QR 图行），或去 ANSI 后整行 ≥15 个 `?`（底层字符经
 * 控制台编码降级后的残骸行）。正常日志（含中文/时间戳/pino 字段）不会命中。
 */
export function isQrArtLine(line: string): boolean {
    const plain = line.replace(ANSI_ESCAPE, "");
    if ((plain.match(QR_ART_BLOCK)?.length ?? 0) >= 10) {
        return true;
    }
    let questions = 0;
    for (const ch of plain) {
        if (ch === "?" && ++questions >= 15) {
            return true;
        }
    }
    return false;
}

/** 单次折叠突发允许的最大行数（防御：超过视为流污染，恢复透传不再吞行） */
const QR_ART_FOLD_CAP = 200;

/**
 * pino-pretty 记录头行（匹配前必须先剥 ANSI——真机 pipe 下输出仍带颜色码，
 * 2026-10-25 cleanroom 实证：带色码时本正则永不命中，多行重组整链失效）。
 * 形态：`[账号] [HH:MM:SS.mmm] LEVEL (pid/scope): 消息`（账号与毫秒可选）。
 * 捕获组：账号（保留转发）、级别（随记录传递，头行剥离后正文不再含级别字样）、
 * 消息体。时间戳 / 级别 / pid 与宿主 logger 前缀重复，重组时丢弃。
 */
const RECORD_HEADER =
    /^\s*(?:\[(\d+)\]\s*)?\[?\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\]?\s+(INFO|WARN|ERROR|FATAL|DEBUG|TRACE)\s*(?:\([^)]*\))?:\s*(.*)$/;
/** banner 画字符（Spring 风格 ASCII banner 的全部构成字符：`_/\|(),<.` + 反引号；无 CJK、无数字、无时间戳） */
const BANNER_ART_CHARS = /^[_/\\|(),<.`· ]+$/;
/** 重组后单条记录的长度上限：超长（如 raw hex 转储）截断，全文留 napuketto 自己的日志侧 */
const RECORD_TRUNCATE_LIMIT = 300;
/**
 * 已知遥测噪音（证据：Paper 26.3 干跑台 latest.log）→ 降 debug（宿主控制台默认不显示）：
 * - onRecvSysMsg 校准数据（协议逆向/校准用，非运行状态，登录后一分钟能刷数百行 hex）
 * - `loader | 接收 <- 群聊`（收包遥测；绑定过滤在 bridge/core，转发结果另有广播行可见）
 * - mmkv loadFromFile（第三方底层库透传）
 */
const NOISE_PATTERNS = [/校准数据/, /接收 <- 群聊/, /loadFromFile/];
/** pino-pretty 的可选 pid/账号前缀（`[12345] `），banner 判定前剥掉 */
const PID_LINE_PREFIX = /^\[\d+\]\s*/;
/** 裸缩进续行（无账号前缀的 pino-pretty 字段/列表行） */
const INDENTED_LINE = /^\s/;
/** 账号前缀续行：前缀 + pino-pretty 字段缩进（≥2 空格）；单空格是独立行（mmkv 透传等），
 *  不并入——以空格数区分续行与同前缀独立行（2026-10-25 cleanroom 实证形态） */
const PREFIXED_FIELD_LINE = /^\[\d+\]\s{2,}/;
/** 续行内容剥离：行首空白 + 可选账号前缀 */
const CONTINUATION_PREFIX = /^\s*(?:\[\d+\]\s*)?/;

/** banner 画行判定（导出供单测）：去 ANSI 与可选账号前缀后仅由画字符构成且 ≥3 个非空白字符 */
export function isBannerArtLine(line: string): boolean {
    const plain = line.replace(ANSI_ESCAPE, "").replace(PID_LINE_PREFIX, "");
    const stripped = plain.replace(/\s/g, "");
    return stripped.length >= 3 && stripped.length <= 200 && BANNER_ART_CHARS.test(stripped);
}

function truncateRecord(record: string): string {
    if (record.length <= RECORD_TRUNCATE_LIMIT) {
        return record;
    }
    return `${record.slice(0, RECORD_TRUNCATE_LIMIT)}…（截断，原长 ${record.length} 字符）`;
}

/**
 * 按级别分流转发一条重组后的记录；已知遥测噪音降 debug。
 * level 为头行捕获的级别字样（头行已剥离，正文不再含级别）；非记录行（无头行）传 null，
 * 退回正文扫描。异常日志静默降级 info 的教训见 ADR-034。
 */
function logNapukettoRecord(logger: Logger, record: string, level: string | null): void {
    const text = `[napuketto] ${record}`;
    if (NOISE_PATTERNS.some((pattern) => pattern.test(record))) {
        logger.debug(text);
        return;
    }
    const effective =
        level ??
        (LOG_LEVEL_ERROR.test(record) || LOG_LEVEL_FATAL.test(record)
            ? "ERROR"
            : LOG_LEVEL_WARN.test(record)
              ? "WARN"
              : null);
    if (effective === "ERROR" || effective === "FATAL") {
        logger.error(text);
    } else if (effective === "WARN") {
        logger.warn(text);
    } else {
        logger.info(text);
    }
}

/** 逐行捕获并按 pino-pretty 固定的级别字样分流；多行记录重组为单行，终端二维码与 ASCII banner 折叠 */
function pipeLines(
    stream: Readable | null,
    logger: Logger,
    onQrUrl: ((url: string) => void) | undefined,
): void {
    if (stream === null) {
        return;
    }
    let foldedRun = 0;
    let recordBuffer: string[] = [];
    let recordLevel: string | null = null;
    let bannerAnnounced = false;
    const flushRecord = (): void => {
        if (recordBuffer.length === 0) {
            return;
        }
        logNapukettoRecord(logger, truncateRecord(recordBuffer.join(" ")), recordLevel);
        recordBuffer = [];
        recordLevel = null;
    };
    /** 终端二维码画行折叠：返回 true = 本行已吞掉（突发超 QR_ART_FOLD_CAP 后透传，防流污染吞行） */
    const foldQrArt = (line: string): boolean => {
        if (!isQrArtLine(line)) {
            return false;
        }
        if (foldedRun === 0) {
            logger.info(
                "[napuketto] （终端二维码输出已折叠；图片路径与登录链接请看 kurobridge qr）",
            );
        }
        foldedRun += 1;
        return foldedRun < QR_ART_FOLD_CAP;
    };
    /** banner 画行整段丢弃（CLI 引导与 kernel 登录后各打一次，纯噪音）；每进程只留一条 debug 提示 */
    const dropBannerArt = (line: string): boolean => {
        if (!isBannerArtLine(line)) {
            return false;
        }
        if (!bannerAnnounced) {
            bannerAnnounced = true;
            logger.debug("[napuketto] （ASCII banner 已折叠）");
        }
        return true;
    };
    /** 记录行分流：头行开新缓冲（账号保留、时间戳/级别/pid 剥离，级别随记录传递）、
     * 续行（裸缩进或账号前缀+字段缩进）并入、其余独立成条（重组见 RECORD_HEADER 注释） */
    const handleRecordLine = (line: string): void => {
        const header = RECORD_HEADER.exec(line);
        if (header !== null) {
            flushRecord();
            const account = header[1];
            const message = header[3] ?? "";
            recordBuffer = [account !== undefined ? `[${account}] ${message}` : message];
            recordLevel = header[2] ?? null;
            return;
        }
        const isContinuation =
            recordBuffer.length > 0 && (INDENTED_LINE.test(line) || PREFIXED_FIELD_LINE.test(line));
        if (isContinuation) {
            recordBuffer.push(line.replace(CONTINUATION_PREFIX, ""));
            return;
        }
        logNapukettoRecord(logger, truncateRecord(line.trim()), null);
    };
    const handleLine = (rawLine: string): void => {
        // 单一去色点：真机 pipe 下 pino-pretty 仍带 ANSI 色码，所有下游判定与转发都用去色行
        const line = rawLine.replace(ANSI_ESCAPE, "");
        emitQrUrlIfMatched(line, onQrUrl);
        if (foldQrArt(line)) {
            return;
        }
        foldedRun = 0;
        if (dropBannerArt(line)) {
            return;
        }
        handleRecordLine(line);
    };
    const rl = createInterface({ input: stream, terminal: false });
    rl.on("line", handleLine);
    rl.on("close", () => {
        flushRecord();
    });
}

/** QR URL 日志提取（行级 best-effort；命中即回调，与折叠/分流无关） */
function emitQrUrlIfMatched(line: string, onQrUrl: ((url: string) => void) | undefined): void {
    if (onQrUrl === undefined) {
        return;
    }
    const match = QR_URL_LOG.exec(line);
    if (match !== null && match[1] !== undefined) {
        onQrUrl(match[1]);
    }
}
