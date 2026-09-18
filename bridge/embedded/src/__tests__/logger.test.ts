/** logger.ts 行格式契约单测（ADR-034）：唯一 stderr writer 的字节级输出断言 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStderrLogger } from "../logger.ts";

/** 拦截 process.stderr.write 收集输出（每次 it 重建，避免跨用例串写） */
let writes: string[];

beforeEach(() => {
    writes = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("createStderrLogger 行格式契约（ADR-034）", () => {
    it("四级各产出精确一行：[KuroBridge][node][LEVEL] message\\n（单次 write）", () => {
        const logger = createStderrLogger();
        logger.debug("dbg");
        logger.info("hello");
        logger.warn("careful");
        logger.error("boom");
        expect(writes).toEqual([
            "[KuroBridge][node][debug] dbg\n",
            "[KuroBridge][node][info] hello\n",
            "[KuroBridge][node][warn] careful\n",
            "[KuroBridge][node][error] boom\n",
        ]);
    });

    it("error 携带 error 时追加 `: ` + String(error)；不携带则原样（不产生尾冒号）", () => {
        const logger = createStderrLogger();
        logger.error("失败", new Error("ENOENT"));
        logger.error("仅消息");
        logger.error("非 Error 值", 42);
        expect(writes).toEqual([
            "[KuroBridge][node][error] 失败: Error: ENOENT\n",
            "[KuroBridge][node][error] 仅消息\n",
            "[KuroBridge][node][error] 非 Error 值: 42\n",
        ]);
    });

    it("多字节内容（中文/换行外的空白）逐字节透传，级别段恒为小写字面量", () => {
        const logger = createStderrLogger();
        logger.info("中文消息 with spaces");
        expect(writes).toEqual(["[KuroBridge][node][info] 中文消息 with spaces\n"]);
    });
});
