package com.kurobridge.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import org.junit.jupiter.api.Test;

/**
 * PlatformKey 单测：覆盖各 JVM 对 os.name / os.arch 的不同写法，以及未知平台返回 null
 * （null 的含义是「走 PATH node 回退」，不是「Linux 二进制硬配上去」）。
 */
final class PlatformKeyTest {
    @Test
    void normalizesCommonJvmSpellings() {
        assertEquals("linux-x64", PlatformKey.detect("Linux", "amd64"));
        assertEquals("linux-x64", PlatformKey.detect("Linux", "x86_64"));
        assertEquals("linux-x64", PlatformKey.detect("Linux", "X64"));
        assertEquals("linux-arm64", PlatformKey.detect("Linux", "aarch64"));
        assertEquals("linux-arm64", PlatformKey.detect("Linux", "arm64"));
        assertEquals("win-x64", PlatformKey.detect("Windows 11", "amd64"));
        assertEquals("win-x64", PlatformKey.detect("Windows Server 2022", "x86_64"));
        assertEquals("win-arm64", PlatformKey.detect("Windows 10", "aarch64"));
    }

    @Test
    void unknownOsOrArchReturnsNull() {
        assertNull(PlatformKey.detect("Mac OS X", "aarch64"), "macOS 本期不随包，必须回落 PATH node");
        assertNull(PlatformKey.detect("Darwin", "x86_64"));
        assertNull(PlatformKey.detect("FreeBSD", "amd64"));
        assertNull(PlatformKey.detect("Linux", "ppc64le"));
        assertNull(PlatformKey.detect("Linux", "riscv64"));
        assertNull(PlatformKey.detect("", ""));
        assertNull(PlatformKey.detect(null, null));
    }

    @Test
    void isWindowsOnlyMatchesWinKeys() {
        assertTrue(PlatformKey.isWindows("win-x64"));
        assertTrue(PlatformKey.isWindows("win-arm64"));
        assertFalse(PlatformKey.isWindows("linux-x64"));
        assertFalse(PlatformKey.isWindows(null));
    }

    @Test
    void knownExposesAllMatrixKeysSorted() {
        assertEquals(
                Arrays.asList("linux-arm64", "linux-x64", "win-arm64", "win-x64"),
                new java.util.ArrayList<>(PlatformKey.known()));
    }

    @Test
    void detectWithRealJvmEitherMatchesMatrixOrIsNull() {
        String key = PlatformKey.detect();
        if (key != null) {
            assertTrue(PlatformKey.known().contains(key), "真实 JVM 键必须在矩阵内：" + key);
        }
    }
}
