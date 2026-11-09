package com.kurobridge.core;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * 内嵌 node 的可执行性预检与回退策略（跨平台批次的“不崩服”半边）。
 *
 * <p>为什么需要预检：Linux 官方二进制要求 glibc ≥ 2.28、libstdc++ ≥ GLIBCXX_3.4.25。
 * 在不满足的宿主机上，拉起的进程会立刻退出并只在 stderr 打一行
 * {@code version `GLIBC_2.28' not found}；没有预检时表现为「等 ready 30s 超时 + 看护器退避」，
 * 故障定位成本极高。预检把这行错误提前到启动路径，并给出可执行的修复指引。
 *
 * <p>回退策略（只在 Linux 生效；Windows 不做预检以省一次进程拉起）：
 * <ol>
 *   <li>内嵌 node 预检通过 → 用它；</li>
 *   <li>否则 WARN + 明确原因 → 预检 PATH 上的 {@code node}，通过则回落；</li>
 *   <li>两者都不可用 → SEVERE，返回 null，调用方保持「插件加载但无 IPC」的既有降级语义。</li>
 * </ol>
 *
 * <p>{@code KUROBRIDGE_NODE} 显式指定时调用方根本不进本类——用户已做选择，
 * 静默替换成别的二进制反而更危险。
 */
public final class NodeRuntimeProbe {
    /** 预检结论分类。 */
    public enum Status {
        /** 拉起成功且 {@code node --version} 退出码 0。 */
        OK,
        /** 退出码非 0，且输出含 GLIBC/GLIBCXX 版本缺失标记。 */
        UNSATISFIED_LIBC,
        /** 其它非 0 退出。 */
        NON_ZERO,
        /** 超过预检时限（noexec 挂载、被杀软拦截、二进制卡死）。 */
        TIMEOUT,
        /** ProcessBuilder 无法拉起（权限/格式/文件缺失）。 */
        SPAWN_FAILED
    }

    /** 预检结果：状态 + 首个非空输出行（诊断用）。 */
    public static final class Result {
        private final Status status;
        private final String detail;

        Result(Status status, String detail) {
            this.status = status;
            this.detail = detail;
        }

        public Status status() {
            return status;
        }

        public String detail() {
            return detail;
        }

        public boolean ok() {
            return status == Status.OK;
        }
    }

    /** 可注入的执行器：测试用假实现，生产走 {@link #probe(String, Duration)}。 */
    @FunctionalInterface
    interface Executor {
        Result run(String executable, Duration timeout);
    }

    /** 预检时限：node --version 属毫秒级操作，5s 只用来兜住卡死场景。 */
    private static final Duration PROBE_TIMEOUT = Duration.ofSeconds(5);

    /** 输出捕获上限（loader 报错与 --version 都是一两行；防御异常输出撑爆内存）。 */
    private static final int OUTPUT_LIMIT = 8 * 1024;

    /** detail 展示上限（日志单行可读）。 */
    private static final int DETAIL_LIMIT = 300;

    private NodeRuntimeProbe() {}

    /** 预检指定 node 可执行文件。 */
    public static Result probe(Path executable, Duration timeout) {
        return probe(executable.toString(), timeout);
    }

    /** 常驻预检：5s 上限。 */
    public static Result probe(Path executable) {
        return probe(executable, PROBE_TIMEOUT);
    }

    /** 预检并解析：内嵌不可用时按策略回退 PATH node；返回最终可执行路径，或 null（无可用）。 */
    public static String resolve(Path embeddedNode, Consumer<String> log) {
        return resolve(embeddedNode, log, NodeRuntimeProbe::probe);
    }

    /** 可注入执行器的 {@link #resolve(Path, Consumer)}（测试不拉起真实进程）。 */
    static String resolve(Path embeddedNode, Consumer<String> log, Executor executor) {
        Result embedded = executor.run(embeddedNode.toString(), PROBE_TIMEOUT);
        if (embedded.ok()) {
            return embeddedNode.toString();
        }
        log.accept("[NodeRuntimeProbe][WARN] 内嵌 node 不可用（" + embedded.status() + "：" + embedded.detail() + "）；"
                + remediation(embedded.status()));
        Result onPath = executor.run("node", PROBE_TIMEOUT);
        if (onPath.ok()) {
            log.accept("[NodeRuntimeProbe][WARN] 已回落 PATH 上的 node（" + onPath.detail() + "）");
            return "node";
        }
        log.accept("[NodeRuntimeProbe][SEVERE] 内嵌与 PATH 上的 node 均不可用（" + onPath.detail() + "），插件保持加载但无 IPC");
        return null;
    }

    /** 状态 → 可执行的修复指引（日志用，避免只报现象不报怎么办）。 */
    static String remediation(Status status) {
        if (status == Status.UNSATISFIED_LIBC) {
            return "需要 glibc >= 2.28 且 libstdc++ >= GLIBCXX_3.4.25（Debian 10+ / Ubuntu 20.04+ / RHEL 8+）；"
                    + "或设置 KUROBRIDGE_NODE 指向系统 node";
        }
        if (status == Status.TIMEOUT) {
            return "二进制无响应：检查 plugins/kurobridge/bin 是否位于 noexec 挂载，或被杀软拦截";
        }
        if (status == Status.SPAWN_FAILED) {
            return "无法执行：检查文件权限（需 +x）与挂载选项（noexec）";
        }
        return "运行 node --version 失败：检查二进制完整性（JAR 是否损坏）";
    }

    private static Result probe(String executable, Duration timeout) {
        Process process;
        try {
            process = new ProcessBuilder(executable, "--version")
                    .redirectErrorStream(true)
                    .start();
        } catch (IOException | RuntimeException e) {
            return new Result(Status.SPAWN_FAILED, messageOf(e));
        }
        boolean finished;
        try {
            finished = process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
            return new Result(Status.TIMEOUT, "等待 node --version 被中断");
        }
        if (!finished) {
            process.destroyForcibly();
            return new Result(Status.TIMEOUT, "node --version 超时（" + timeout.toMillis() + "ms）");
        }
        // 进程已退出：合并流不会再阻塞读取（--version 与 loader 报错都远小于管道缓冲）
        String output = readBounded(process.getInputStream());
        return classify(process.exitValue(), output, false);
    }

    /** 退出码 + 输出 → 结论（纯函数，测试覆盖各类 loader 报错文案）。 */
    static Result classify(int exitCode, String output, boolean timedOut) {
        String firstLine = firstLine(output);
        if (timedOut) {
            return new Result(Status.TIMEOUT, firstLine.isEmpty() ? "超时" : firstLine);
        }
        if (exitCode != 0) {
            boolean libcMarker = output != null && (output.contains("GLIBC_") || output.contains("GLIBCXX_"));
            return new Result(libcMarker ? Status.UNSATISFIED_LIBC : Status.NON_ZERO, firstLine);
        }
        return new Result(Status.OK, firstLine);
    }

    private static String readBounded(InputStream stream) {
        StringBuilder builder = new StringBuilder();
        byte[] chunk = new byte[1024];
        try (InputStream input = stream) {
            int read;
            while (builder.length() < OUTPUT_LIMIT && (read = input.read(chunk)) != -1) {
                builder.append(new String(chunk, 0, read, StandardCharsets.UTF_8));
            }
        } catch (IOException e) {
            // 进程已退出，读不到更多输出不影响分类
        }
        return builder.toString();
    }

    private static String firstLine(String text) {
        if (text == null) {
            return "";
        }
        String trimmed = text.trim();
        int newline = trimmed.indexOf('\n');
        String line = (newline < 0 ? trimmed : trimmed.substring(0, newline)).trim();
        return line.length() <= DETAIL_LIMIT ? line : line.substring(0, DETAIL_LIMIT) + "…";
    }

    private static String messageOf(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isEmpty() ? error.toString() : message;
    }
}
