/**
 * 壳内看护器：驱动「node shim 拉起尝试」的生命周期，语义对齐 JE NodeSupervisor
 * （裁决册 §4.4）。尝试经双结算句柄交接（AttemptHandle）：
 * - ready resolve = 尝试成功进入 up 态；ready reject = ready 前失败（唯一失败结算入口）；
 * - done = 尝试生命线：up 态（ready 后）通道失联/进程退出 → reject → 退避重生
 *   （新 spawn 新端口新令牌）；ready 前失败的同期 done 拒绝被 up 态护栏忽略——
 *   单次失败只结算一次，不双计失败、不双排重试。
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

/**
 * 一次尝试的双结算句柄（attempt 闭包的返回契约）。
 * 两面共用同一失败出口时，promise「先结算优先、后结算 no-op」的语义保证单次失败只被
 * 看护器结算一次（ready 拒绝 → 失败；ready 已 resolve 后 done 拒绝 → up 态退避重生）。
 */
export interface AttemptHandle {
    /** ready 结算：resolve = 尝试成功（up 态）；ready 前任何失败 = reject */
    readonly ready: Promise<AttemptOutcome>;
    /** 生命线：up 态失联 → reject（看护器退避重生）；成功路径保持 pending 随通道存续 */
    readonly done: Promise<void>;
}

export type SupervisorState = "idle" | "attempting" | "up" | "down-given-up";

const BACKOFF_MS: readonly number[] = [1_000, 5_000, 15_000];
const FAILURE_WINDOW_MS = 600_000;
const FAILURE_LIMIT = 3;

export interface SupervisorOptions {
    readonly logger: ShellLogger;
    readonly attempt: () => AttemptHandle;
}

export class Supervisor {
    private state: SupervisorState = "idle";
    private autoRestart = true;
    private backoffIndex = 0;
    private readonly failures: number[] = [];
    private retryTimer: TimerHandle | null = null;
    private readonly logger: ShellLogger;
    private readonly attempt: () => AttemptHandle;

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
        const handle = this.attempt();
        void handle.ready.then(
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
                // ready 前失败：唯一的失败结算入口（同期 done 拒绝由下方 up 态护栏忽略）
                this.handleFailure(error instanceof Error ? error.message : String(error));
            },
        );
        void handle.done.catch((error: unknown) => {
            // up 态生命线断裂（ready 后通道失联/进程退出）→ 退避重生。
            // 非 up 态（含 ready 前失败的同期拒绝）一概忽略：防双计失败/双排重试。
            if (this.state !== "up") {
                return;
            }
            this.handleFailure(error instanceof Error ? error.message : String(error));
        });
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
