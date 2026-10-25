/**
 * FileConfigStore 读写契约（对齐 bridge/embedded/config-store 策略；ADR-040 起 JSONC 化）：
 * - 路径优先 <serverRoot>/plugins/kurobridge/config.jsonc；旧版 config.json 回退读取
 *   （不迁移不重命名）；两文件都缺 → 生成带注释 JSONC 模板（含随机 token）。
 * - 合法文件 → parseJsonc + parseConfig 通路（去重保序 / 缺省字段补齐）。
 * - 非法 JSONC / 非法形状 → load 以 ConfigError 拒绝（分层：调用方 catch 后降级空绑定，
 *   runtime/index.ts 已如此编排；本测试断言该分层边界），且不覆盖盘上文件。
 * - watch 返回可调用函数（no-op 订阅：lse 无配置重载触发点，裁决册 §4.3 差异项）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, defaultConfig, type Logger, parseJsonc } from "@kuro-bridge/bridge-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileConfigStore } from "./config-store.js";

let serverRoot = "";

const logger: Logger = {
    debug: vi.fn((_message: string) => undefined),
    info: vi.fn((_message: string) => undefined),
    warn: vi.fn((_message: string) => undefined),
    error: vi.fn((_message: string, _error?: unknown) => undefined),
};

function configPath(): string {
    return join(serverRoot, "plugins", "kurobridge", "config.jsonc");
}

function legacyConfigPath(): string {
    return join(serverRoot, "plugins", "kurobridge", "config.json");
}

function makeStore(): FileConfigStore {
    return new FileConfigStore({ logger, serverRoot });
}

beforeEach(async () => {
    serverRoot = await mkdtemp(join(tmpdir(), "kurobridge-config-"));
});

afterEach(async () => {
    await rm(serverRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe("缺失 → 生成默认并返回 defaultConfig（'wx' 落盘语义）", () => {
    it("load 返回默认配置（含随机 token），盘上出现带注释 JSONC 模板（含父目录递归创建）", async () => {
        const loaded = await makeStore().load();
        const text = await readFile(configPath(), "utf8");
        expect(parseJsonc(text)).toEqual(loaded);
        expect(loaded).toEqual(defaultConfig(loaded.token));
        expect(loaded.token).toMatch(/^[0-9a-f]{32}$/); // 首启随机 token（ADR-040，对齐 embedded/Pure）
        expect(text).toContain("KuroBridge 配置文件"); // 注释即文档（模板头）
        expect(text.endsWith("\n")).toBe(true);
        expect(
            vi
                .mocked(logger.info)
                .mock.calls.some(([text]) => String(text).includes("生成默认配置")),
        ).toBe(true);
    });

    it("仅有旧版 config.json → 回退读取（JSON 超集），不生成 jsonc、不迁移", async () => {
        await mkdir(join(serverRoot, "plugins", "kurobridge"), { recursive: true });
        await writeFile(legacyConfigPath(), '{"channels":["114514"],"token":"legacy"}', "utf8");
        const loaded = await makeStore().load();
        expect(loaded.channels).toEqual(["114514"]);
        expect(loaded.token).toBe("legacy");
        await expect(readFile(configPath(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect(
            vi
                .mocked(logger.info)
                .mock.calls.some(([text]) => String(text).includes("旧版 config.json")),
        ).toBe(true);
    });

    it("已存在的服主文件不被默认生成覆盖（读通路优先，'wx' 只用于缺失竞态）", async () => {
        await mkdir(join(serverRoot, "plugins", "kurobridge"), { recursive: true });
        await writeFile(configPath(), '{"channels":["114514"]}', "utf8");
        const loaded = await makeStore().load();
        expect(loaded.channels).toEqual(["114514"]);
        expect(await readFile(configPath(), "utf8")).toBe('{"channels":["114514"]}');
    });
});

describe("合法文件 → parseConfig 通路", () => {
    it("形状完整：channels/admins 归一（去重保序）、token/runtime 透传", async () => {
        await mkdir(join(serverRoot, "plugins", "kurobridge"), { recursive: true });
        await writeFile(
            configPath(),
            JSON.stringify({
                channels: ["114514", "114514", "1919810"],
                token: "s3cret",
                admins: [{ channel: "114514", users: ["u1", "u1", "u2"] }],
                runtime: { autoRestart: false },
                ws: { host: "127.0.0.1", port: 21000 },
            }),
            "utf8",
        );
        const loaded = await makeStore().load();
        expect(loaded).toEqual({
            channels: ["114514", "1919810"],
            token: "s3cret",
            admins: [{ channel: "114514", users: ["u1", "u2"] }],
            runtime: { autoRestart: false },
            ws: { host: "127.0.0.1", port: 21000 },
        });
    });

    it("旧配置缺新字段：按缺省补齐（向后兼容，token 默认空串 / runtime 默认 true）", async () => {
        await mkdir(join(serverRoot, "plugins", "kurobridge"), { recursive: true });
        await writeFile(configPath(), '{"channels":["c"]}', "utf8");
        const loaded = await makeStore().load();
        expect(loaded.token).toBe("");
        expect(loaded.runtime).toEqual({ autoRestart: true });
        expect(loaded.admins).toEqual([]);
    });
});

describe("非法配置 → ConfigError 拒绝（上层降级分层），盘上文件不动", () => {
    it("非法 JSON：reject ConfigError（文案含「不是合法 JSON」）", async () => {
        await mkdir(join(serverRoot, "plugins", "kurobridge"), { recursive: true });
        await writeFile(configPath(), "{nope", "utf8");
        await expect(makeStore().load()).rejects.toThrow(ConfigError);
        await expect(makeStore().load()).rejects.toThrow("不是合法 JSONC");
    });

    it("非法形状（channels 非数组）：reject ConfigError（来自 parseConfig）", async () => {
        await mkdir(join(serverRoot, "plugins", "kurobridge"), { recursive: true });
        await writeFile(configPath(), '{"channels":"114514"}', "utf8");
        await expect(makeStore().load()).rejects.toThrow(ConfigError);
    });

    it("拒绝路径不改动盘上文件（降级由上层编排，缺省配置不落盘）", async () => {
        await mkdir(join(serverRoot, "plugins", "kurobridge"), { recursive: true });
        await writeFile(configPath(), "{nope", "utf8");
        const store = makeStore();
        await expect(store.load()).rejects.toBeInstanceOf(ConfigError);
        expect(await readFile(configPath(), "utf8")).toBe("{nope");
    });
});

describe("watch：no-op 订阅", () => {
    it("返回函数可调用（取消订阅 no-op），并记录 debug 说明", async () => {
        const unsubscribe = makeStore().watch(() => undefined);
        expect(typeof unsubscribe).toBe("function");
        expect(() => {
            unsubscribe();
        }).not.toThrow();
        expect(
            vi
                .mocked(logger.debug)
                .mock.calls.some(([text]) => String(text).includes("不做配置文件轮询")),
        ).toBe(true);
    });
});
