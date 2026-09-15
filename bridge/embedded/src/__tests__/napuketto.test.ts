/** napuketto spawner 单测（MVP-4）：全部依赖注入，不发真进程 */
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { Logger } from "@kuro-bridge/bridge-core";
import { defaultConfig } from "@kuro-bridge/bridge-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    decideNapukettoLaunch,
    isQrArtLine,
    type NapukettoDeps,
    spawnNapuketto,
    type UnexpectedExit,
} from "../napuketto.ts";

interface RecordedSpawn {
    command: string;
    args: string[];
    options: { env?: Record<string, string>; stdio?: string[] };
}

interface Harness {
    deps: NapukettoDeps;
    logs: Array<{ level: string; message: string }>;
    spawns: RecordedSpawn[];
    killed: number[];
    child: {
        pid: number;
        stdout: PassThrough;
        stderr: PassThrough;
        exitCode: number | null;
        exitListeners: Array<(code: number | null) => void>;
        on(event: string, cb: (...args: never[]) => void): void;
        onceExit(cb: (code: number | null) => void): void;
        emitExit(code: number | null): void;
        emitError(error: Error): void;
    };
}

function makeHarness(overrides?: Partial<NapukettoDeps>): Harness {
    const logs: Harness["logs"] = [];
    const logger: Logger = {
        debug: (message) => logs.push({ level: "debug", message }),
        info: (message) => logs.push({ level: "info", message }),
        warn: (message) => logs.push({ level: "warn", message }),
        error: (message) => logs.push({ level: "error", message }),
    };
    const spawns: RecordedSpawn[] = [];
    const killed: number[] = [];
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exitListeners: Array<(code: number | null) => void> = [];
    let errorListener: ((error: Error) => void) | null = null;
    const child = {
        pid: 4242,
        stdout,
        stderr,
        exitCode: null as number | null,
        exitListeners,
        on(event: string, cb: (...args: never[]) => void) {
            if (event === "error") {
                errorListener = cb as unknown as (error: Error) => void;
            } else if (event === "exit") {
                exitListeners.push(cb as unknown as (code: number | null) => void);
            }
        },
        once(event: string, cb: (...args: never[]) => void) {
            child.on(event, cb);
        },
        onceExit(cb: (code: number | null) => void) {
            exitListeners.push(cb);
        },
        emitExit(code: number | null) {
            child.exitCode = code;
            for (const cb of exitListeners) {
                cb(code);
            }
        },
        emitError(error: Error) {
            errorListener?.(error);
        },
    };
    const spawnFn = ((command: string, args: string[], options: RecordedSpawn["options"]) => {
        spawns.push({ command, args, options });
        return child as never;
    }) as never;
    const deps: NapukettoDeps = {
        logger,
        platform: "win32",
        spawnFn,
        killTree: (pid) => killed.push(pid),
        stopTimeoutMs: 1000,
        ...overrides,
    };
    return { deps, logs, spawns, killed, child };
}

const SPEC = {
    cliEntry: "/bin/napuketto/node_modules/@napuketto/cli/dist/index.mjs",
    configPath: "/srv/plugins/kurobridge/napuketto.toml",
    dataDir: "/srv/plugins/kurobridge/napuketto-data",
};

function makeConfig(overrides?: Record<string, unknown>): Record<string, unknown> {
    return {
        ...defaultConfig(),
        ws: { host: "127.0.0.1", port: 25580 },
        embedded: { napuketto: { enabled: true } },
        ...overrides,
    };
}

