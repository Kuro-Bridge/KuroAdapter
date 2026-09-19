package com.kurobridge.fabric;

import java.util.ArrayDeque;

/**
 * TPS 自测器（纯逻辑，JUnit 可测）：fabric 无 {@code Bukkit.getTPS()} 等价物（vanilla 的
 * {@code getAverageTickTime()} 仅 100 tick ≈ 5s 窗，与 paper 1 分钟窗语义不符），按
 * END_SERVER_TICK 逐 tick 记结束时刻、60s 滑动窗换算（docs/design.md §3）。
 *
 * <p>算法：tps = (窗口内样本数 − 1) ÷ 首尾时间差（换算为每秒），上限 {@link #TARGET_TPS}
 * = 20（vanilla 目标值，窗口极小时的高频噪声由此兜住）；样本 &lt; 2（冷启动首 tick 前与
 * 全窗逐出后）按缺省 {@code 20.0} 处理（对齐 Bukkit 冷启动读数）。
 *
 * <p>线程契约：onTickEnd / sampleTps 均在服务端主线程调用（END_SERVER_TICK 与 join/quit
 * 事件同线程），无并发防护。
 */
public final class TickRateSampler {
    static final double TARGET_TPS = 20.0;
    private static final long WINDOW_NANOS = 60L * 1_000_000_000L;

    /** tick 结束时刻（纳秒升序）；双端队列头即最旧样本。 */
    private final ArrayDeque<Long> tickEndNanos = new ArrayDeque<>();

    /** 记录一个 tick 的结束时刻，并逐出 60s 窗口外的旧样本。 */
    public void onTickEnd(long nowNanos) {
        tickEndNanos.addLast(nowNanos);
        while (tickEndNanos.peekFirst() != null && nowNanos - tickEndNanos.peekFirst() > WINDOW_NANOS) {
            tickEndNanos.removeFirst();
        }
    }

    /** 当前 TPS 估计（窗口换算，上限 20；样本 &lt; 2 返回缺省 20.0）。 */
    public double sampleTps() {
        if (tickEndNanos.size() < 2) {
            return TARGET_TPS;
        }
        Long first = tickEndNanos.peekFirst();
        Long last = tickEndNanos.peekLast();
        long spanNanos = Math.max(1L, last - first);
        double tps = (tickEndNanos.size() - 1) * 1_000_000_000.0 / spanNanos;
        return Math.min(TARGET_TPS, tps);
    }

    /** 归一化到协议口径：四舍五入 1 位小数 + 下限 0（与 paper ConnectionListener 同式）。 */
    public static double normalizeTps(double tps) {
        return Math.max(0, Math.round(tps * 10.0) / 10.0);
    }

    /** 窗口内样本数（测试断言用）。 */
    int windowSize() {
        return tickEndNanos.size();
    }
}
