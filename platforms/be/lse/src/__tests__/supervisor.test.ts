/**
 * 壳内看护器退避契约（裁决册 §4.4，对齐 JE NodeSupervisor）：
 * - 重试延时序列 1000 / 5000 / 15000ms（BACKOFF_MS，真值断言）。
 * - 10 分钟窗内累计 3 次失败 → 放弃态：不再自动尝试，error 级日志提示 kurobridgeretry。
 * - manualRetry 重置放弃态与退避/窗口后立即尝试。
 * - 尝试成功（ready）：退避与失败窗口清零。
 * - ready.autoRestart=false（缺省 true）→ 后续失败只 warn，不排自动重试。
 * - up 态生命线（AttemptHandle.done，修复 1 契约）：ready 后通道失联 → 退避重生；
 *   ready 前失败的同期 done 拒绝不双计（up 态护栏）。
 * 定时全程 fake timers；attempt 闭包注入（SupervisorOptions.attempt，双结算句柄桩）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { type AttemptHandle, type AttemptOutcome, Supervisor } from "../supervisor.js";

/** 日志桩：各方法为带类型 mock，可断言调用（形状满足 ShellLogger） */
function makeLogger(): {
    debug: ReturnType<typeof vi.fn<(message: string) => void>>;
    info: ReturnType<typeof vi.fn<(message: string) => void>>;
    warn: ReturnType<typeof vi.fn<(message: string) => void>>;
    error: ReturnType<typeof vi.fn<(message: string) => void>>;
} {
    return {
        debug: vi.fn<(message: string) => void>(() => undefined),
        info: vi.fn<(message: string) => void>(() => undefined),
        warn: vi.fn<(message: string) => void>(() => undefined),
        error: vi.fn<(message: string) => void>(() => undefined),
    };
}

interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

interface AttemptRound {
    readonly ready: Deferred<AttemptOutcome>;
    readonly done: Deferred<void>;
}

/** attempt 可编程桩：每次调用产出新的双结算句柄，测试用三个结算动词驱动 */
function makeAttempt(): {
    readonly attempt: ReturnType<typeof vi.fn<() => AttemptHandle>>;
    resolveWith: (outcome: AttemptOutcome) => void;
    rejectReadyWith: (error: Error) => void;
    rejectDoneWith: (error: Error) => void;
} {
    const rounds: AttemptRound[] = [];
    const attempt = vi.fn((): AttemptHandle => {
        const round: AttemptRound = { ready: deferred<AttemptOutcome>(), done: deferred<void>() };
        rounds.push(round);
        return { ready: round.ready.promise, done: round.done.promise };
    });
    const last = (): AttemptRound => {
        const current = rounds[rounds.length - 1];
        expect(current, "attempt 应已发起").toBeDefined();
        return current as AttemptRound;
    };
    return {
        attempt,
        resolveWith: (outcome) => {
            last().ready.resolve(outcome);
        },
        // 对齐 attemptOnce 契约：ready 前失败同时结算两面（done 的拒绝被看护器 up 态护栏忽略）
        rejectReadyWith: (error) => {
            last().ready.reject(error);
            last().done.reject(error);
        },
        rejectDoneWith: (error) => {
            last().done.reject(error);
        },
    };
}

const OK: AttemptOutcome = { autoRestart: true };

afterEach(() => {
    vi.useRealTimers();
});

