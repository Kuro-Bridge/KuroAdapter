package com.kurobridge.fabric;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * TPS 自测器单测：滑动窗换算、上限 20、冷启动缺省、窗口逐出与协议归一化（docs/design.md §8；
 * 纯逻辑直测，零 MC 依赖）。
 */
class TickRateSamplerTest {
    private static final long MS = 1_000_000L;

    @Test
    void 冷启动样本不足两个返回缺省目标值() {
        TickRateSampler sampler = new TickRateSampler();
        assertEquals(TickRateSampler.TARGET_TPS, sampler.sampleTps(), 1e-9);
        sampler.onTickEnd(0);
        assertEquals(TickRateSampler.TARGET_TPS, sampler.sampleTps(), 1e-9);
    }

    @Test
    void 健康五十毫秒节拍读满二十() {
        TickRateSampler sampler = new TickRateSampler();
        for (int i = 0; i < 100; i++) {
            sampler.onTickEnd(i * 50L * MS);
        }
        assertEquals(20.0, sampler.sampleTps(), 0.01);
    }

    @Test
    void 卡顿一百毫秒节拍读半速() {
        TickRateSampler sampler = new TickRateSampler();
        for (int i = 0; i < 10; i++) {
            sampler.onTickEnd(i * 100L * MS);
        }
        assertEquals(10.0, sampler.sampleTps(), 0.01);
    }

    @Test
    void 高频噪声不超二十上限() {
        TickRateSampler sampler = new TickRateSampler();
        sampler.onTickEnd(0);
        sampler.onTickEnd(1 * MS); // 1ms 间隔 → 原始估计 1000/s，由上限 20 兜住
        assertEquals(20.0, sampler.sampleTps(), 1e-9);
    }

    @Test
    void 窗口外旧样本全部逐出() {
        TickRateSampler sampler = new TickRateSampler();
        for (int i = 0; i < 100; i++) {
            sampler.onTickEnd(i * 50L * MS);
        }
        assertEquals(100, sampler.windowSize());
        sampler.onTickEnd(120_000L * MS); // 跳 2 分钟：窗口内全部过期，只剩新样本
        assertEquals(1, sampler.windowSize());
        assertEquals(TickRateSampler.TARGET_TPS, sampler.sampleTps(), 1e-9);
    }

    @Test
    void 归一化一位小数且下限为零() {
        assertEquals(19.9, TickRateSampler.normalizeTps(19.94), 1e-9);
        assertEquals(20.0, TickRateSampler.normalizeTps(19.96), 1e-9);
        assertEquals(20.0, TickRateSampler.normalizeTps(20.0), 1e-9);
        assertEquals(0.0, TickRateSampler.normalizeTps(-3.3), 1e-9);
    }
}
