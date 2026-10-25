/** napuketto spawner 单测（MVP-4）：全部依赖注入，不发真进程 */
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { Logger } from "@kuro-bridge/bridge-core";
import { defaultConfig } from "@kuro-bridge/bridge-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    decideNapukettoLaunch,
    isBannerArtLine,
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
    sentinelOps: Array<{ op: "write" | "remove"; dataDir: string }>;
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
    const sentinelOps: Harness["sentinelOps"] = [];
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
        stopSentinel: {
            write: (dataDir) => sentinelOps.push({ op: "write", dataDir }),
            remove: (dataDir) => sentinelOps.push({ op: "remove", dataDir }),
        },
        ...overrides,
    };
    return { deps, logs, spawns, killed, sentinelOps, child };
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
        // 嵌入式控制台契约（napuketto 0.2.0 env 覆盖）：单行记录 + 关 banner
        expect(call.options.env?.["NAPUKETTO_LOG_FORMAT"]).toBe("single-line");
        expect(call.options.env?.["NAPUKETTO_NO_BANNER"]).toBe("1");
        expect(call.options.env?.["KUROBRIDGE_NK_TEST_PASS"]).toBe("keep-me");
    });

    it("stdout/stderr 逐行捕获并按级别字样分流（[napuketto] 前缀；头行时间戳/级别已剥离）", async () => {
        const h = makeHarness();
        const handle = spawnNapuketto(SPEC, h.deps);
        h.child.stdout.write("19:00:00.000 INFO (kernel/1): kurobot adapter started\n");
        h.child.stdout.write("19:00:01.000 WARN (kernel/1): 请扫描二维码登录\n");
        h.child.stderr.write("19:00:02.000 ERROR (kernel/1): boom\n");
        h.child.stdout.write("█ ASCII QR 无级别字样（非缩进独立行）\n");
        h.child.stdout.end();
        h.child.stderr.end();
        await drain();
        const byLevel = (level: string) =>
            h.logs.filter((l) => l.level === level).map((l) => l.message);
        expect(byLevel("info").some((m) => m.includes("kurobot adapter started"))).toBe(true);
        expect(byLevel("warn").some((m) => m.includes("请扫描二维码登录"))).toBe(true);
        expect(byLevel("error").some((m) => m.includes("boom"))).toBe(true);
        expect(byLevel("info").some((m) => m.includes("ASCII QR"))).toBe(true);
        // 收尾：结束句柄等待的 stop（不产生孤儿计时器）
        const stopped = handle.stop();
        h.child.emitExit(0);
        await stopped;
    });

    it("FATAL 级别字样分流为 error（ADR-034：pino 有 fatal 级，不再并入 info）", async () => {
        const h = makeHarness();
        const handle = spawnNapuketto(SPEC, h.deps);
        h.child.stderr.write("20:00:00.000 FATAL (kernel/1): unrecoverable\n");
        h.child.stderr.end();
        await drain();
        const errors = h.logs.filter((l) => l.level === "error").map((l) => l.message);
        expect(errors.some((m) => m.includes("unrecoverable"))).toBe(true);
        expect(h.logs.some((l) => l.level === "info" && l.message.includes("unrecoverable"))).toBe(
            false,
        );
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

    it("stop()：写停止哨兵 + 等优雅 exit 0 → resolve 并清理哨兵；不树杀、不触发 onUnexpectedExit", async () => {
        const h = makeHarness();
        const handle = spawnNapuketto(SPEC, h.deps);
        const unexpected: UnexpectedExit[] = [];
        handle.onUnexpectedExit((info) => unexpected.push(info));

        const stopped = handle.stop();
        expect(h.sentinelOps).toEqual([{ op: "write", dataDir: SPEC.dataDir }]);
        expect(h.killed).toEqual([]);
        h.child.emitExit(0);
        await stopped;
        expect(unexpected).toEqual([]);
        expect(h.sentinelOps).toEqual([
            { op: "write", dataDir: SPEC.dataDir },
            { op: "remove", dataDir: SPEC.dataDir },
        ]);
        expect(
            h.logs.some((l) => l.level === "info" && l.message.includes("已优雅关停（exit 0）")),
        ).toBe(true);
    });

    it("stop() 哨兵超时 → warn 后回退树杀；树杀的机制性 code=1 不展示，措辞为树杀兜底", async () => {
        vi.useFakeTimers();
        const h = makeHarness({ stopTimeoutMs: 500 });
        const handle = spawnNapuketto(SPEC, h.deps);
        let resolved = false;
        void handle.stop().then(() => {
            resolved = true;
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(h.killed).toEqual([4242]);
        expect(h.logs.some((l) => l.level === "warn" && l.message.includes("优雅关停超时"))).toBe(
            true,
        );
        h.child.emitExit(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(resolved).toBe(true);
        expect(
            h.logs.some((l) => l.level === "info" && l.message.includes("已关停（树杀兜底）")),
        ).toBe(true);
        expect(h.logs.some((l) => l.message.includes("code=1"))).toBe(false);
    });

    it("stop() 树杀后进程仍不退出 → KILL_FALLBACK 定时兜底 resolve（关停链不挂死）", async () => {
        vi.useFakeTimers();
        const h = makeHarness({ stopTimeoutMs: 500 });
        const handle = spawnNapuketto(SPEC, h.deps);
        let resolved = false;
        void handle.stop().then(() => {
            resolved = true;
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(h.killed).toEqual([4242]);
        // 不 emitExit：树杀失效的极端场景
        await vi.advanceTimersByTimeAsync(3000);
        expect(resolved).toBe(true);
    });

    it("停止哨兵写入失败 → 立即回退树杀（不等优雅超时）", async () => {
        const h = makeHarness({
            stopSentinel: {
                write: () => {
                    throw new Error("EACCES");
                },
                remove: () => undefined,
            },
        });
        const handle = spawnNapuketto(SPEC, h.deps);
        const stopped = handle.stop();
        expect(h.killed).toEqual([4242]);
        h.child.emitExit(1);
        await stopped;
        expect(h.logs.some((l) => l.level === "warn" && l.message.includes("哨兵写入失败"))).toBe(
            true,
        );
        expect(h.logs.some((l) => l.level === "info" && l.message.includes("树杀兜底"))).toBe(true);
    });

    it("stop() 时子进程已退出 → 直接 resolve（不写哨兵）", async () => {
        const h = makeHarness();
        const handle = spawnNapuketto(SPEC, h.deps);
        h.child.emitExit(1);
        await handle.stop();
        expect(h.sentinelOps).toEqual([]);
        expect(h.killed).toEqual([]);
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

    it("关停路径 exit 不触发 onUnexpectedExit（哨兵与树杀兜底同此语义）", async () => {
        const h = makeHarness();
        const handle = spawnNapuketto(SPEC, h.deps);
        const unexpected: UnexpectedExit[] = [];
        handle.onUnexpectedExit((info) => unexpected.push(info));
        const stopped = handle.stop();
        h.child.emitExit(1);
        await stopped;
        expect(unexpected).toEqual([]);
    });
});

describe("pipeLines 记录重组与降噪（Paper 26.3 干跑台 latest.log 取证驱动）", () => {
    it("真机 ANSI 色码形态：去色后头行识别、账号保留、时间戳/级别/pid 剥离、字段并入单行", async () => {
        const h = makeHarness();
        const handle = spawnNapuketto(SPEC, h.deps);
        // 2026-10-25 cleanroom 实证形态：pipe 下 pino-pretty 仍带 ANSI，头行可带账号前缀
        h.child.stdout.write(
            "[3567141148] [18:03:30.355] \u001B[32mINFO\u001B[39m (26088): \u001B[36mQQ 文件来源\u001B[39m\n",
        );
        h.child.stdout.write('[3567141148]     \u001B[35mservice\u001B[39m: "cli"\n');
        h.child.stdout.write('[3567141148]     \u001B[35mqqVersion\u001B[39m: "9.9.33-52230"\n');
        h.child.stdout.end();
        await drain();
        const infos = h.logs.filter((l) => l.level === "info").map((l) => l.message);
        expect(
            infos.some((m) =>
                m.includes('[3567141148] QQ 文件来源 service: "cli" qqVersion: "9.9.33-52230"'),
            ),
        ).toBe(true);
        // 去色彻底：转发文本不再含 ANSI 转义；头行时间戳/级别/pid 不再重复出现
        expect(infos.some((m) => m.includes("\u001B"))).toBe(false);
        expect(infos.some((m) => m.includes("18:03:30"))).toBe(false);
        expect(infos.some((m) => m.includes("(26088)"))).toBe(false);
        const stopped = handle.stop();
        h.child.emitExit(0);
        await stopped;
    });

    it("pino-pretty 多行记录（头行+缩进字段行）重组为单行转发，续行不再各自成行", async () => {
        const h = makeHarness();
        const handle = spawnNapuketto(SPEC, h.deps);
        h.child.stdout.write("[16:00:46.712] INFO (16216): 启动账号\n");
        h.child.stdout.write('    service: "cli"\n');
        h.child.stdout.write('    qq: "3567141148"\n');
        h.child.stdout.write("    restartCount: 0\n");
        h.child.stdout.write(
            "[16:00:47.218] INFO (kernel/27256): wrapper 装配完成（engine + session）\n",
        );
        h.child.stdout.end();
        await drain();
        const infos = h.logs.filter((l) => l.level === "info").map((l) => l.message);
        expect(
            infos.some((m) =>
                m.includes('启动账号 service: "cli" qq: "3567141148" restartCount: 0'),
            ),
        ).toBe(true);
        expect(
            infos.filter((m) => m.includes('service: "cli"') && !m.includes("启动账号")),
        ).toHaveLength(0);
        expect(infos.some((m) => m.includes("wrapper 装配完成"))).toBe(true);
        const stopped = handle.stop();
        h.child.emitExit(0);
        await stopped;
    });

    it("onRecvSysMsg 校准数据（含 raw hex）整条降 debug，INFO 控制台不出现", async () => {
        const h = makeHarness();
        const handle = spawnNapuketto(SPEC, h.deps);
        h.child.stdout.write(
            "[02:01:55.294] INFO (loader/27256): ob11: onRecvSysMsg 校准数据（未识别，不广播）\n",
        );
        h.child.stdout.write('    verdict: "unknown"\n');
        h.child.stdout.write("    msgType: 528\n");
        h.child.stdout.write(
            '    raw: "0a40089c82f9a40d1218755f4b5345594a326c656a574b6f62627947703235536851"\n',
        );
        h.child.stdout.end();
        await drain();
        const debugs = h.logs.filter((l) => l.level === "debug").map((l) => l.message);
        const infos = h.logs.filter((l) => l.level === "info").map((l) => l.message);
        expect(debugs.some((m) => m.includes("校准数据"))).toBe(true);
        expect(infos.some((m) => m.includes("校准数据"))).toBe(false);
        expect(infos.some((m) => m.includes("0a40089c"))).toBe(false);
        const stopped = handle.stop();
        h.child.emitExit(0);
        await stopped;
    });

    it("接收行与 mmkv 透传行降 debug", async () => {
        const h = makeHarness();
        const handle = spawnNapuketto(SPEC, h.deps);
        h.child.stdout.write(
            "[16:03:37.609] INFO (loader/27256): loader | 接收 <- 群聊 [群967493177] [用户167155662]： 喵\n",
        );
        h.child.stdout.write(
            "[3567141148] :92::loadFromFile> loading [mmkv.default] with crc 3221441533 sequence 8 version 4\n",
        );
        h.child.stdout.end();
        await drain();
        expect(
            h.logs
                .filter((l) => l.level === "info")
                .some((l) => l.message.includes("接收 <- 群聊")),
        ).toBe(false);
        expect(
            h.logs
                .filter((l) => l.level === "info")
                .some((l) => l.message.includes("mmkv.default")),
        ).toBe(false);
        expect(h.logs.filter((l) => l.level === "debug").length).toBeGreaterThanOrEqual(2);
        const stopped = handle.stop();
        h.child.emitExit(0);
        await stopped;
    });

    it("超长记录截断并标注原长", async () => {
        const h = makeHarness();
        const handle = spawnNapuketto(SPEC, h.deps);
        const longHex = "ab".repeat(400);
        h.child.stdout.write("[02:01:55.294] WARN (loader/27256): hex dump 失败样本\n");
        h.child.stdout.write(`    raw: "${longHex}"\n`);
        h.child.stdout.end();
        await drain();
        const warns = h.logs.filter((l) => l.level === "warn").map((l) => l.message);
        expect(warns.some((m) => m.includes("（截断，原长 "))).toBe(true);
        expect(warns.every((m) => m.length < 500)).toBe(true);
        const stopped = handle.stop();
        h.child.emitExit(0);
        await stopped;
    });

    it("ASCII banner（含账号前缀重打）整段丢弃，每进程仅一条 debug 提示", async () => {
        const h = makeHarness();
        const handle = spawnNapuketto(SPEC, h.deps);
        for (const line of [
            "    _   __                  __        __  __        ____  ____ ",
            "   / | / /___ _____  __  __/ /_____  / /_/ /_____  / __ \\/ __ \\",
            "  /  |/ / __ `/ __ `/ __ \\/ / / / //_/ _ \\/ __/ __/ __ \\/ / / / / / /",
            " / /|  / /_/ / /_/ / /_/ / ,< /  __/ /_/ /_/ /_/ / /_/ / /_/ / ",
            "/_/ |_/__,_/ .___/__,_/_/|_|\\___/__/\\__/\\____/\\___\\_\\___\\_\\ ",
            "           /_/                                                 ",
            "[3567141148]     _   __                  __        __  __        ____  ____ ",
            "[3567141148]   / | / /___ _____  __  __/ /_____  / /_/ /_____  / __ \\/ __ \\",
            "[16:00:57.251] INFO (kernel/27256): loginService.initConfig OK",
        ]) {
            h.child.stdout.write(`${line}\n`);
        }
        h.child.stdout.end();
        await drain();
        const infos = h.logs.filter((l) => l.level === "info").map((l) => l.message);
        expect(infos.some((m) => m.includes("loginService.initConfig"))).toBe(true);
        expect(infos.some((m) => m.includes("____"))).toBe(false);
        const bannerDebugs = h.logs.filter(
            (l) => l.level === "debug" && l.message.includes("banner 已折叠"),
        );
        expect(bannerDebugs).toHaveLength(1);
        const stopped = handle.stop();
        h.child.emitExit(0);
        await stopped;
    });

    it("napuketto 0.2.0 single-line 形态：单行单条、时间戳/级别/name-pid 剥离、account 内联、close 冲刷末条", async () => {
        const h = makeHarness();
        const handle = spawnNapuketto(SPEC, h.deps);
        // 0.2.0 非单行禁用时的输出形态：[时间] LEVEL (name/pid): 消息 k=v（无 ANSI、无多行展开）
        h.child.stdout.write(
            "[16:00:46.712] INFO (cli/26088): 启动账号 service=cli account=3567141148\n",
        );
        h.child.stdout.write(
            "[16:00:47.100] WARN (kernel/27256): 请扫描二维码登录（保存: C:\\cache\\qrcode.png | URL: https://txz.qq.com/p?k=abc）\n",
        );
        // 末条无后续头行，只能靠流 close 冲刷转发
        h.child.stdout.write("[16:03:37.609] ERROR (loader/27256): ob11 推送失败 retry=1\n");
        h.child.stdout.end();
        await drain();
        const infos = h.logs.filter((l) => l.level === "info").map((l) => l.message);
        const warns = h.logs.filter((l) => l.level === "warn").map((l) => l.message);
        const errors = h.logs.filter((l) => l.level === "error").map((l) => l.message);
        expect(infos.some((m) => m.includes("启动账号 service=cli account=3567141148"))).toBe(true);
        expect(warns.some((m) => m.includes("请扫描二维码登录"))).toBe(true);
        expect(errors.some((m) => m.includes("ob11 推送失败 retry=1"))).toBe(true);
        // 头行元数据不重复出现
        expect(infos.some((m) => m.includes("16:00:46"))).toBe(false);
        expect(infos.some((m) => m.includes("(cli/26088)"))).toBe(false);
        const stopped = handle.stop();
        h.child.emitExit(0);
        await stopped;
    });
});

describe("isBannerArtLine", () => {
    it("Spring 风格 banner 画行（可带账号前缀）→ true", () => {
        expect(
            isBannerArtLine("    _   __                  __        __  __        ____  ____ "),
        ).toBe(true);
        expect(
            isBannerArtLine("   / | / /___ _____  __  __/ /_____  / /_/ /_____  / __ \\/ __ \\"),
        ).toBe(true);
        expect(
            isBannerArtLine(
                "[3567141148]           /_/                                                 ",
            ),
        ).toBe(true);
    });

    it("正常日志行不误伤：字段行 / hex / 二维码残骸 / 短行", () => {
        expect(isBannerArtLine('    service: "cli"')).toBe(false);
        expect(isBannerArtLine('    raw: "0a40089c82f9a40d1218"')).toBe(false);
        expect(isBannerArtLine("    ]")).toBe(false);
        expect(
            isBannerArtLine("[16:00:57.251] INFO (kernel/27256): loginService.initConfig OK"),
        ).toBe(false);
    });
});
