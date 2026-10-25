/**
 * NodeConfigStore 单测（ADR-040）：JSONC 解析、随机 token 首启生成、旧版 config.json
 * 回退读取、非法文件 ConfigError、watch 轮询命中实际加载文件。临时目录，不发真轮询长跑。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig, type KurobridgeConfig } from "@kuro-bridge/bridge-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeConfigStore } from "../config-store.ts";

const dirs: string[] = [];

afterEach(async () => {
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

async function makeRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "kurobridge-config-"));
    dirs.push(dir);
    return dir;
}

const noopLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

const CONFIG_JSONC = join("plugins", "kurobridge", "config.jsonc");
const CONFIG_JSON = join("plugins", "kurobridge", "config.json");

describe("NodeConfigStore（ADR-040）", () => {
    it("两文件都缺 → 生成带注释 JSONC 模板（含 32 位随机 token），返回配置与文件一致", async () => {
        const root = await makeRoot();
        const store = new NodeConfigStore({
            logger: noopLogger,
            serverRoot: root,
            pollIntervalMs: 0,
        });
        const config = await store.load();
        const text = await readFile(join(root, CONFIG_JSONC), "utf8");
        expect(text).toContain("KuroBridge 配置文件");
        expect(text).toContain('// "ws"');
        const tokenMatch = /"token": "([0-9a-f]{32})"/.exec(text);
        expect(tokenMatch).not.toBeNull();
        expect(config.token).toBe(tokenMatch?.[1]);
        expect(config).toEqual(defaultConfig(config.token));
        // 旧文件不误生成
        await expect(readFile(join(root, CONFIG_JSON), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("config.jsonc 已存在（含注释/行尾逗号/BOM）→ 正常解析", async () => {
        const root = await makeRoot();
        await mkdir(join(root, "plugins", "kurobridge"), { recursive: true });
        await writeFile(
            join(root, CONFIG_JSONC),
            `﻿// 手写配置\n{\n  "channels": ["10001",], // 绑定\n  "token": "",\n}\n`,
            "utf8",
        );
        const store = new NodeConfigStore({
            logger: noopLogger,
            serverRoot: root,
            pollIntervalMs: 0,
        });
        const config = await store.load();
        expect(config.channels).toEqual(["10001"]);
        expect(config.token).toBe("");
    });

    it("仅有旧版 config.json → 回退读取（JSON 超集），不生成 jsonc、不迁移", async () => {
        const root = await makeRoot();
        await mkdir(join(root, "plugins", "kurobridge"), { recursive: true });
        await writeFile(
            join(root, CONFIG_JSON),
            JSON.stringify({ channels: ["20002"], token: "legacy" }, null, 4),
            "utf8",
        );
        const store = new NodeConfigStore({
            logger: noopLogger,
            serverRoot: root,
            pollIntervalMs: 0,
        });
        const config = await store.load();
        expect(config.channels).toEqual(["20002"]);
        expect(config.token).toBe("legacy");
        await expect(readFile(join(root, CONFIG_JSONC), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("非法 JSONC → ConfigError（报错含路径与 JSONC 字样）", async () => {
        const root = await makeRoot();
        await mkdir(join(root, "plugins", "kurobridge"), { recursive: true });
        await writeFile(join(root, CONFIG_JSONC), "{ channels: 未加引号 }", "utf8");
        const store = new NodeConfigStore({
            logger: noopLogger,
            serverRoot: root,
            pollIntervalMs: 0,
        });
        await expect(store.load()).rejects.toThrow("配置不是合法 JSONC");
    });

    it("watch 轮询命中 load 时实际加载的文件（旧 json 回退后仍监听旧文件）", async () => {
        const root = await makeRoot();
        await mkdir(join(root, "plugins", "kurobridge"), { recursive: true });
        await writeFile(
            join(root, CONFIG_JSON),
            JSON.stringify({ channels: ["30003"] }, null, 4),
            "utf8",
        );
        const store = new NodeConfigStore({
            logger: noopLogger,
            serverRoot: root,
            pollIntervalMs: 10,
        });
        await store.load();
        const changes: KurobridgeConfig[] = [];
        const unwatch = store.watch((config) => changes.push(config));
        await writeFile(
            join(root, CONFIG_JSON),
            JSON.stringify({ channels: ["30003", "40004"] }, null, 4),
            "utf8",
        );
        await vi.waitFor(() => expect(changes).toHaveLength(1), { timeout: 2000 });
        unwatch();
        expect(changes[0]?.channels).toEqual(["30003", "40004"]);
    });
});
