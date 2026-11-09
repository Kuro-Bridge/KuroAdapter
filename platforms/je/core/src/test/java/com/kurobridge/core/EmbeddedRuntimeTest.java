package com.kurobridge.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * EmbeddedRuntime 单测（manifest v2 / 多平台矩阵）：内存 ResourceSource + @TempDir，覆盖
 * 平台选择、共享文件幂等复用、损坏重建、zip slip 防护、manifest 校验与 napuketto 展开。
 */
final class EmbeddedRuntimeTest {
    @TempDir
    Path tempDir;

    private final List<String> logs = new ArrayList<>();

    @BeforeEach
    void requireKnownPlatform() {
        Assumptions.assumeTrue(PlatformKey.detect() != null, "当前测试机平台不在内嵌矩阵内（macOS/陌生架构），跳过解包链单测");
    }

    /** 内存资源源：manifest 按 shared/runtimes 的 sha256 现算（与 embed.ts 产物形状一致）。 */
    private static final class InMemorySource implements EmbeddedRuntime.ResourceSource {
        private final Map<String, byte[]> resources = new TreeMap<>();

        @Override
        public InputStream open(String name) throws IOException {
            byte[] data = resources.get(name);
            if (data == null) {
                throw new IOException("测试资源不存在：" + name);
            }
            return new ByteArrayInputStream(data);
        }
    }

    private static byte[] utf8(String value) {
        return value.getBytes(StandardCharsets.UTF_8);
    }

