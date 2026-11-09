package com.kurobridge.core;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;

/**
 * 运行期平台键：把 JVM 的 {@code os.name}/{@code os.arch} 归一成
 * {@code win-x64 / win-arm64 / linux-x64 / linux-arm64}。
 *
 * <p>键必须与构建期 {@code toolings/packaging/embed.ts} 的 targets、
 * {@code runtime-manifest.json} 的 targets 以及 {@code manifest.json} 的 {@code runtimes}
 * 完全一致——三处同时扩，别单边改。
 *
 * <p>归一口径（各 JVM 写法不一，实测覆盖）：
 * <ul>
 *   <li>arch：{@code x86_64} / {@code amd64} / {@code x64} → {@code x64}；
 *       {@code aarch64} / {@code arm64} → {@code arm64}；其余返回 null。</li>
 *   <li>os：含 {@code win} → {@code win}；含 {@code linux} → {@code linux}；
 *       macOS / BSD 等返回 null（走 PATH node 回退，不误配到 Linux 二进制）。</li>
 * </ul>
 *
 * <p>纯函数、零依赖：平台判断只此一处，{@code EmbeddedRuntime} 与平台薄壳都经它取值。
 */
public final class PlatformKey {
    public static final String WIN_X64 = "win-x64";
    public static final String WIN_ARM64 = "win-arm64";
    public static final String LINUX_X64 = "linux-x64";
    public static final String LINUX_ARM64 = "linux-arm64";

    private static final List<String> KNOWN =
            Collections.unmodifiableList(Arrays.asList(WIN_X64, WIN_ARM64, LINUX_X64, LINUX_ARM64));

    private PlatformKey() {}

    /** 当前 JVM 的平台键；无法归一（macOS/BSD/陌生架构）时返回 null。 */
    public static String detect() {
        return detect(System.getProperty("os.name", ""), System.getProperty("os.arch", ""));
    }

    /** 可注入入参的归一（测试覆盖各 JVM 写法）；任一段无法归一即返回 null。 */
    static String detect(String osName, String osArch) {
        String os = normalizeOs(osName);
        String arch = normalizeArch(osArch);
        if (os == null || arch == null) {
            return null;
        }
        return os + "-" + arch;
    }

    /** 是否 Windows 键（预检策略按平台分流：Windows 不做启动预检，省一次进程拉起）。 */
    public static boolean isWindows(String key) {
        return key != null && key.startsWith("win-");
    }

    /** 已知键（错误提示用）。 */
    public static Set<String> known() {
        return Collections.unmodifiableSet(new TreeSet<>(KNOWN));
    }

    private static String normalizeOs(String osName) {
        if (osName == null) {
            return null;
        }
        String normalized = osName.toLowerCase(Locale.ROOT);
        // 注意不能用 contains("win")：Darwin 含 "win"，会把 macOS 误判成 Windows
        if (normalized.startsWith("windows") || "win".equals(normalized)) {
            return "win";
        }
        if (normalized.contains("linux")) {
            return "linux";
        }
        return null;
    }

    private static String normalizeArch(String osArch) {
        if (osArch == null) {
            return null;
        }
        String normalized = osArch.toLowerCase(Locale.ROOT);
        if ("x86_64".equals(normalized) || "amd64".equals(normalized) || "x64".equals(normalized)) {
            return "x64";
        }
        if ("aarch64".equals(normalized) || "arm64".equals(normalized)) {
            return "arm64";
        }
        return null;
    }
}
