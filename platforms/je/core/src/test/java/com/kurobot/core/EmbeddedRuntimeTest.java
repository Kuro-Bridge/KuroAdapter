package com.kurobot.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * EmbeddedRuntime 单测：内存 ResourceSource + @TempDir，覆盖幂等复用、损坏重建、
 * zip slip 防护与 manifest 校验（MVP 阶段二任务书 §3 阶段 2）。
 */
final class EmbeddedRuntimeTest {
    @TempDir
    Path tempDir;

    private final List<String> logs = new ArrayList<>();

    /** 内存资源源：manifest 按 files 的 sha256 现算（与 scripts/embed.ts 的产物形状一致）。 */
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

    private static String sha256(byte[] data) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static byte[] manifestOf(Map<String, byte[]> files) {
        StringBuilder json = new StringBuilder("{\"nodeVersion\":\"26.7.0-test\",\"files\":{");
        for (Map.Entry<String, byte[]> entry : files.entrySet()) {
            if (json.charAt(json.length() - 1) != '{') {
                json.append(',');
            }
            json.append("\"")
                    .append(entry.getKey())
                    .append("\":\"")
                    .append(sha256(entry.getValue()))
                    .append("\"");
        }
        return json.append("}}").toString().getBytes(StandardCharsets.UTF_8);
    }

    private InMemorySource standardSource() {
        InMemorySource source = new InMemorySource();
        source.resources.put(
                "manifest.json",
                manifestOf(Map.of(
                        "node.exe", "fake-node-exe".getBytes(StandardCharsets.UTF_8),
                        "index.mjs", "fake-bundle".getBytes(StandardCharsets.UTF_8),
                        "NODE_LICENSE", "fake-license".getBytes(StandardCharsets.UTF_8))));
        source.resources.put("node.exe", "fake-node-exe".getBytes(StandardCharsets.UTF_8));
        source.resources.put("index.mjs", "fake-bundle".getBytes(StandardCharsets.UTF_8));
        source.resources.put("NODE_LICENSE", "fake-license".getBytes(StandardCharsets.UTF_8));
        return source;
    }

    @Test
    void installExtractsAllMissingFiles() throws IOException {
        EmbeddedRuntime.Installed installed = EmbeddedRuntime.install(tempDir, standardSource(), logs::add);

        assertEquals("fake-node-exe", Files.readString(installed.nodeExecutable()));
        assertEquals("fake-bundle", Files.readString(installed.bundle()));
        assertTrue(installed.nodeExecutable().getParent().equals(tempDir));
        assertTrue(logs.stream().anyMatch(line -> line.contains("缺失，从 JAR 解压：node.exe")));
        assertTrue(logs.stream().anyMatch(line -> line.contains("解压 3 / 复用 0")));
        assertTrue(logs.stream().anyMatch(line -> line.contains("node 26.7.0-test")));
    }

    @Test
    void installReusesMatchingFilesOnSecondRun() throws IOException {
        EmbeddedRuntime.install(tempDir, standardSource(), logs::add);
        logs.clear();
        EmbeddedRuntime.install(tempDir, standardSource(), logs::add);

        assertTrue(logs.stream().anyMatch(line -> line.contains("复用（sha256 一致）")));
        assertTrue(logs.stream().noneMatch(line -> line.contains("解压：") || line.contains("重新解压")));
        assertTrue(logs.stream().anyMatch(line -> line.contains("解压 0 / 复用 3")));
    }

    @Test
    void installRebuildsCorruptedFile() throws IOException {
        EmbeddedRuntime.Installed installed = EmbeddedRuntime.install(tempDir, standardSource(), logs::add);
        Files.writeString(installed.nodeExecutable(), "corrupted");
        logs.clear();

        EmbeddedRuntime.install(tempDir, standardSource(), logs::add);

        assertEquals("fake-node-exe", Files.readString(installed.nodeExecutable()));
        assertTrue(
                logs.stream().anyMatch(line -> line.contains("检测到打包内容变更（升级），已重建") && line.contains("node.exe")),
                "哈希不符重建应有升级提示文案，实际：" + logs);
    }

