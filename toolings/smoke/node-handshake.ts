#!/usr/bin/env node
/**
 * toolings/smoke/node-handshake.ts —— 内嵌运行时「原生冒烟」（CI 三平台矩阵）
 *
 * 为什么需要它：`pnpm check` / `gradlew test` 只能证明「构建成功、sha256 对得上」，证明不了
 * 「这份 node 二进制在这个内核上真能跑」。Linux 二进制更不可能在 Windows 开发机上验——
 * 所以把验收放到同架构 runner 上，用真机跑一条最小闭环：
 *
 *   1) `embedded/<当前平台> --version`：动态链接器 / glibc 基线 / 可执行位的最小验证；
 *   2) 拉起 `embedded/index.mjs`（与 Java 侧同一条命令），等 IPC 的 `ready` 帧拿 wsPort；
 *   3) 用 Node 内置 WebSocket 连上去做 `hello` → `hello_ack` 与 `query bindings` 往返：
 *      证明 bundle 可加载、KurobridgeServer 能监听、协议层与绑定表在这个平台工作；
 *   4) 关 stdin（等价 Java 关停动作）→ 期望 exit 0（ADR-041 优雅关停契约）。
 *
 * 只读 `platforms/je/paper/src/main/resources/embedded/`（build:embed 的产物，与 JAR 内
 * embedded/ 同源同字节），因此不需要 JDK，也不需要先打 JAR。
 *
 * 目标：CI 矩阵用 KUROBRIDGE_EMBED_TARGETS 只嵌当前 runner 的目标（省两次 ~150MB 下载），
 * 本脚本只认宿主命中的那一个——宿主与 manifest 不对齐即失败（矩阵与 targets 必须同步）。
 *
 * env：KUROBRIDGE_SMOKE_KEEP=1 保留临时目录（失败复盘用）。
 * 用法：pnpm build:embed && pnpm smoke:handshake（仓库根）
 */

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const EMBEDDED_DIR = join(
    REPO_ROOT,
    "platforms",
    "je",
    "paper",
    "src",
    "main",
    "resources",
    "embedded",
);

/** WS 子协议（ADR-003 大版本）；与服务端 ws-server.ts 的校验值一致 */
const SUBPROTOCOL = "kurobridge-ws.v1";
/**
 * hello 携带的协议版本：ADR-026 只比主版本，0.x 内任意补丁版本都被接受——
 * 协议升到 1.0 前这里不必跟着改（改了也不影响，主版本仍是 0）。
 */
const HELLO_PROTOCOL_VERSION = "0.4.0";
const VERSION_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 60_000;
const WS_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 20_000;
const TAIL_LINES = 40;
const LINE_BREAK = /\r?\n/;
const ENV_KEEP = "KUROBRIDGE_SMOKE_KEEP";

/** embedded/manifest.json 的读取面（v2；其余字段本脚本不关心）。 */
export interface EmbeddedManifest {
    readonly schemaVersion: number;
    readonly nodeVersion: string;
    readonly runtimes: Readonly<Record<string, { readonly file: string }>>;
}

/** 子进程输出收集器：失败时一次性打印尾部，不在成功路径刷屏。 */
interface Captured {
    readonly stdout: string[];
    readonly stderr: string[];
}

/** 一帧 IPC / WS 消息（header + body，其余字段忽略）。 */
interface Frame {
    readonly header: { readonly type: string; readonly id?: string };
    readonly body: Readonly<Record<string, unknown>>;
}

interface RuntimeArtifacts {
    readonly node: string;
    readonly bundle: string;
}

interface ServerHandle {
    readonly child: ChildProcessWithoutNullStreams;
    readonly wsPort: number;
}

/** 宿主平台 → 与 Java `PlatformKey` / embed 目标表同一套键；不支持的平台返回 null。 */
const OS_KEYS: Readonly<Record<string, string>> = { win32: "win", linux: "linux" };
const ARCH_KEYS: Readonly<Record<string, string>> = { x64: "x64", arm64: "arm64" };

export function hostTargetFor(platform: string, arch: string): string | null {
    const os = OS_KEYS[platform];
    const cpu = ARCH_KEYS[arch];
    return os === undefined || cpu === undefined ? null : `${os}-${cpu}`;
}

export function tailLines(lines: readonly string[], count: number): string {
    return lines.slice(-count).join("\n");
}

function log(message: string): void {
    console.log(`[smoke] ${message}`);
}

function readManifest(): EmbeddedManifest {
    const path = join(EMBEDDED_DIR, "manifest.json");
    if (!existsSync(path)) {
        throw new Error(`找不到 ${path}：先跑 pnpm -r build && pnpm build:embed`);
    }
    const manifest = JSON.parse(readFileSync(path, "utf8")) as EmbeddedManifest;
    if (manifest.schemaVersion !== 2) {
        throw new Error(
            `embedded/manifest.json 的 schemaVersion 非 2（实际 ${String(manifest.schemaVersion)}）：先重跑 embed`,
        );
    }
    return manifest;
}