async function drain(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

afterEach(() => {
    vi.useRealTimers();
});

describe("decideNapukettoLaunch", () => {
    const base = {
        platform: "win32" as NodeJS.Platform,
        cwd: "/srv",
        binDir: "/srv/plugins/kurobridge/bin",
        cliExists: () => true,
    };

    it("非 Windows 宿主 → skip（不拉起，继续纯 WS 服务端）", () => {
        const decision = decideNapukettoLaunch({
            ...base,
            platform: "linux",
            config: makeConfig() as never,
        });
        if (decision.action !== "skip") {
            throw new Error(`期望 skip，实际 ${decision.action}`);
        }
        expect(decision.reason).toContain("Windows");
    });

    it("enabled 且无 ws.port → fatal（固定端口强制，快速失败）", () => {
        const decision = decideNapukettoLaunch({
            ...base,
            config: makeConfig({ ws: undefined }) as never,
        });
        if (decision.action !== "fatal") {
            throw new Error(`期望 fatal，实际 ${decision.action}`);
        }
        expect(decision.reason).toContain("ws.port");
    });

    it("CLI 入口缺失 → fatal（配置要求嵌入形态而产物缺失）", () => {
        const decision = decideNapukettoLaunch({
            ...base,
            config: makeConfig() as never,
            cliExists: () => false,
        });
        if (decision.action !== "fatal") {
            throw new Error(`期望 fatal，实际 ${decision.action}`);
        }
        expect(decision.reason).toContain("index.mjs");
    });

    it("正常路径 → spawn：相对路径按 cwd 绝对化 + cliEntry 固定布局", () => {
        const decision = decideNapukettoLaunch({
            ...base,
            config: makeConfig({
                embedded: { napuketto: { enabled: true, dataDir: "custom-data" } },
            }) as never,
        });
        expect(decision).toEqual({
            action: "spawn",
            configPath: resolve("/srv", "plugins/kurobridge/napuketto.toml"),
            dataDir: resolve("/srv", "custom-data"),
            cliEntry: join(
                "/srv/plugins/kurobridge/bin",
                "napuketto",
                "node_modules",
                "@napuketto",
                "cli",
                "dist",
                "index.mjs",
            ),
        });
    });

    it("configPath/dataDir 绝对路径原样使用", () => {
        const decision = decideNapukettoLaunch({
            ...base,
            config: makeConfig({
                embedded: {
                    napuketto: {
                        enabled: true,
                        configPath: "/abs/conf.toml",
                        dataDir: "/abs/data",
                    },
                },
            }) as never,
        });
        expect((decision as { configPath: string }).configPath).toBe("/abs/conf.toml");
        expect((decision as { dataDir: string }).dataDir).toBe("/abs/data");
    });
});

describe("isQrArtLine", () => {
    it("带 ANSI 色码的二维码图行（块元素 ≥10）→ true", () => {
        expect(isQrArtLine("\u001B[47m\u001B[30m ▄▄▄▄▄▄▄ ██████ ▄▄▄▄▄▄▄ \u001B[0m")).toBe(true);
    });

    it("控制台编码降级的 ? 残骸行（≥15 个问号）→ true", () => {
        expect(isQrArtLine("\u001B[47m\u001B[30m????????????????????????\u001B[0m")).toBe(true);
    });

    it("正常日志行不误伤：URL 提示 / pino 字段 / 少量问号", () => {
        expect(
            isQrArtLine(
                "WARN (kernel/1): 请扫描二维码登录（保存: C:\\cache\\qrcode.png | URL: https://txz.qq.com/p?k=abc）",
            ),
        ).toBe(false);
        expect(isQrArtLine('19:00:00.000 INFO (kernel/1): state: "waiting_scan"?')).toBe(false);
        expect(isQrArtLine("   /_/ |_/\\")).toBe(false);
    });
});

describe("spawnNapuketto", () => {
    it("spawn 参数：node 自身执行 CLI 入口、env 指路 + 原样透传、stdio 全 pipe", () => {
        const h = makeHarness();
        process.env["KUROBRIDGE_NK_TEST_PASS"] = "keep-me";
        spawnNapuketto(SPEC, h.deps);
        delete process.env["KUROBRIDGE_NK_TEST_PASS"];
        expect(h.spawns).toHaveLength(1);
        const call = h.spawns[0];
        if (call === undefined) {
            throw new Error("spawn 未被调用");
        }
        expect(call.command).toBe(process.execPath);
        expect(call.args).toEqual([SPEC.cliEntry]);
        expect(call.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
        expect(call.options.env?.["NAPKETTO_CONFIG"]).toBe(SPEC.configPath);
        expect(call.options.env?.["NAPKETTO_DATA"]).toBe(SPEC.dataDir);
        expect(call.options.env?.["KUROBRIDGE_NK_TEST_PASS"]).toBe("keep-me");
    });

    it("stdout/stderr 逐行捕获并按级别字样分流（[napuketto] 前缀）", async () => {
        const h = makeHarness();
        const handle = spawnNapuketto(SPEC, h.deps);
        h.child.stdout.write("19:00:00.000 INFO (kernel/1): kurobot adapter started\n");
        h.child.stdout.write("19:00:01.000 WARN (kernel/1): 请扫描二维码登录\n");
        h.child.stderr.write("19:00:02.000 ERROR (kernel/1): boom\n");
        h.child.stdout.write("  █ ASCII QR 无级别字样\n");
        await drain();
        const byLevel = (level: string) =>
            h.logs.filter((l) => l.level === level).map((l) => l.message);
        expect(byLevel("info").some((m) => m.startsWith("[napuketto] 19:00:00.000 INFO"))).toBe(
            true,
        );
        expect(byLevel("warn").some((m) => m.includes("请扫描二维码登录"))).toBe(true);
        expect(byLevel("error").some((m) => m.startsWith("[napuketto] 19:00:02.000 ERROR"))).toBe(
            true,
        );
        expect(byLevel("info").some((m) => m.includes("ASCII QR"))).toBe(true);
        // 收尾：结束句柄等待的 stop（不产生孤儿计时器）
        const stopped = handle.stop();
        h.child.emitExit(0);
        await stopped;
    });

    it("终端 ASCII 二维码按突发折叠为一行提示；URL 提取与后续日志不受影响", async () => {
        const h = makeHarness();
        const urls: string[] = [];
        const handle = spawnNapuketto(SPEC, { ...h.deps, onQrUrl: (u) => urls.push(u) });
        h.child.stdout.write(
            "WARN (kernel/1): 请扫描二维码登录（保存: C:\\cache\\qrcode.png | URL: https://txz.qq.com/p?k=abc）\n",
        );
        for (let i = 0; i < 35; i++) {
            h.child.stdout.write("\u001B[47m\u001B[30m ▄▄▄▄▄▄▄ ██████ ▄▄▄▄▄▄▄ \u001B[0m\n");
        }
        h.child.stdout.write('INFO (kernel/1): state: "waiting_scan"\n');
        await drain();
        const infos = h.logs.filter((l) => l.level === "info").map((l) => l.message);
        expect(infos.filter((m) => m.includes("▄▄▄"))).toHaveLength(0);
        expect(infos.some((m) => m.includes("终端二维码输出已折叠"))).toBe(true);
        expect(infos.some((m) => m.includes("waiting_scan"))).toBe(true);
        expect(urls).toEqual(["https://txz.qq.com/p?k=abc"]);
        // 收尾：结束句柄等待的 stop（不产生孤儿计时器）
        const stopped = handle.stop();
        h.child.emitExit(0);
        await stopped;
    });

    it("stop()：树杀 + 等待 exit → resolve；关停路径的 exit 不触发 onUnexpectedExit", async () => {
        const h = makeHarness();
        const handle = spawnNapuketto(SPEC, h.deps);
        const unexpected: UnexpectedExit[] = [];
        handle.onUnexpectedExit((info) => unexpected.push(info));

        const stopped = handle.stop();
        expect(h.killed).toEqual([4242]);
        h.child.emitExit(0);
        await stopped;
        expect(unexpected).toEqual([]);
    });

    it("stop() 超时也 resolve（树杀失败不挂死关停链）", async () => {
        vi.useFakeTimers();
        const h = makeHarness({ stopTimeoutMs: 500 });
        const handle = spawnNapuketto(SPEC, h.deps);
        let resolved = false;
        void handle.stop().then(() => {
            resolved = true;
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(resolved).toBe(true);
    });

    it("非关停路径 exit → onUnexpectedExit 携带退出码；exit/error 双事件只报告一次", () => {
        const h = makeHarness();
        const handle = spawnNapuketto(SPEC, h.deps);
        const unexpected: UnexpectedExit[] = [];
        handle.onUnexpectedExit((info) => unexpected.push(info));
        h.child.emitExit(1);
        h.child.emitError(new Error("late"));
        expect(unexpected).toEqual([{ code: 1, error: undefined }]);
    });

    it("spawn 失败（error 事件、无 exit）→ 同样上报意外退出", () => {
        const h = makeHarness();
        const handle = spawnNapuketto(SPEC, h.deps);
        const unexpected: UnexpectedExit[] = [];
        handle.onUnexpectedExit((info) => unexpected.push(info));
        h.child.emitError(new Error("ENOENT"));
        expect(unexpected).toHaveLength(1);
        expect(unexpected[0]?.error).toBeInstanceOf(Error);
        expect(h.logs.some((l) => l.level === "error" && l.message.includes("ENOENT"))).toBe(true);
    });
});
