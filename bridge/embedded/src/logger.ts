/**
 * stderr 日志实现（引导层专用）——Node 侧行格式契约的唯一 writer（ADR-034）。
 *
 * 行格式契约：`[KuroBridge][node][LEVEL] message`，LEVEL ∈ {debug, info, warn, error}（小写），
 * 单次 write 一整行（含尾随 \n）。index.ts 等引导代码一律经本模块（logger 实例）写日志，
 * 不得自建 stderr writer（历史教训：双 writer 字节级重复后漂移）。
 * Java 侧对应的级别解析单一解析点 = :core 的 IpcLogLevels（ADR-034 契约表）。
 *
 * 硬约束：IPC 帧走 stdout（JSON-lines），一切日志只进 stderr——
 * stdout 混入非 JSON 内容会被 Java 侧当坏行丢弃（虽然不崩，但日志会丢）。
 * console.error 被 biome 禁用（noConsole 仅放行 log），故直接写 stderr。
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
