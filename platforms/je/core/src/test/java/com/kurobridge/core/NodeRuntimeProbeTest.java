package com.kurobridge.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/**
 * NodeRuntimeProbe 单测：分类逻辑是纯函数，回退策略用注入执行器覆盖（不拉起真实进程）。
 * 真进程预检由 Gradle 的集成面在 CI 上自然覆盖（java job 的 runner 自带 node）。
 */
final class NodeRuntimeProbeTest {
    private static NodeRuntimeProbe.Result result(NodeRuntimeProbe.Status status, String detail) {
        return new NodeRuntimeProbe.Result(status, detail);
    }

    @Test
    void classifiesGlibcAndLibstdcxxFailures() {
        NodeRuntimeProbe.Result glibc = NodeRuntimeProbe.classify(
                1, "node: /lib64/libc.so.6: version `GLIBC_2.28' not found (required by node)", false);
        assertEquals(NodeRuntimeProbe.Status.UNSATISFIED_LIBC, glibc.status());
        assertTrue(glibc.detail().contains("GLIBC_2.28"));

        NodeRuntimeProbe.Result libstdcxx = NodeRuntimeProbe.classify(
                1, "node: /usr/lib64/libstdc++.so.6: version `GLIBCXX_3.4.25' not found", false);
        assertEquals(NodeRuntimeProbe.Status.UNSATISFIED_LIBC, libstdcxx.status());
    }

    @Test
    void classifiesNonZeroTimeoutAndOk() {
        assertEquals(
                NodeRuntimeProbe.Status.NON_ZERO,
                NodeRuntimeProbe.classify(127, "node: command not found", false).status());
        assertEquals(
                NodeRuntimeProbe.Status.TIMEOUT,
                NodeRuntimeProbe.classify(0, "", true).status());
        NodeRuntimeProbe.Result ok = NodeRuntimeProbe.classify(0, "v26.13.0\n", false);
        assertEquals(NodeRuntimeProbe.Status.OK, ok.status());
        assertEquals("v26.13.0", ok.detail());
    }

    @Test
    void detailIsFirstLineAndBounded() {
        String output = "line one\nline two\n" + "x".repeat(1000);
        NodeRuntimeProbe.Result result = NodeRuntimeProbe.classify(1, output, false);
        assertEquals("line one", result.detail());

        NodeRuntimeProbe.Result longLine = NodeRuntimeProbe.classify(1, "y".repeat(1000), false);
        assertTrue(
                longLine.detail().length() <= 301,
                "detail 必须截断，实际 " + longLine.detail().length());
    }

    @Test
    void remediationCoversLibcTimeoutAndSpawnFailure() {
        assertTrue(NodeRuntimeProbe.remediation(NodeRuntimeProbe.Status.UNSATISFIED_LIBC)
                .contains("glibc >= 2.28"));
        assertTrue(NodeRuntimeProbe.remediation(NodeRuntimeProbe.Status.UNSATISFIED_LIBC)
                .contains("KUROBRIDGE_NODE"));
        assertTrue(NodeRuntimeProbe.remediation(NodeRuntimeProbe.Status.TIMEOUT).contains("noexec"));
        assertTrue(NodeRuntimeProbe.remediation(NodeRuntimeProbe.Status.SPAWN_FAILED)
                .contains("+x"));
        assertTrue(
                NodeRuntimeProbe.remediation(NodeRuntimeProbe.Status.NON_ZERO).contains("完整性"));
    }

    @Test
    void resolveUsesEmbeddedWhenProbeSucceeds() {
        List<String> logs = new ArrayList<>();
        Path embedded = Path.of("plugins", "bin", "node-linux-x64");
        String resolved = NodeRuntimeProbe.resolve(
                embedded, logs::add, (executable, timeout) -> result(NodeRuntimeProbe.Status.OK, "v26.13.0"));
        assertEquals(embedded.toString(), resolved);
        assertTrue(logs.isEmpty(), "内嵌可用时不应产生告警，实际：" + logs);
    }

    @Test
    void resolveFallsBackToPathNodeAndLogsRemediation() {
        List<String> logs = new ArrayList<>();
        AtomicInteger calls = new AtomicInteger();
        String resolved =
                NodeRuntimeProbe.resolve(Path.of("/plugins/bin/node-linux-x64"), logs::add, (executable, timeout) -> {
                    if (calls.getAndIncrement() == 0) {
                        return result(NodeRuntimeProbe.Status.UNSATISFIED_LIBC, "version `GLIBC_2.28' not found");
                    }
                    return result(NodeRuntimeProbe.Status.OK, "v20.11.0");
                });
        assertEquals("node", resolved);
        assertTrue(logs.stream().anyMatch(line -> line.contains("内嵌 node 不可用")));
        assertTrue(logs.stream().anyMatch(line -> line.contains("glibc >= 2.28")));
        assertTrue(logs.stream().anyMatch(line -> line.contains("回落 PATH 上的 node")));
    }

    @Test
    void resolveReturnsNullWhenBothFail() {
        List<String> logs = new ArrayList<>();
        String resolved = NodeRuntimeProbe.resolve(
                Path.of("/plugins/bin/node-linux-x64"),
                logs::add,
                (executable, timeout) -> result(NodeRuntimeProbe.Status.SPAWN_FAILED, "Permission denied"));
        assertNull(resolved, "两者都不可用必须返回 null，由调用方降级为无 IPC");
        assertTrue(logs.stream().anyMatch(line -> line.contains("[SEVERE]")));
        assertTrue(logs.stream().anyMatch(line -> line.contains("无 IPC")));
    }

    @Test
    void probeTimeoutIsBoundedAndReportsTimeout() {
        NodeRuntimeProbe.Result timeout = NodeRuntimeProbe.classify(0, "partial", true);
        assertEquals(NodeRuntimeProbe.Status.TIMEOUT, timeout.status());
        assertEquals("partial", timeout.detail());
    }

    @Test
    void probeRejectsMissingExecutableWithoutThrowing() {
        NodeRuntimeProbe.Result failed =
                NodeRuntimeProbe.probe(Path.of("/definitely/not/a/node/binary"), Duration.ofMillis(200));
        assertEquals(NodeRuntimeProbe.Status.SPAWN_FAILED, failed.status());
    }
}
