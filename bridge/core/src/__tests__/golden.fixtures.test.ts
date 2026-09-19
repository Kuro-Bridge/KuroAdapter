/**
 * 金样本 fixture-driven 机器检查（ADR-036：双层、单文件、单一入口）。
 *
 * 层 1 契约（16 份全量）：消费 npm 包 `@kuro-bridge/protocol` 发布件包内
 * fixtures/v<主.次> 金样本（fixtures 不经 exports 暴露，文件读取是既定消费方式）——
 * 包根经 createRequire 上溯定位（对齐 koishi 对端同款写法）；版本目录轴 ≡
 * PROTOCOL_VERSION 的 major.minor 且 fixtures 根下唯一版本目录；SHA256SUMS 双向完整性
 * （行格式严格两空格、逐行实算比对、盘上未登记文件必须为空）；逐份通过包导出的
 * validateFixture（不重复实现 schema，ADR-002 选 C）。
 *
 * 层 2 行为（动态发现）：expect.behavior 可观测（reply / close 任一非 null）的样本用
 * KurobridgeServer + test-fakes 回放（对齐 KuroAdapter-Pure FixtureConformanceTest 深度）：
 * reply 帧与金样本 JSON 全等、close code/reason 精确一致，无回执 / 不关闭作反向断言；
 * 覆盖数下限 7 = Pure 现状地板。上游金样本或本仓实现漂移，此处立即红。
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { PROTOCOL_VERSION, validateFixture } from "@kuro-bridge/protocol";
import { describe, expect, it } from "vitest";

import { KurobridgeServer } from "../server.ts";
import { FakeWsConnection, FakeWsServer, makeContext } from "../test-fakes.ts";

// 包根定位：require.resolve 走 exports 的 require 条件 → <包根>/dist/index.cjs，
// 从入口文件路径上溯两级（index.cjs → dist → 包根）。
const entryPath = createRequire(import.meta.url).resolve("@kuro-bridge/protocol");
const packageRoot = resolve(entryPath, "../..");
const fixturesRoot = join(packageRoot, "fixtures");
// 版本目录 = v<major.minor>（协议版本轴以 major.minor 对齐，patch 共目录）。
const versionDir = `v${PROTOCOL_VERSION.split(".").slice(0, 2).join(".")}`;
const fixturesDir = join(fixturesRoot, versionDir);

/** SHA256SUMS 行格式："<64 位小写 hex>  <相对路径>"（严格两个空格） */
const SUMS_LINE = /^([0-9a-f]{64}) {2}(.+)$/;
/** behavior.reply 引用格式：frames[N] */
const REPLY_REF = /^frames\[(\d+)\]$/;

/** 金样本 JSON 的最小结构视图（schema 语义已由包导出的 validateFixture 保证，不重复校验） */
interface GoldenFrameEntry {
    dir: string;
    frame: { header: { type: string }; body: unknown };
}

interface GoldenFixture {
    frames: GoldenFrameEntry[];
    expect: {
        behavior?: { reply?: string | null; close?: { code: number; reason: string } | null };
    };
}

/** 递归枚举目录下全部文件（返回相对 dir 的 POSIX 风格路径）。 */
function listFilesRel(dir: string, rel = ""): string[] {
    const files: string[] = [];
    const entries = readdirSync(rel === "" ? dir : join(dir, rel), { withFileTypes: true });
    for (const entry of entries) {
        const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
            files.push(...listFilesRel(dir, relPath));
        } else {
            files.push(relPath);
        }
    }
    return files;
}

function readFixture(rel: string): GoldenFixture {
    return JSON.parse(readFileSync(join(fixturesDir, rel), "utf8")) as GoldenFixture;
}

const allJsonRel = listFilesRel(fixturesDir)
    .filter((rel) => rel.endsWith(".json"))
    .sort();