    private static String sha256(byte[] data) {
        try {
            return java.util.HexFormat.of()
                    .formatHex(MessageDigest.getInstance("SHA-256").digest(data));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String currentKey() {
        return PlatformKey.detect();
    }

    /** 与 embed.ts 的 productName 对齐：Windows 带 .exe 后缀，Linux 无后缀。 */
    private static String productName(String key) {
        return key.startsWith("win-") ? "node-" + key + ".exe" : "node-" + key;
    }

    private static void appendFileHashes(StringBuilder json, Map<String, byte[]> files) {
        boolean first = true;
        for (Map.Entry<String, byte[]> entry : files.entrySet()) {
            if (!first) {
                json.append(',');
            }
            first = false;
            json.append('"')
                    .append(entry.getKey())
                    .append("\":\"")
                    .append(sha256(entry.getValue()))
                    .append('"');
        }
    }

    private static byte[] manifestV2(Map<String, byte[]> shared, Map<String, byte[]> runtimes, String napukettoSha) {
        StringBuilder json = new StringBuilder("{\"schemaVersion\":2,\"nodeVersion\":\"26.13.0-test\",\"shared\":{");
        appendFileHashes(json, shared);
        json.append("},\"runtimes\":{");
        boolean first = true;
        for (Map.Entry<String, byte[]> entry : runtimes.entrySet()) {
            if (!first) {
                json.append(',');
            }
            first = false;
            json.append('"')
                    .append(entry.getKey())
                    .append("\":{\"file\":\"")
                    .append(productName(entry.getKey()))
                    .append("\",\"sha256\":\"")
                    .append(sha256(entry.getValue()))
                    .append("\"}");
        }
        json.append('}');
        if (napukettoSha != null) {
            json.append(",\"napukettoZip\":{\"name\":\"napuketto.zip\",\"sha256\":\"")
                    .append(napukettoSha)
                    .append("\",\"cliVersion\":\"0.2.0\"}");
        }
        return json.append('}').toString().getBytes(StandardCharsets.UTF_8);
    }

    private InMemorySource source(Map<String, byte[]> shared, Map<String, byte[]> runtimes, String napukettoSha) {
        InMemorySource source = new InMemorySource();
        source.resources.put("manifest.json", manifestV2(shared, runtimes, napukettoSha));
        shared.forEach(source.resources::put);
        runtimes.forEach((key, data) -> source.resources.put(productName(key), data));
        return source;
    }

    private static Map<String, byte[]> sharedFiles() {
        Map<String, byte[]> shared = new LinkedHashMap<>();
        shared.put("index.mjs", utf8("fake-bundle"));
        shared.put("NODE_LICENSE", utf8("fake-license"));
        return shared;
    }

    private static Map<String, byte[]> currentRuntimes() {
        Map<String, byte[]> runtimes = new LinkedHashMap<>();
        runtimes.put(currentKey(), utf8("fake-node"));
        return runtimes;
    }

    private InMemorySource standardSource() {
        return source(sharedFiles(), currentRuntimes(), null);
    }

    @Test
    void installExtractsSharedAndOnlyCurrentPlatformRuntime() throws IOException {
        EmbeddedRuntime.Installed installed = EmbeddedRuntime.install(tempDir, standardSource(), logs::add);

        assertEquals("fake-node", Files.readString(installed.nodeExecutable()));
        assertEquals("fake-bundle", Files.readString(installed.bundle()));
        assertEquals(currentKey(), installed.platformKey());
        assertEquals(
                productName(currentKey()),
                installed.nodeExecutable().getFileName().toString());
        assertTrue(logs.stream().anyMatch(line -> line.contains("缺失，从 JAR 解压：index.mjs")));
        assertTrue(logs.stream().anyMatch(line -> line.contains("解压 3 / 复用 0")));
        assertTrue(logs.stream().anyMatch(line -> line.contains("node 26.13.0-test / " + currentKey())));
    }

    @Test
    void installSkipsForeignPlatformBinaries() throws IOException {
        String foreignKey = "linux-x64".equals(currentKey()) ? "win-x64" : "linux-x64";
        Map<String, byte[]> runtimes = new LinkedHashMap<>();
        runtimes.put(currentKey(), utf8("current-node"));
        runtimes.put(foreignKey, utf8("foreign-node"));

        EmbeddedRuntime.install(tempDir, source(sharedFiles(), runtimes, null), logs::add);

        assertTrue(Files.isRegularFile(tempDir.resolve(productName(currentKey()))));
        assertFalse(Files.exists(tempDir.resolve(productName(foreignKey))), "非当前平台的二进制不应被解压（Universal JAR 只铺命中那一份）");
    }

    @Test
    void installReusesMatchingFilesOnSecondRun() throws IOException {
        EmbeddedRuntime.install(tempDir, standardSource(), logs::add);
        logs.clear();
        EmbeddedRuntime.install(tempDir, standardSource(), logs::add);

        assertTrue(logs.stream().anyMatch(line -> line.contains("复用（sha256 一致）")));
        assertTrue(logs.stream().noneMatch(line -> line.contains("解压：")));
        assertTrue(logs.stream().anyMatch(line -> line.contains("解压 0 / 复用 3")));
    }

    @Test
    void installRebuildsCorruptedRuntime() throws IOException {
        EmbeddedRuntime.Installed installed = EmbeddedRuntime.install(tempDir, standardSource(), logs::add);
        Files.writeString(installed.nodeExecutable(), "corrupted");
        logs.clear();

        EmbeddedRuntime.install(tempDir, standardSource(), logs::add);

        assertEquals("fake-node", Files.readString(installed.nodeExecutable()));
        assertTrue(
                logs.stream()
                        .anyMatch(
                                line -> line.contains("检测到打包内容变更（升级），已重建") && line.contains(productName(currentKey()))),
                "哈希不符重建应有升级提示文案，实际：" + logs);
    }

    @Test
    void installRejectsPathTraversalNamesInShared() throws IOException {
        Map<String, byte[]> shared = sharedFiles();
        shared.put("../evil", utf8("evil"));

        IOException e = assertThrows(
                IOException.class,
                () -> EmbeddedRuntime.install(tempDir, source(shared, currentRuntimes(), null), logs::add));
        assertTrue(e.getMessage().contains("非法文件名"));
        assertTrue(e.getMessage().contains("../evil"));
        try (var entries = Files.list(tempDir)) {
            assertEquals(0, entries.count(), "名字校验必须整体前置，不落任何文件");
        }
    }

    @Test
    void installRejectsSubDirectoryNames() throws IOException {
        Map<String, byte[]> shared = sharedFiles();
        shared.put("sub/dir.txt", utf8("nested"));

        IOException e = assertThrows(
                IOException.class,
                () -> EmbeddedRuntime.install(tempDir, source(shared, currentRuntimes(), null), logs::add));
        assertTrue(e.getMessage().contains("非法文件名"));
        try (var entries = Files.list(tempDir)) {
            assertEquals(0, entries.count());
        }
    }

    @Test
    void installRejectsRuntimeFileWithPathSeparator() throws IOException {
        InMemorySource source = new InMemorySource();
        String json = "{\"schemaVersion\":2,\"nodeVersion\":\"test\",\"shared\":{\"index.mjs\":\""
                + sha256(utf8("bundle"))
                + "\"},\"runtimes\":{\""
                + currentKey()
                + "\":{\"file\":\"../node\",\"sha256\":\""
                + sha256(utf8("node"))
                + "\"}}}";
        source.resources.put("manifest.json", utf8(json));
        source.resources.put("index.mjs", utf8("bundle"));
        source.resources.put("../node", utf8("node"));

        IOException e = assertThrows(IOException.class, () -> EmbeddedRuntime.install(tempDir, source, logs::add));
        assertTrue(e.getMessage().contains("非法文件名"));
    }

    @Test
    void installRejectsResourceHashMismatch() throws IOException {
        InMemorySource source = new InMemorySource();
        String zero = "0".repeat(64);
        String json = "{\"schemaVersion\":2,\"nodeVersion\":\"test\",\"shared\":{\"index.mjs\":\""
                + zero
                + "\"},\"runtimes\":{\""
                + currentKey()
                + "\":{\"file\":\""
                + productName(currentKey())
                + "\",\"sha256\":\""
                + zero
                + "\"}}}";
        source.resources.put("manifest.json", utf8(json));
        source.resources.put("index.mjs", utf8("real-content"));
        source.resources.put(productName(currentKey()), utf8("real-node"));

        IOException e = assertThrows(IOException.class, () -> EmbeddedRuntime.install(tempDir, source, logs::add));
        assertTrue(e.getMessage().contains("sha256 与 manifest 不符"));
        try (var entries = Files.list(tempDir)) {
            assertEquals(0, entries.count(), "tmp 已回滚清理，目录里没有残留");
        }
    }

    @Test
    void installRequiresBundleEntry() throws IOException {
        Map<String, byte[]> shared = new LinkedHashMap<>();
        shared.put("NODE_LICENSE", utf8("license"));
        IOException e = assertThrows(
                IOException.class,
                () -> EmbeddedRuntime.install(tempDir, source(shared, currentRuntimes(), null), logs::add));
        assertTrue(e.getMessage().contains("缺少共享产物条目：index.mjs"));
    }

    @Test
    void installRejectsMalformedManifest() {
        InMemorySource source = new InMemorySource();
        source.resources.put("manifest.json", utf8("not-json{"));
        assertThrows(IOException.class, () -> EmbeddedRuntime.install(tempDir, source, logs::add));
    }

    @Test
    void installRejectsLegacySchemaVersion() {
        InMemorySource source = new InMemorySource();
        source.resources.put(
                "manifest.json",
                utf8("{\"nodeVersion\":\"26.7.0\",\"files\":{\"node.exe\":\"" + "0".repeat(64) + "\"}}"));
        IOException e = assertThrows(IOException.class, () -> EmbeddedRuntime.install(tempDir, source, logs::add));
        assertTrue(e.getMessage().contains("schemaVersion 必须为 2"), "旧版 manifest 必须显式失败：" + e.getMessage());
    }

    @Test
    void installReportsUnsupportedPlatformWithAvailableKeys() {
        Map<String, byte[]> runtimes = new LinkedHashMap<>();
        runtimes.put("plan9-x64", utf8("alien-node"));
        EmbeddedRuntime.UnsupportedPlatformException e = assertThrows(
                EmbeddedRuntime.UnsupportedPlatformException.class,
                () -> EmbeddedRuntime.install(tempDir, source(sharedFiles(), runtimes, null), logs::add));
        assertEquals(currentKey(), e.platformKey());
        assertTrue(e.available().contains("plan9-x64"));
        assertTrue(e.getMessage().contains("KUROBRIDGE_NODE"), "错误信息必须给出回退开关：" + e.getMessage());
    }

    // ---- 可执行位（POSIX）----

    @Test
    void makeExecutableAddsExecuteBitsAndIsIdempotent() throws IOException {
        Assumptions.assumeTrue(
                tempDir.getFileSystem().supportedFileAttributeViews().contains("posix"),
                "非 POSIX 文件系统（Windows）不涉及可执行位");
        Path file = tempDir.resolve("node-linux-x64");
        Files.writeString(file, "binary");

        EmbeddedRuntime.makeExecutable(file, logs::add);
        Set<PosixFilePermission> permissions = Files.getPosixFilePermissions(file);
        assertTrue(permissions.contains(PosixFilePermission.OWNER_EXECUTE));
        assertTrue(permissions.contains(PosixFilePermission.GROUP_EXECUTE));
        assertTrue(permissions.contains(PosixFilePermission.OTHERS_EXECUTE));

        logs.clear();
        EmbeddedRuntime.makeExecutable(file, logs::add);
        assertTrue(logs.isEmpty(), "已可执行时不应重复 chmod（幂等，零噪音）：" + logs);
    }

    // ---- MVP-4：napuketto 嵌包展开（与平台无关）----

    private InMemorySource napukettoSource(String zipContentMarker) throws IOException {
        byte[] zipBytes = napukettoZip(zipContentMarker);
        Map<String, byte[]> shared = sharedFiles();
        shared.put("napuketto.zip", zipBytes);
        return source(shared, currentRuntimes(), sha256(zipBytes));
    }

    private static byte[] napukettoZip(String contentMarker) throws IOException {
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        try (java.util.zip.ZipOutputStream zip = new java.util.zip.ZipOutputStream(buffer)) {
            zip.putNextEntry(new java.util.zip.ZipEntry("node_modules/@napuketto/cli/dist/index.mjs"));
            zip.write(utf8("cli entry " + contentMarker));
            zip.closeEntry();
            zip.putNextEntry(new java.util.zip.ZipEntry("node_modules/zod/package.json"));
            zip.write(utf8("{\"name\":\"zod\"}"));
            zip.closeEntry();
        }
        return buffer.toByteArray();
    }

    @Test
    void installExpandsNapukettoZipOnEveryPlatform() throws IOException {
        EmbeddedRuntime.install(tempDir, napukettoSource("v1"), logs::add);

        Path cliEntry = tempDir.resolve("napuketto/node_modules/@napuketto/cli/dist/index.mjs");
        assertTrue(Files.isRegularFile(cliEntry), "napuketto 解包与平台无关（Linux 也照常展开）");
        assertTrue(Files.readString(cliEntry).endsWith("v1"));
        assertTrue(Files.isRegularFile(tempDir.resolve("napuketto/node_modules/zod/package.json")));
        String sentinel = Files.readString(tempDir.resolve("napuketto/.kurobridge-install.json"));
        assertTrue(sentinel.contains("sha256"));
        assertTrue(logs.stream().anyMatch(line -> line.contains("napuketto 嵌包展开完成")));
    }

    @Test
    void installReusesNapukettoWhenSentinelShaMatches() throws IOException {
        EmbeddedRuntime.install(tempDir, napukettoSource("v1"), logs::add);
        logs.clear();

        EmbeddedRuntime.install(tempDir, napukettoSource("v1"), logs::add);

        assertTrue(logs.stream().anyMatch(line -> line.contains("napuketto 嵌包已就绪，复用")));
        assertTrue(logs.stream().noneMatch(line -> line.contains("napuketto 嵌包展开完成")));
    }

    @Test
    void installRebuildsNapukettoOnZipChange() throws IOException {
        EmbeddedRuntime.install(tempDir, napukettoSource("v1"), logs::add);
        logs.clear();

        EmbeddedRuntime.install(tempDir, napukettoSource("v2"), logs::add);

        Path cliEntry = tempDir.resolve("napuketto/node_modules/@napuketto/cli/dist/index.mjs");
        assertTrue(Files.readString(cliEntry).endsWith("v2"));
        assertTrue(logs.stream().anyMatch(line -> line.contains("napuketto 嵌包变更（升级）")));
    }

    @Test
    void installRejectsZipSlipEntry() throws IOException {
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        try (java.util.zip.ZipOutputStream zip = new java.util.zip.ZipOutputStream(buffer)) {
            zip.putNextEntry(new java.util.zip.ZipEntry("../evil.txt"));
            zip.write(utf8("evil"));
            zip.closeEntry();
        }
        byte[] evilZip = buffer.toByteArray();
        Map<String, byte[]> shared = sharedFiles();
        shared.put("napuketto.zip", evilZip);

        IOException e = assertThrows(
                IOException.class,
                () -> EmbeddedRuntime.install(tempDir, source(shared, currentRuntimes(), sha256(evilZip)), logs::add));
        assertTrue(e.getMessage().contains("逃出目标目录"));
    }
}