    @Test
    void installRejectsPathTraversalNames() throws IOException {
        InMemorySource source = standardSource();
        byte[] evil = "evil".getBytes(StandardCharsets.UTF_8);
        // 在合法产物之外塞入越权名（含 node.exe/index.mjs，先过 requireProduct 再命中名字校验）
        source.resources.put(
                "manifest.json",
                manifestOf(Map.of(
                        "../evil", evil,
                        "node.exe", "fake-node-exe".getBytes(StandardCharsets.UTF_8),
                        "index.mjs", "fake-bundle".getBytes(StandardCharsets.UTF_8),
                        "NODE_LICENSE", "fake-license".getBytes(StandardCharsets.UTF_8))));
        source.resources.put("../evil", evil);

        IOException e = assertThrows(IOException.class, () -> EmbeddedRuntime.install(tempDir, source, logs::add));
        assertTrue(e.getMessage().contains("非法文件名"));
        assertTrue(e.getMessage().contains("../evil"));
        try (var entries = Files.list(tempDir)) {
            assertEquals(0, entries.count());
        }
    }

    @Test
    void installRejectsSubDirectoryNames() throws IOException {
        InMemorySource source = standardSource();
        byte[] nested = "nested".getBytes(StandardCharsets.UTF_8);
        source.resources.put(
                "manifest.json",
                manifestOf(Map.of(
                        "sub/dir.txt", nested,
                        "node.exe", "fake-node-exe".getBytes(StandardCharsets.UTF_8),
                        "index.mjs", "fake-bundle".getBytes(StandardCharsets.UTF_8),
                        "NODE_LICENSE", "fake-license".getBytes(StandardCharsets.UTF_8))));
        source.resources.put("sub/dir.txt", nested);

        IOException e = assertThrows(IOException.class, () -> EmbeddedRuntime.install(tempDir, source, logs::add));
        assertTrue(e.getMessage().contains("非法文件名"));
        // 名字校验前置：整个 manifest 被拒绝，未落任何文件
        try (var entries = Files.list(tempDir)) {
            assertEquals(0, entries.count());
        }
    }

    @Test
    void installRejectsResourceHashMismatch() throws IOException {
        InMemorySource source = new InMemorySource();
        // manifest 声明的 sha 与资源实际内容不符（模拟 JAR 损坏）
        String manifest = "{\"nodeVersion\":\"26.7.0-test\",\"files\":{"
                + "\"node.exe\":\"" + "0".repeat(64) + "\","
                + "\"index.mjs\":\"" + "0".repeat(64) + "\"}}";
        source.resources.put("manifest.json", manifest.getBytes(StandardCharsets.UTF_8));
        source.resources.put("node.exe", "real-content".getBytes(StandardCharsets.UTF_8));
        source.resources.put("index.mjs", "real-bundle".getBytes(StandardCharsets.UTF_8));

        IOException e = assertThrows(IOException.class, () -> EmbeddedRuntime.install(tempDir, source, logs::add));
        assertTrue(e.getMessage().contains("sha256 与 manifest 不符"));
        // tmp 已回滚清理，目录里没有残留
        try (var entries = Files.list(tempDir)) {
            assertEquals(0, entries.count());
        }
    }

    @Test
    void installRequiresNodeExeAndBundleEntries() throws IOException {
        InMemorySource source = new InMemorySource();
        String manifest = "{\"nodeVersion\":\"26.7.0-test\",\"files\":{\"node.exe\":\"" + "0".repeat(64) + "\"}}";
        source.resources.put("manifest.json", manifest.getBytes(StandardCharsets.UTF_8));

        IOException e = assertThrows(IOException.class, () -> EmbeddedRuntime.install(tempDir, source, logs::add));
        assertTrue(e.getMessage().contains("缺少产物条目：index.mjs"));
    }

    @Test
    void installRejectsMalformedManifest() throws IOException {
        InMemorySource source = new InMemorySource();
        source.resources.put("manifest.json", "not-json{".getBytes(StandardCharsets.UTF_8));

        assertThrows(IOException.class, () -> EmbeddedRuntime.install(tempDir, source, logs::add));
    }

    // ---- MVP-4：napuketto 嵌包展开 ----