/** 行为层可观测：expect.behavior.reply 或 expect.behavior.close 任一非 null 才回放 */
function isObservable(fixture: GoldenFixture): boolean {
    const behavior = fixture.expect.behavior;
    if (behavior === undefined) {
        return false;
    }
    const reply = behavior.reply ?? null;
    const close = behavior.close ?? null;
    return reply !== null || close !== null;
}

const observableRel = allJsonRel.filter((rel) => isObservable(readFixture(rel)));

describe("包内金样本契约（ADR-036 层 1：版本轴 / SUMS 双向 / validateFixture 全量）", () => {
    it("版本目录对齐：fixtures 根下唯一版本目录 ≡ PROTOCOL_VERSION 的 major.minor", () => {
        expect(basename(fixturesDir)).toBe(versionDir);
        const dirs = readdirSync(fixturesRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        expect(dirs, `fixtures 根下应只有当前版本目录 ${versionDir}`).toEqual([versionDir]);
    });

    it("SHA256SUMS 双向完整性：16 行无空行、逐条实算匹配、盘上文件全部被列出", () => {
        const sumsRel = "SHA256SUMS";
        const lines = readFileSync(join(fixturesDir, sumsRel), "utf8").split(/\r?\n/);
        if (lines[lines.length - 1] === "") {
            lines.pop(); // 文件以换行结尾的正常情形
        }
        expect(lines, "SHA256SUMS 不应含空行").not.toContain("");
        expect(lines.length, "SHA256SUMS 应恰好登记 16 份金样本").toBe(16);
        const listed = new Set<string>();
        for (const line of lines) {
            const match = SUMS_LINE.exec(line);
            if (match === null) {
                throw new Error(`SHA256SUMS 行格式异常（应为 "<hex>  <相对路径>"）：${line}`);
            }
            const hex = match[1];
            const relPath = match[2];
            if (hex === undefined || relPath === undefined) {
                throw new Error(`SHA256SUMS 行格式异常（应为 "<hex>  <相对路径>"）：${line}`);
            }
            const abs = join(fixturesDir, relPath);
            expect(existsSync(abs), `SHA256SUMS 列出但盘上缺失：${relPath}`).toBe(true);
            const actual = createHash("sha256").update(readFileSync(abs)).digest("hex");
            expect(actual, `SHA256 实算不匹配（内容被改动或拷贝失真）：${relPath}`).toBe(hex);
            listed.add(relPath);
        }
        const unlisted = listFilesRel(fixturesDir).filter(
            (rel) => rel !== sumsRel && !listed.has(rel),
        );
        expect(unlisted, `盘上存在但未被 SHA256SUMS 列出：${unlisted.join("、")}`).toEqual([]);
    });

    it("全量夹具逐个通过包导出的 validateFixture（≥16 份）", () => {
        expect(
            allJsonRel.length,
            "金样本 JSON 总数不应少于发布件声称的 16 份",
        ).toBeGreaterThanOrEqual(16);
        for (const rel of allJsonRel) {
            const result = validateFixture(readFixture(rel));
            if (!result.ok) {
                throw new Error(`金样本 ${rel} 未通过契约校验：${result.issues.join("；")}`);
            }
            expect(result.ok).toBe(true);
        }
    });
});

// 行为层统一服务端配置（对齐 Pure SessionContext："srv-1"/"0.1.0"/token 鉴权/绑定快照）
const CHANNELS = ["114514", "1919810"];
const AUTH_TOKEN = "s3cret";
/** command 请求桩的输出行（对齐 Pure 的 hooks.setCommandHandler 桩：command-roundtrip 期望回执） */
const COMMAND_OUTPUT = "There are 1 whitelisted player(s): Steve";

function makeBehaviorServer(): FakeWsServer {
    const ws = new FakeWsServer();
    const server = new KurobridgeServer({
        context: makeContext({ token: AUTH_TOKEN }),
        wsServer: ws,
        channelBindings: () => CHANNELS,
    });
    server.onCommand(async () => ({ ok: true, output: [COMMAND_OUTPUT] }));
    return ws;
}

/** 内联握手 hello（token 与行为层服务端配置匹配，protocolVersion 取包实际版本） */
function inlineHelloText(): string {
    return JSON.stringify({
        header: { type: "hello", id: "123e4567-e89b-12d3-a456-426614174000" },
        body: {
            peerId: "golden-harness",
            platform: "stub",
            version: "0.0.1",
            protocolVersion: PROTOCOL_VERSION,
            token: AUTH_TOKEN,
        },
    });
}

/** command_result 经 promise 链异步回执：与 server.test.ts 同款，两拍微任务冲刷 */
async function drainMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function replyFrameIndex(ref: string): number {
    const match = REPLY_REF.exec(ref);
    if (match === null || match[1] === undefined) {
        throw new Error(`behavior.reply 引用格式异常（应为 "frames[N]"）：${ref}`);
    }
    return Number.parseInt(match[1], 10);
}

/** 单份可观测金样本回放：按序喂 peer->server 帧，断言 reply 全等与 close 精确一致 */
async function replayFixture(rel: string): Promise<void> {
    const fixture = readFixture(rel);
    const behavior = fixture.expect.behavior;
    if (behavior === undefined) {
        throw new Error(`金样本 ${rel} 缺少 expect.behavior，不可回放`);
    }
    const first = fixture.frames[0];
    if (first === undefined) {
        throw new Error(`金样本 ${rel} 无任何帧，不可回放`);
    }
    const ws = makeBehaviorServer();
    const conn = new FakeWsConnection();
    ws.accept(conn);
    // 非 hello 样本先内联握手到 established（hello 样本直接新鲜连接喂帧），握手回执不参与断言
    if (first.frame.header.type !== "hello") {
        conn.receive(inlineHelloText());
        conn.sent.length = 0;
    }
    for (const entry of fixture.frames) {
        if (entry.dir === "peer->server") {
            conn.receive(JSON.stringify(entry.frame));
            await drainMicrotasks();
        }
    }

    const reply = behavior.reply ?? null;
    const close = behavior.close ?? null;
    if (reply !== null) {
        const expected = fixture.frames[replyFrameIndex(reply)];
        if (expected === undefined) {
            throw new Error(
                `behavior.reply 越界：${reply}（${rel} 共 ${fixture.frames.length} 帧）`,
            );
        }
        const actualText = conn.sent[0] ?? "";
        expect(actualText, `金样本 ${rel} 期望回执 ${reply}，但连接未出帧`).not.toBe("");
        expect(JSON.parse(actualText), `金样本 ${rel}：${reply} 应与实现产物 JSON 全等`).toEqual(
            expected.frame,
        );
    } else {
        expect(conn.sent, `金样本 ${rel} 不应有任何回执`).toHaveLength(0);
    }
    if (close !== null) {
        expect(conn.closed?.code, `金样本 ${rel}：close code 应精确一致`).toBe(close.code);
        expect(conn.closed?.reason, `金样本 ${rel}：close reason 应精确一致`).toBe(close.reason);
    } else {
        expect(conn.closed, `金样本 ${rel} 不应关闭连接`).toBeNull();
    }
}

describe("包内金样本行为回放（ADR-036 层 2：KurobridgeServer 对齐 Pure 深度）", () => {
    it("动态发现：expect.behavior 可观测样本 ≥ 7（Pure 现状地板，防覆盖静默缩水）", () => {
        expect(
            observableRel.length,
            `可观测样本应 ≥ 7，实际 ${observableRel.length}：${observableRel.join("、")}`,
        ).toBeGreaterThanOrEqual(7);
    });

    it.each(observableRel)(
        "%s：reply 帧与金样本 JSON 全等 / close code+reason 精确一致",
        async (rel) => {
            await replayFixture(rel);
        },
    );
});