/** 把二进制与 bundle 拷进临时 bin/（模拟 plugins/kurobridge/bin）+ POSIX 补执行位。 */
function prepareArtifacts(
    manifest: EmbeddedManifest,
    target: string,
    workDir: string,
): RuntimeArtifacts {
    const runtime = manifest.runtimes[target];
    if (runtime === undefined) {
        throw new Error(
            `manifest 内没有 ${target}（可用：${Object.keys(manifest.runtimes).join(", ")}）——` +
                "CI 矩阵 runner 与 toolings/runtime-manifest.json 的 targets 必须对齐",
        );
    }
    const binDir = join(workDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const node = join(binDir, runtime.file);
    copyFileSync(join(EMBEDDED_DIR, runtime.file), node);
    if (process.platform !== "win32") {
        chmodSync(node, 0o755);
    }
    const bundle = join(binDir, "index.mjs");
    copyFileSync(join(EMBEDDED_DIR, "index.mjs"), bundle);
    return { node, bundle };
}

/** 二进制自检：`--version` 输出必须等于 manifest 钉的版本。 */
function checkBinaryVersion(nodePath: string, expected: string): void {
    const result = spawnSync(nodePath, ["--version"], {
        encoding: "utf8",
        timeout: VERSION_TIMEOUT_MS,
    });
    if (result.error !== undefined) {
        throw new Error(
            `${basename(nodePath)} 无法执行（${String(result.error)}）——Linux 上多为 glibc / ` +
                "GLIBCXX 基线不足或可执行位丢失",
        );
    }
    if (result.status !== 0) {
        throw new Error(
            `${basename(nodePath)} --version 退出码 ${String(result.status)}：` +
                `${(result.stderr ?? "").trim()}`,
        );
    }
    const actual = (result.stdout ?? "").trim();
    if (actual !== `v${expected}`) {
        throw new Error(`${basename(nodePath)} --version 输出 ${actual}，期望 v${expected}`);
    }
    log(`二进制自检通过：${basename(nodePath)} → ${actual}`);
}

/**
 * 预置最小配置（token 空 = 不鉴权，冒烟只验通路；不配 ws 段 = 动态端口 listen(0)，
 * 避免 CI 上的固定端口占用）。由本脚本写入而非依赖首启生成，保证 token 可预期。
 */
function writeConfig(workDir: string): void {
    const dir = join(workDir, "plugins", "kurobridge");
    mkdirSync(dir, { recursive: true });
    const config = {
        channels: [],
        token: "",
        admins: [],
        runtime: { autoRestart: true },
    };
    writeFileSync(join(dir, "config.jsonc"), `${JSON.stringify(config, null, 4)}\n`);
}

function appendLines(sink: string[], chunk: string): void {
    for (const line of chunk.split(LINE_BREAK)) {
        if (line.length > 0) {
            sink.push(line);
        }
    }
}

export function parseFrame(line: string): Frame | null {
    if (line.trim().length === 0) {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) {
        return null;
    }
    const header: unknown = (parsed as { header?: unknown }).header;
    if (typeof header !== "object" || header === null) {
        return null;
    }
    const type: unknown = (header as { type?: unknown }).type;
    if (typeof type !== "string") {
        return null;
    }
    const body: unknown = (parsed as { body?: unknown }).body;
    return {
        header: header as Frame["header"],
        body: typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {},
    };
}

/** 拉起 bundle，等 IPC `ready` 帧（携带实际 wsPort）；提前退出 / 超时都算失败。 */
function startServer(
    artifacts: RuntimeArtifacts,
    workDir: string,
    captured: Captured,
): Promise<ServerHandle> {
    const child = spawn(artifacts.node, [artifacts.bundle], {
        cwd: workDir,
        stdio: ["pipe", "pipe", "pipe"],
        // 空串 = 不拉 stub 协议端（index.ts 判 length > 0）
        env: { ...process.env, KUROBRIDGE_STUB_PEER: "" },
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
        appendLines(captured.stderr, chunk);
    });

    return new Promise<ServerHandle>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`等待 ready 帧超时（${READY_TIMEOUT_MS} ms）`));
        }, READY_TIMEOUT_MS);
        const lines = createInterface({ input: child.stdout });
        lines.on("line", (line) => {
            captured.stdout.push(line);
            const frame = parseFrame(line);
            if (frame === null || frame.header.type !== "ready") {
                return;
            }
            const port: unknown = frame.body["wsPort"];
            if (typeof port !== "number") {
                clearTimeout(timer);
                reject(new Error("ready 帧缺少数值型 wsPort"));
                return;
            }
            clearTimeout(timer);
            resolve({ child, wsPort: port });
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(new Error(`拉起进程失败：${String(error)}`));
        });
        child.on("exit", (code, signal) => {
            clearTimeout(timer);
            reject(
                new Error(
                    `进程在 ready 之前退出（code=${String(code)}, signal=${String(signal)}）`,
                ),
            );
        });
    });
}

function waitOpen(socket: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`WS 连接超时（${WS_TIMEOUT_MS} ms）`));
        }, WS_TIMEOUT_MS);
        socket.addEventListener(
            "open",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
        socket.addEventListener(
            "error",
            () => {
                clearTimeout(timer);
                reject(new Error("WS 连接失败（端口未监听或子协议被拒）"));
            },
            { once: true },
        );
    });
}

