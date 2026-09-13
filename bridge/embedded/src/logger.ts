/**
 * stderr 日志实现（引导层专用）。
 *
 * 硬约束：IPC 帧走 stdout（JSON-lines），一切日志只进 stderr——
 * stdout 混入非 JSON 内容会被 Java 侧当坏行丢弃（虽然不崩，但日志会丢）。
 * console.error 被 biome 禁用（noConsole 仅放行 log），故直接写 stderr。
 */
import type { Logger } from "@kurobot/bridge-core";

function write(level: string, message: string): void {
    process.stderr.write(`[KuroBot][node][${level}] ${message}\n`);
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
