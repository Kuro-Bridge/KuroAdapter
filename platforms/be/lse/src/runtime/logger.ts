/**
 * stderr 日志实现（lse node shim 专用）——行格式契约与 bridge/embedded 一致（ADR-034）：
 * `[KuroBridge][node][LEVEL] message`，LEVEL ∈ {debug, info, warn, error}（小写），
 * 单次 write 一整行（含尾随 \n）。index.ts 等引导代码一律经本模块写日志，
 * 不得自建 stderr writer；宿主侧按行前缀分级采集。
 */
import type { Logger } from "@kuro-bridge/bridge-core";

function write(level: string, message: string): void {
    process.stderr.write(`[KuroBridge][node][${level}] ${message}\n`);
}

export function createStderrLogger(): Logger {
    return {
        debug: (message) => {
            write("debug", message);
        },
        info: (message) => {
            write("info", message);
        },
        warn: (message) => {
            write("warn", message);
        },
        error: (message, error) => {
            write("error", error === undefined ? message : `${message}: ${String(error)}`);
        },
    };
}