function waitFrame(
    socket: WebSocket,
    match: (frame: Frame) => boolean,
    label: string,
): Promise<Frame> {
    return new Promise<Frame>((resolve, reject) => {
        const onMessage = (event: unknown): void => {
            const data: unknown = (event as { data?: unknown }).data;
            const frame = parseFrame(typeof data === "string" ? data : String(data));
            if (frame === null || !match(frame)) {
                return;
            }
            clearTimeout(timer);
            socket.removeEventListener("message", onMessage);
            resolve(frame);
        };
        const timer = setTimeout(() => {
            socket.removeEventListener("message", onMessage);
            reject(new Error(`等待 ${label} 超时（${WS_TIMEOUT_MS} ms）`));
        }, WS_TIMEOUT_MS);
        socket.addEventListener("message", onMessage);
    });
}

/** hello + query 往返（协议层与绑定表的最小实证）；返回 serverId 供日志确认。 */
async function handshake(port: number): Promise<string> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, SUBPROTOCOL);
    try {
        await waitOpen(socket);
        const helloId = randomUUID();
        socket.send(
            JSON.stringify({
                header: { type: "hello", id: helloId },
                body: {
                    peerId: `smoke-${process.pid}`,
                    platform: "smoke",
                    version: "0.0.0",
                    protocolVersion: HELLO_PROTOCOL_VERSION,
                },
            }),
        );
        const ack = await waitFrame(
            socket,
            (frame) => frame.header.type === "hello_ack",
            "hello_ack",
        );
        if (ack.body["ok"] !== true) {
            throw new Error(`握手被拒：${String(ack.body["reason"])}`);
        }
        const serverId = String(ack.body["serverId"]);

        const queryId = randomUUID();
        socket.send(
            JSON.stringify({
                header: { type: "query", id: queryId },
                body: { kind: "bindings" },
            }),
        );
        const result = await waitFrame(
            socket,
            (frame) => frame.header.id === queryId,
            "query_result",
        );
        if (result.body["ok"] !== true || !Array.isArray(result.body["data"])) {
            throw new Error(`query bindings 应答异常：${JSON.stringify(result.body)}`);
        }
        return serverId;
    } finally {
        socket.close();
    }
}

/** 关 stdin（等价 Java 关停）→ 等真实退出码；超时强杀并报错。 */
function shutdown(child: ChildProcessWithoutNullStreams): Promise<number | null> {
    return new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`关 stdin 后 ${EXIT_TIMEOUT_MS} ms 未退出（已强杀）`));
        }, EXIT_TIMEOUT_MS);
        child.once("exit", (code) => {
            clearTimeout(timer);
            resolve(code);
        });
        child.stdin.end();
    });
}

async function main(): Promise<void> {
    const manifest = readManifest();
    const target = hostTargetFor(process.platform, process.arch);
    if (target === null) {
        throw new Error(`不支持的宿主平台：${process.platform}/${process.arch}`);
    }
    log(
        `宿主 ${target}；manifest 运行时 [${Object.keys(manifest.runtimes).join(", ")}]；` +
            `Node ${manifest.nodeVersion}`,
    );

    const workDir = mkdtempSync(join(tmpdir(), "kurobridge-smoke-"));
    const captured: Captured = { stdout: [], stderr: [] };
    let child: ChildProcessWithoutNullStreams | null = null;
    try {
        const artifacts = prepareArtifacts(manifest, target, workDir);
        checkBinaryVersion(artifacts.node, manifest.nodeVersion);
        writeConfig(workDir);

        const server = await startServer(artifacts, workDir, captured);
        child = server.child;
        log(`IPC ready：wsPort=${server.wsPort}`);
        const serverId = await handshake(server.wsPort);
        log(`握手通过：serverId=${serverId}，子协议 ${SUBPROTOCOL}，query bindings 往返 OK`);

        const code = await shutdown(server.child);
        if (code !== 0) {
            throw new Error(`优雅关停退出码 ${String(code)}（期望 0）`);
        }
        log("优雅关停通过（stdin EOF → exit 0）");
    } catch (error: unknown) {
        throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n` +
                `--- 子进程 stdout（尾 ${String(TAIL_LINES)} 行）---\n` +
                `${tailLines(captured.stdout, TAIL_LINES)}\n` +
                `--- 子进程 stderr（尾 ${String(TAIL_LINES)} 行）---\n` +
                `${tailLines(captured.stderr, TAIL_LINES)}`,
        );
    } finally {
        if (child !== null && child.exitCode === null && child.signalCode === null) {
            child.kill();
        }
        if (process.env[ENV_KEEP] === "1") {
            log(`临时目录保留：${workDir}`);
        } else {
            rmSync(workDir, { recursive: true, force: true });
        }
    }
    log("冒烟通过：二进制 / 引导层 / WS 握手 / 优雅关停 全绿");
}

// 被单测 import 时只导出纯函数，不跑真机闭环
const invokedDirectly =
    process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
    main().catch((error: unknown) => {
        console.error(`[smoke] 失败：${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
