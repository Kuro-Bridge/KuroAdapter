/**
 * 时钟与定时器注入接口（ADR-007：core 平台无关，setTimeout/Date.now 也不直接用）。
 *
 * Node 实现在 bridge/embedded 引导层；本文件的 Manual 实现是纯逻辑测试替身
 * （vitest 手动推进，确定性、无真实等待）。
 */

/** epoch 毫秒时钟 */
export interface Clock {
    now(): number;
}

/** 取消已调度的一次性定时器（幂等） */
export type CancelFn = () => void;

/** 一次性定时器调度器（宿主实现应不阻止进程退出，如 Node 的 timer.unref） */
export interface TimerScheduler {
    schedule(delayMs: number, callback: () => void): CancelFn;
}

/** 手动时钟：测试用，advance 推进（不触发任何调度器） */
export class ManualClock implements Clock {
    private current: number;

    constructor(initial: number = 0) {
        this.current = initial;
    }

    now(): number {
        return this.current;
    }

    advance(ms: number): void {
        this.current += ms;
    }
}

interface ScheduledTask {
    readonly dueAt: number;
    readonly callback: () => void;
}

/** 手动调度器：与 ManualClock 配套，advance 推进时钟并触发全部到期任务 */
export class ManualScheduler implements TimerScheduler {
    private nextId = 0;
    private readonly tasks = new Map<number, ScheduledTask>();
    private readonly clock: ManualClock;

    constructor(clock: ManualClock) {
        this.clock = clock;
    }

    schedule(delayMs: number, callback: () => void): CancelFn {
        const id = this.nextId;
        this.nextId += 1;
        this.tasks.set(id, { dueAt: this.clock.now() + Math.max(0, delayMs), callback });
        return () => {
            this.tasks.delete(id);
        };
    }

    /** 推进时钟 ms 毫秒并触发到期任务（回调内再调度亦可） */
    advance(ms: number): void {
        this.clock.advance(ms);
        this.fireDue();
    }

    /** 触发当前时钟下全部到期任务 */
    fireDue(): void {
        let fired = true;
        while (fired) {
            fired = false;
            for (const [id, task] of this.tasks) {
                if (task.dueAt <= this.clock.now()) {
                    this.tasks.delete(id);
                    task.callback();
                    fired = true;
                    break; // 回调可能已增删任务，重新遍历保证语义稳定
                }
            }
        }
    }

    /** 未触发的任务数（断言无泄漏用） */
    get pendingCount(): number {
        return this.tasks.size;
    }
}
