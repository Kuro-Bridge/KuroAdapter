/**
 * 壳内看护器：驱动「node shim 拉起尝试」的生命周期，语义对齐 JE NodeSupervisor
 * （裁决册 §4.4）。一次尝试 = attempt() resolve（ready）= 成功；reject = 失败
 * （newProcess false / 退出回调先于 ready / WS 错误失连 / 握手超时，由实现归一）。
 *
 * - 退避 1s/5s/15s；10 分钟滑动窗累计 3 次失败 → 放弃（error + 手动恢复提示）。
 * - autoRestart=false（ready 上报，缺省 true）→ 失败只 warn 不自动重试。
 * - manualRetry（控制台 kurobridgeretry）重置放弃态与退避/窗口后立即尝试。
 * 定时只用全局 setTimeout（经 lse-env，测试可换假计时器）。
 */
import { cancelTimer, type ShellLogger, scheduleTimer, type TimerHandle } from "./lse-env.js";

/** 一次尝试的结算信息（ready 帧上报） */
export interface AttemptOutcome {
    /** shim 配置的 runtime.autoRestart（缺省按 true，对齐 JE handleReady） */
    readonly autoRestart: boolean;
}

export type SupervisorState = "idle" | "attempting" | "up" | "down-given-up";

const BACKOFF_MS: readonly number[] = [1_000, 5_000, 15_000];
const FAILURE_WINDOW_MS = 600_000;
const FAILURE_LIMIT = 3;

export interface SupervisorOptions {
    readonly logger: ShellLogger;
    readonly attempt: () => Promise<AttemptOutcome>;
}

export class Supervisor {
    private state: SupervisorState = "idle";
    private autoRestart = true;
    private backoffIndex = 0;
    private readonly failures: number[] = [];
    private retryTimer: TimerHandle | null = null;
    private readonly logger: ShellLogger;
    private readonly attempt: () => Promise<AttemptOutcome>;

    constructor(options: SupervisorOptions) {
        this.logger = options.logger;
        this.attempt = options.attempt;
    }

    start(): void {
        this.logger.info("看护器启动（自动拉起 node shim）");
        this.startAttempt();
    }

    /** 控制台 kurobridgeretry：重置放弃态与退避/窗口后立即尝试 */
    manualRetry(): void {
        if (this.state === "attempting") {
            this.logger.warn("看护：尝试进行中，忽略 kurobridgeretry");
            return;
        }
        this.cancelRetryTimer();
        this.backoffIndex = 0;
        this.failures.length = 0;
        this.state = "idle";
        this.logger.info("看护：手动重试（kurobridgeretry）");
        this.startAttempt();
    }

    private startAttempt(): void {
        if (this.state === "attempting") {
            return;
        }
        this.state = "attempting";
        void this.attempt().then(
            (outcome) => {
                if (this.state !== "attempting") {
                    return;
                }
                // 尝试成功（ready）：清零退避与失败窗口（裁决册 §4.4）
                this.state = "up";
                this.autoRestart = outcome.autoRestart;
                this.backoffIndex = 0;
                this.failures.length = 0;
                this.logger.info("看护：尝试成功（ready），退避与失败窗口已清零");
            },
            (error: unknown) => {
                this.handleFailure(error instanceof Error ? error.message : String(error));
            },
        );
    }

    private handleFailure(reason: string): void {
        if (this.state !== "attempting" && this.state !== "up") {
            return;
        }
        const count = this.recordFailure();
        if (!this.autoRestart) {
            this.state = "idle";
            this.logger.warn(
                `看护：autoRestart=false，不自动重启（${reason}）；可执行 kurobridgeretry 手动拉起`,
            );
            return;
        }
        if (count >= FAILURE_LIMIT) {
            this.state = "down-given-up";
            this.logger.error(
                `看护：10 分钟内失败 ${count} 次，放弃自动重启，功能禁用；手动恢复：控制台执行 kurobridgeretry（最近失败：${reason}）`,
            );
            return;
        }
        const delay = BACKOFF_MS[Math.min(this.backoffIndex, BACKOFF_MS.length - 1)] ?? 1_000;
        this.backoffIndex += 1;
        this.state = "idle";
        this.logger.warn(`看护：${delay}ms 后自动重试（${reason}）`);
        this.retryTimer = scheduleTimer(() => {
            this.retryTimer = null;
            this.startAttempt();
        }, delay);
    }

    /** 记一次失败并裁掉窗口外旧记录，返回窗口内次数 */
    private recordFailure(): number {
        const now = Date.now();
        for (let index = this.failures.length - 1; index >= 0; index -= 1) {
            const at = this.failures[index] ?? 0;
            if (now - at > FAILURE_WINDOW_MS) {
                this.failures.splice(index, 1);
            }
        }
        this.failures.push(now);
        return this.failures.length;
    }

    private cancelRetryTimer(): void {
        const timer = this.retryTimer;
        if (timer === null) {
            return;
        }
        this.retryTimer = null;
        cancelTimer(timer);
    }
}
