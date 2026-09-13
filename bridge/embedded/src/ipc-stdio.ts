/**
 * stdin/stdout IPC 通道：实现 bridge/core 的 IpcChannel 接口（ADR-010）。
 *
 * - stdout 只写 JSON-lines 帧（每帧一次 write，单行原子性足够）。
 * - stdin 逐行读取；关闭（EOF / Java 关 stdin）触发 onClose —— 这是
 *   Node 侧最可靠的关机信号（决策 D-08）。
 * - onMessage / onClose 支持多次注册（Relay 与引导层各自订阅）。
 */

import { createInterface } from "node:readline";
import type { IpcChannel } from "@kurobot/bridge-core";

export class StdioIpcChannel implements IpcChannel {
    private readonly readline = createInterface({ input: process.stdin });
    private readonly messageHandlers: ((text: string) => void)[] = [];
    private readonly closeHandlers: (() => void)[] = [];
    private open = true;

    get isOpen(): boolean {
        return this.open;
    }

    constructor() {
        this.readline.on("line", (line) => {
            const text = line.trim();
            if (text.length > 0) {
                for (const handler of this.messageHandlers) {
                    handler(text);
                }
            }
        });
        this.readline.on("close", () => {
            this.open = false;
            for (const handler of this.closeHandlers) {
                handler();
            }
        });
    }

    send(text: string): void {
        process.stdout.write(`${text}\n`);
    }

    onMessage(handler: (text: string) => void): void {
        this.messageHandlers.push(handler);
    }

    onClose(handler: () => void): void {
        this.closeHandlers.push(handler);
    }
}