    /** 造嵌包 zip（entry: a/pkg/f.txt + b.js）与带 napukettoZip 指针的 manifest 源。 */
    private InMemorySource napukettoSource(String zipContentMarker) throws IOException {
        byte[] zipBytes = napukettoZip(zipContentMarker);
        InMemorySource source = new InMemorySource();
        source.resources.put(
                "manifest.json",
                manifestWithNapuketto(
                        Map.of(
                                "node.exe", "fake-node-exe".getBytes(StandardCharsets.UTF_8),
                                "index.mjs", "fake-bundle".getBytes(StandardCharsets.UTF_8),
                                "napuketto.zip", zipBytes),
                        sha256(zipBytes)));
        source.resources.put("node.exe", "fake-node-exe".getBytes(StandardCharsets.UTF_8));
        source.resources.put("index.mjs", "fake-bundle".getBytes(StandardCharsets.UTF_8));
        source.resources.put("napuketto.zip", zipBytes);
        return source;
    }

    private static byte[] napukettoZip(String contentMarker) throws IOException {
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        try (java.util.zip.ZipOutputStream zip = new java.util.zip.ZipOutputStream(buffer)) {
            zip.putNextEntry(new java.util.zip.ZipEntry("node_modules/@napuketto/cli/dist/index.mjs"));
            zip.write(("cli entry " + contentMarker).getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
            zip.putNextEntry(new java.util.zip.ZipEntry("node_modules/zod/package.json"));
            zip.write("{\"name\":\"zod\"}".getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
        }
        return buffer.toByteArray();
    }

    private static byte[] manifestWithNapuketto(Map<String, byte[]> files, String napukettoSha) {
        StringBuilder json = new StringBuilder("{\"nodeVersion\":\"26.7.0-test\",\"files\":{");
        for (Map.Entry<String, byte[]> entry : files.entrySet()) {
            if (json.charAt(json.length() - 1) != '{') {
                json.append(',');
            }
            json.append("\"")
                    .append(entry.getKey())
                    .append("\":\"")
                    .append(sha256(entry.getValue()))
                    .append("\"");
        }
        json.append("},\"napukettoZip\":{\"name\":\"napuketto.zip\",\"sha256\":\"")
                .append(napukettoSha)
                .append("\",\"cliVersion\":\"0.1.17\"}}");
        return json.toString().getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void installExpandsNapukettoZipWithSentinel() throws IOException {
        InMemorySource source = napukettoSource("v1");
        EmbeddedRuntime.install(tempDir, source, logs::add);

        Path cliEntry = tempDir.resolve("napuketto/node_modules/@napuketto/cli/dist/index.mjs");
        assertTrue(Files.isRegularFile(cliEntry));
        assertTrue(Files.readString(cliEntry).endsWith("v1"));
        assertTrue(Files.isRegularFile(tempDir.resolve("napuketto/node_modules/zod/package.json")));
        String sentinel = Files.readString(tempDir.resolve("napuketto/.kurobot-install.json"));
        assertTrue(sentinel.contains("sha256"));
        assertTrue(logs.stream().anyMatch(line -> line.contains("napuketto 嵌包展开完成")));
    }

    @Test
    void installReusesNapukettoWhenSentinelShaMatches() throws IOException {
        InMemorySource source = napukettoSource("v1");
        EmbeddedRuntime.install(tempDir, source, logs::add);
        logs.clear();

        EmbeddedRuntime.install(tempDir, source, logs::add);

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
        byte[] evilZip;
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        try (java.util.zip.ZipOutputStream zip = new java.util.zip.ZipOutputStream(buffer)) {
            zip.putNextEntry(new java.util.zip.ZipEntry("../evil.txt"));
            zip.write("evil".getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
        }
        evilZip = buffer.toByteArray();
        InMemorySource source = new InMemorySource();
        source.resources.put(
                "manifest.json",
                manifestWithNapuketto(
                        Map.of(
                                "node.exe", "fake-node-exe".getBytes(StandardCharsets.UTF_8),
                                "index.mjs", "fake-bundle".getBytes(StandardCharsets.UTF_8),
                                "napuketto.zip", evilZip),
                        sha256(evilZip)));
        source.resources.put("node.exe", "fake-node-exe".getBytes(StandardCharsets.UTF_8));
        source.resources.put("index.mjs", "fake-bundle".getBytes(StandardCharsets.UTF_8));
        source.resources.put("napuketto.zip", evilZip);

        IOException e = assertThrows(IOException.class, () -> EmbeddedRuntime.install(tempDir, source, logs::add));
        assertTrue(e.getMessage().contains("逃出目标目录"));
    }
}
