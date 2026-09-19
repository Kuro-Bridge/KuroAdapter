/**
 * stderr 日志实现契约（ADR-034 行格式，对齐 bridge/embedded）：
 * 行格式 `[KuroBridge][node][level] message`（level 小写），单次 write 一整行含尾随 \n；
 * error 带异常时 message 后拼 ": <String(error)>"。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStderrLogger } from "./logger.js";

const writes: string[] = [];

afterEach(() => {
    vi.restoreAllMocks();
    writes.length = 0;
});

function stubStderr(): void {
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
    }) as typeof process.stderr.write);
}

describe("createStderrLogger：行格式契约", () => {
    it("info：`[KuroBridge][node][info] message`，单次 write 一整行（含尾随 \\n）", () => {
        stubStderr();
        createStderrLogger().info("游戏通道已鉴权");
        expect(writes).toEqual(["[KuroBridge][node][info] 游戏通道已鉴权\n"]);
    });

    it("debug / warn 同格式（level 小写）", () => {
        stubStderr();
        const logger = createStderrLogger();
        logger.debug("dbg");
        logger.warn("wrn");
        expect(writes).toEqual([
            "[KuroBridge][node][debug] dbg\n",
            "[KuroBridge][node][warn] wrn\n",
        ]);
    });

    it("error 不带异常：纯 message", () => {
        stubStderr();
        createStderrLogger().error("绑定失败");
        expect(writes).toEqual(["[KuroBridge][node][error] 绑定失败\n"]);
    });

    it("error 带异常：message 后拼 `: <String(error)>`", () => {
        stubStderr();
        createStderrLogger().error("转发平台消息失败", new Error("ipc closed"));
        expect(writes).toEqual(["[KuroBridge][node][error] 转发平台消息失败: Error: ipc closed\n"]);
    });
});
