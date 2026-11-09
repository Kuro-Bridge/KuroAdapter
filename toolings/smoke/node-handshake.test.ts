/**
 * toolings/smoke/node-handshake 的纯函数单测。
 *
 * 只测「不需要真机」的部分：平台键映射（Darwin 曾被 contains("win") 误判成 Windows，
 * 这条断言是那个 bug 的回归锁）、帧解析与日志尾部截取。真机闭环本身由 CI 矩阵跑
 * （pnpm smoke:handshake），不塞进 vitest——否则 Linux 二进制在 Windows 开发机上必失败。
 */

import { describe, expect, it } from "vitest";

import { hostTargetFor, parseFrame, tailLines } from "./node-handshake.ts";

describe("hostTargetFor（宿主平台键）", () => {
    it("Windows 与 Linux 的 x64 / arm64 映射成 embed 目标键", () => {
        expect(hostTargetFor("win32", "x64")).toBe("win-x64");
        expect(hostTargetFor("win32", "arm64")).toBe("win-arm64");
        expect(hostTargetFor("linux", "x64")).toBe("linux-x64");
        expect(hostTargetFor("linux", "arm64")).toBe("linux-arm64");
    });

    it("Darwin 不是 Windows（回归锁：字符串包含 win 的误判）", () => {
        expect(hostTargetFor("darwin", "x64")).toBeNull();
        expect(hostTargetFor("darwin", "arm64")).toBeNull();
    });

    it("陌生系统 / 架构返回 null（由调用方给出明确失败）", () => {
        expect(hostTargetFor("freebsd", "x64")).toBeNull();
        expect(hostTargetFor("linux", "ia32")).toBeNull();
        expect(hostTargetFor("", "")).toBeNull();
    });
});

describe("parseFrame（IPC / WS 帧解析）", () => {
    it("解析 header.type 与 body", () => {
        const frame = parseFrame('{"header":{"type":"ready","id":"a"},"body":{"wsPort":25580}}');
        expect(frame?.header.type).toBe("ready");
        expect(frame?.body["wsPort"]).toBe(25580);
    });

    it("非 JSON / 缺 header / 缺 type 一律返回 null（不抛错）", () => {
        expect(parseFrame("not json")).toBeNull();
        expect(parseFrame("")).toBeNull();
        expect(parseFrame("   ")).toBeNull();
        expect(parseFrame("[]")).toBeNull();
        expect(parseFrame('{"body":{"wsPort":1}}')).toBeNull();
        expect(parseFrame('{"header":{"id":"a"}}')).toBeNull();
    });

    it("body 缺失时补空对象（ready 之外的帧可能不带 body）", () => {
        expect(parseFrame('{"header":{"type":"pong"}}')?.body).toEqual({});
    });
});

describe("tailLines（失败诊断输出）", () => {
    it("只保留尾部 N 行；不足 N 行时全给", () => {
        expect(tailLines(["a", "b", "c"], 2)).toBe("b\nc");
        expect(tailLines(["a"], 5)).toBe("a");
        expect(tailLines([], 5)).toBe("");
    });
});