describe("启动与立即尝试", () => {
    it("start 立即发起第一次尝试（不等退避定时器）", () => {
        vi.useFakeTimers();
        const { attempt } = makeAttempt();
        const supervisor = new Supervisor({ logger: makeLogger(), attempt });
        supervisor.start();
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    it("尝试进行中重复 start 不并发（state=attempting 护栏）", () => {
        vi.useFakeTimers();
        const { attempt } = makeAttempt();
        const supervisor = new Supervisor({ logger: makeLogger(), attempt });
        supervisor.start();
        supervisor.start();
        expect(attempt).toHaveBeenCalledTimes(1);
    });
});

describe("退避序列 1000 / 5000 / 15000ms（裁决册 §4.4 数值）", () => {
    it("连续失败：延时逐次 1000 → 5000，第 3 次（窗内）失败直接放弃（15000 仅跨窗可达，见剪枝用例）", async () => {
        vi.useFakeTimers();
        const { attempt, rejectReadyWith } = makeAttempt();
        const logger = makeLogger();
        const supervisor = new Supervisor({ logger, attempt });
        supervisor.start();
        rejectReadyWith(new Error("f1"));
        await vi.advanceTimersByTimeAsync(0);
        expect(
            logger.warn.mock.calls.some(([text]) =>
                String(text).startsWith("看护：1000ms 后自动重试"),
            ),
        ).toBe(true);

        await vi.advanceTimersByTimeAsync(999);
        expect(attempt).toHaveBeenCalledTimes(1); // 999ms 未到点
        await vi.advanceTimersByTimeAsync(1);
        expect(attempt).toHaveBeenCalledTimes(2); // 第 1000ms 整触发

        rejectReadyWith(new Error("f2"));
        await vi.advanceTimersByTimeAsync(0);
        expect(
            logger.warn.mock.calls.some(([text]) =>
                String(text).startsWith("看护：5000ms 后自动重试"),
            ),
        ).toBe(true);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(attempt).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(attempt).toHaveBeenCalledTimes(3);

        // 第 3 次失败落在 10 分钟窗内（凑满 3 条）→ 放弃而非排 15000ms 重试
        rejectReadyWith(new Error("f3"));
        await vi.advanceTimersByTimeAsync(0);
        expect(logger.error.mock.calls.some(([text]) => String(text).includes("放弃"))).toBe(true);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(attempt).toHaveBeenCalledTimes(3);
    });

    it("10 分钟窗内 3 次失败 → 放弃：不再自动尝试，error 日志提示 kurobridgeretry", async () => {
        vi.useFakeTimers();
        const { attempt, rejectReadyWith } = makeAttempt();
        const logger = makeLogger();
        const supervisor = new Supervisor({ logger, attempt });
        supervisor.start();
        // 第 1、2 次失败各排一次自动重试（1000ms / 5000ms，快进到点）
        rejectReadyWith(new Error("f0"));
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(20_000);
        rejectReadyWith(new Error("f1"));
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(attempt).toHaveBeenCalledTimes(3);
        // 第 3 次失败凑满窗口 → 放弃
        rejectReadyWith(new Error("f2"));
        await vi.advanceTimersByTimeAsync(0);
        const giveUp = logger.error.mock.calls.map(([text]) => String(text)).join("\n");
        expect(giveUp).toContain("放弃");
        expect(giveUp).toContain("kurobridgeretry");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(attempt).toHaveBeenCalledTimes(3); // 放弃态不再排自动尝试
    });

    it("放弃态后 manualRetry：立即重试，退避序列从头开始（1000ms）", async () => {
        vi.useFakeTimers();
        const { attempt, rejectReadyWith } = makeAttempt();
        const logger = makeLogger();
        const supervisor = new Supervisor({ logger, attempt });
        supervisor.start();
        for (let round = 0; round < 3; round += 1) {
            rejectReadyWith(new Error("f"));
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(20_000);
        }
        expect(attempt).toHaveBeenCalledTimes(3); // 第 3 次失败已放弃
        supervisor.manualRetry();
        expect(attempt).toHaveBeenCalledTimes(4); // 放弃态解除，立即尝试
        rejectReadyWith(new Error("after-manual"));
        await vi.advanceTimersByTimeAsync(0);
        expect(
            logger.warn.mock.calls.some(([text]) =>
                String(text).startsWith("看护：1000ms 后自动重试"),
            ),
        ).toBe(true);
    });

    it("尝试进行中 manualRetry 被忽略（warn，不新增尝试）", async () => {
        vi.useFakeTimers();
        const { attempt } = makeAttempt();
        const logger = makeLogger();
        const supervisor = new Supervisor({ logger, attempt });
        supervisor.start();
        supervisor.manualRetry();
        expect(attempt).toHaveBeenCalledTimes(1);
        expect(
            logger.warn.mock.calls.some(([text]) => String(text).includes("kurobridgeretry")),
        ).toBe(true);
    });
});

describe("成功结算：计数清零与 autoRestart 采纳", () => {
    it("尝试成功 → info 日志；其后失败重试延时回到 1000ms、失败窗口清零", async () => {
        vi.useFakeTimers();
        const { attempt, resolveWith, rejectReadyWith } = makeAttempt();
        const logger = makeLogger();
        const supervisor = new Supervisor({ logger, attempt });
        supervisor.start();
        // 先积累两次失败（退避 idx=2、窗口 2 条）
        rejectReadyWith(new Error("f1"));
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(1_000);
        rejectReadyWith(new Error("f2"));
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(attempt).toHaveBeenCalledTimes(3);
        // 第三次成功：清零
        resolveWith(OK);
        await vi.advanceTimersByTimeAsync(0);
        expect(logger.info.mock.calls.some(([text]) => String(text).includes("已清零"))).toBe(true);
        // manualRetry 后再失败：延时 1000（未被历史拉高），窗口只 1 条（未达放弃线）
        supervisor.manualRetry();
        rejectReadyWith(new Error("f3"));
        await vi.advanceTimersByTimeAsync(0);
        expect(
            logger.warn.mock.calls.some(([text]) =>
                String(text).startsWith("看护：1000ms 后自动重试"),
            ),
        ).toBe(true);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(attempt).toHaveBeenCalledTimes(5);
    });

    it("ready.autoRestart=false 采纳后：失败只 warn 不排自动重试（缺省按 true 对齐 JE）", async () => {
        vi.useFakeTimers();
        const { attempt, resolveWith, rejectReadyWith } = makeAttempt();
        const logger = makeLogger();
        const supervisor = new Supervisor({ logger, attempt });
        supervisor.start();
        resolveWith({ autoRestart: false });
        await vi.advanceTimersByTimeAsync(0);
        // up 态下经 manualRetry 触发新一轮尝试并令其失败（真实路径：attempt 晚到的拒绝）
        supervisor.manualRetry();
        expect(attempt).toHaveBeenCalledTimes(2);
        rejectReadyWith(new Error("crash"));
        await vi.advanceTimersByTimeAsync(0);
        expect(
            logger.warn.mock.calls.some(([text]) => String(text).includes("autoRestart=false")),
        ).toBe(true);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(attempt).toHaveBeenCalledTimes(2); // 未排自动重试
    });
});

describe("up 态生命线（修复 1 契约：ready 后通道失联 → 退避重生）", () => {
    it("ready 后 done 拒绝（通道失联）→ up 态放行，按退避排 1000ms 重试并到点重生", async () => {
        vi.useFakeTimers();
        const { attempt, resolveWith, rejectDoneWith } = makeAttempt();
        const logger = makeLogger();
        const supervisor = new Supervisor({ logger, attempt });
        supervisor.start();
        resolveWith(OK);
        await vi.advanceTimersByTimeAsync(0);
        expect(attempt).toHaveBeenCalledTimes(1);
        // shim 在 up 态崩溃/断连：生命线断裂 → 看护器退避重生（新 spawn 新端口新令牌）
        rejectDoneWith(new Error("游戏通道断开：WS 断连（code=1006）"));
        await vi.advanceTimersByTimeAsync(0);
        expect(
            logger.warn.mock.calls.some(([text]) =>
                String(text).startsWith("看护：1000ms 后自动重试"),
            ),
        ).toBe(true);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(attempt).toHaveBeenCalledTimes(2);
    });

    it("ready 前失败的同期 done 拒绝不双计：单次失败只结算一次（一条退避日志、一次重试）", async () => {
        vi.useFakeTimers();
        const { attempt, rejectReadyWith } = makeAttempt();
        const logger = makeLogger();
        const supervisor = new Supervisor({ logger, attempt });
        supervisor.start();
        rejectReadyWith(new Error("握手失败")); // ready 与 done 同期拒绝（attemptOnce 契约形态）
        await vi.advanceTimersByTimeAsync(0);
        const retryWarns = logger.warn.mock.calls.filter(([text]) =>
            String(text).startsWith("看护：1000ms 后自动重试"),
        );
        expect(retryWarns).toHaveLength(1);
        expect(attempt).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(attempt).toHaveBeenCalledTimes(2);
    });
});

describe("10 分钟滑动窗剪枝", () => {
    it("窗口外旧失败被剪掉：跨窗后第 3 次失败仍不放弃（第 4 次才凑满 3 条）", async () => {
        vi.useFakeTimers();
        const { attempt, rejectReadyWith } = makeAttempt();
        const logger = makeLogger();
        const supervisor = new Supervisor({ logger, attempt });
        supervisor.start();
        // t=0 失败一次
        rejectReadyWith(new Error("old"));
        await vi.advanceTimersByTimeAsync(0);
        // 跨过 10 分钟窗（601s > 600s 窗口）后重试：旧记录被剪，窗口从零计
        await vi.advanceTimersByTimeAsync(601_000);
        expect(attempt).toHaveBeenCalledTimes(2);
        rejectReadyWith(new Error("w1"));
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(5_000);
        rejectReadyWith(new Error("w2"));
        await vi.advanceTimersByTimeAsync(0);
        // 窗口内只有 2 条（old 已剪）：仍排 15000ms 自动重试而非放弃
        expect(
            logger.error.mock.calls.some(([text]) => String(text).includes("放弃")),
            "跨窗后不应提前放弃",
        ).toBe(false);
        expect(
            logger.warn.mock.calls.some(([text]) =>
                String(text).startsWith("看护：15000ms 后自动重试"),
            ),
        ).toBe(true);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(attempt).toHaveBeenCalledTimes(4);
        rejectReadyWith(new Error("w3"));
        await vi.advanceTimersByTimeAsync(0);
        expect(logger.error.mock.calls.some(([text]) => String(text).includes("放弃"))).toBe(true);
    });
});
