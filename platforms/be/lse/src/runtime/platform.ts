/**
 * core 的 Clock / TimerScheduler Node 实现（lse node shim 侧；镜像 bridge/embedded/node-platform，
 * 「唯一的 Node API 落点」之一）。定时器一律 unref：core 的超时检测不得阻止进程退出
 * （关机路径不依赖定时器）。显式从 node:timers 导入，规避 LSE 全局 setTimeout 声明合并。
 */
import { setTimeout } from "node:timers";
import type { Clock, TimerScheduler } from "@kuro-bridge/bridge-core";

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
