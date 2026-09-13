/**
 * core 的 Clock / TimerScheduler Node 实现（「唯一的 Node API 落点」之一，
 * 与 ws-server.ts / ipc-stdio.ts 同层，ADR-007）。
 *
 * 定时器一律 unref：core 的超时检测不得阻止进程退出（关机路径不依赖定时器）。
 */
import type { Clock, TimerScheduler } from "@kurobot/bridge-core";

export class NodeClock implements Clock {
    now(): number {
        return Date.now();
    }
}

export class NodeScheduler implements TimerScheduler {
    schedule(delayMs: number, callback: () => void): () => void {
        const timer = setTimeout(callback, Math.max(0, delayMs));
        timer.unref();
        return () => {
            clearTimeout(timer);
        };
    }
}
