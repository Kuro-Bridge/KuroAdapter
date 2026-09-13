package com.kurobot.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * JAR 内 embedded 资源 → 磁盘 bin 目录的解压加载链（MVP 阶段二，ADR-014「node.exe 进 JAR」的
 * 运行期半边；构建期半边是 scripts/embed.ts）。
 *
 * <p>策略（幂等，支持版本升级覆盖）：
 * <ul>
 *   <li>逐文件比对 sha256（对照 JAR 内 manifest.json）：一致 → 复用，不触碰磁盘。</li>
 *   <li>缺失或哈希不符 → 从资源流解压（tmp 文件 + 原子 move；拷贝中 DigestInputStream 校验
 *       sha256，不符即失败回滚）。</li>
 *   <li>只在插件启动路径调用（node.exe 此时必然未运行，无文件占用问题），无运行期覆盖逻辑。</li>
 * </ul>
 *
 * <p>防 zip slip：manifest 的文件名必须匹配 {@link #SAFE_NAME}（单段、无路径分隔符、无 {@code ..}），
 * 且 resolve+normalize 后仍须落在 bin 目录内（双保险）。资源按固定名读取（不枚举 zip entry），
 * 不存在 entry 名注入面。
 *
 * <p>零 Bukkit API（:core 模块纪律）；资源读取经 {@link ResourceSource} 注入（:paper 传
 * classloader，测试传内存映射）。日志经注入的 {@code log} 消费者输出（无级别前缀，由宿主定级）。
 */
public final class EmbeddedRuntime {
    /** manifest 允许的文件名：单段、字母数字与 ._-、不以点开头（杜绝 ../ 与分隔符注入）。 */
    private static final Pattern SAFE_NAME = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]*");

    private static final String MANIFEST_NAME = "manifest.json";
    private static final String FILE_NODE_EXE = "node.exe";
    private static final String FILE_BUNDLE = "index.mjs";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** 资源源：名字 → 内容流（名字不含 {@code embedded/} 前缀；不存在须抛 IOException）。 */
    @FunctionalInterface
    public interface ResourceSource {
        InputStream open(String name) throws IOException;
    }

    /** 安装结果：node 可执行文件与 bundle 的磁盘路径（绝对路径）+ manifest 声明的 node 版本。 */
    public record Installed(Path nodeExecutable, Path bundle, String nodeVersion) {}

    /** manifest 内容：node 版本（仅日志展示）与 文件名 → sha256。 */
    private record Manifest(String nodeVersion, TreeMap<String, String> files) {}

    private EmbeddedRuntime() {}

    /**
     * 安装 embedded 运行时到 bin 目录。
     *
     * @param binDir 目标目录（如 {@code plugins/kurobot/bin}；不存在则创建）
     * @param source JAR 资源源（名字 → 流，{@code embedded/} 前缀由实现方处理）
     * @param log 进度日志消费者（复用/解压/哈希不符均逐条输出）
     * @return node.exe 与 index.mjs 的磁盘路径
     * @throws IOException manifest 缺失/损坏、文件名校验不过、资源哈希不符或磁盘读写失败
     */
    public static Installed install(Path binDir, ResourceSource source, Consumer<String> log) throws IOException {
        Manifest manifest = readManifest(source);
        requireProduct(manifest, FILE_NODE_EXE);
        requireProduct(manifest, FILE_BUNDLE);
        Path normalizedBin = binDir.toAbsolutePath().normalize();
        Files.createDirectories(normalizedBin);

        // 名字校验整体前置：任何越权名都在触碰磁盘前拒绝（不产生部分解压）
        TreeMap<String, Path> targets = new TreeMap<>();
        for (String name : manifest.files().keySet()) {
            targets.put(name, safeTarget(normalizedBin, name));
        }

        int extracted = 0;
        int reused = 0;
        for (Map.Entry<String, String> entry : manifest.files().entrySet()) {
            String name = entry.getKey();
            Path target = targets.get(name);
            if (Files.isRegularFile(target) && sha256(target).equals(entry.getValue())) {
                reused++;
                log.accept("embedded 文件已就绪，复用（sha256 一致）：" + name);
                continue;
            }
            if (Files.exists(target)) {
                log.accept("检测到打包内容变更（升级），已重建 plugins/kurobot/bin 内文件：" + name);
            } else {
                log.accept("embedded 文件缺失，从 JAR 解压：" + name);
            }
            extract(source, name, target, entry.getValue());
            extracted++;
        }
        log.accept("embedded 运行时就绪（node " + manifest.nodeVersion() + "）：解压 " + extracted + " / 复用 " + reused + " → "
                + normalizedBin);
        return new Installed(targets.get(FILE_NODE_EXE), targets.get(FILE_BUNDLE), manifest.nodeVersion());
    }

    private static Manifest readManifest(ResourceSource source) throws IOException {
        byte[] manifestBytes;
        try (InputStream in = source.open(MANIFEST_NAME)) {
            manifestBytes = in.readAllBytes();
        }
        JsonNode root = MAPPER.readTree(manifestBytes);
        JsonNode filesNode = root.get("files");
        if (filesNode == null || !filesNode.isObject()) {
            throw new IOException("embedded/manifest.json 缺少 files 对象");
        }
        TreeMap<String, String> files = new TreeMap<>();
        filesNode
                .fields()
                .forEachRemaining(
                        field -> files.put(field.getKey(), field.getValue().asText()));
        JsonNode version = root.get("nodeVersion");
        return new Manifest(version == null ? "?" : version.asText("?"), files);
    }

    private static void requireProduct(Manifest manifest, String name) throws IOException {
        if (!manifest.files().containsKey(name)) {
            throw new IOException("embedded/manifest.json 缺少产物条目：" + name);
        }
    }

    /** 校验文件名并解析目标路径；不合法或逃出 bin 目录 → IOException（防 zip slip）。 */
    private static Path safeTarget(Path binDir, String name) throws IOException {
        if (!SAFE_NAME.matcher(name).matches()) {
            throw new IOException("manifest 含非法文件名（疑似路径注入）：" + name);
        }
        Path target = binDir.resolve(name).normalize();
        if (!target.getParent().equals(binDir)) {
            throw new IOException("manifest 文件名解析后逃出 bin 目录：" + name);
        }
        return target;
    }

    /** 从资源流解压到 tmp，DigestInputStream 校验 sha256 后原子替换目标。 */
    private static void extract(ResourceSource source, String name, Path target, String expectedSha)
            throws IOException {
        Path tmp = target.resolveSibling(target.getFileName() + ".tmp");
        MessageDigest digest = sha256Digest();
        try (InputStream resource = source.open(name)) {
            DigestInputStream in = new DigestInputStream(resource, digest);
            Files.copy(in, tmp, StandardCopyOption.REPLACE_EXISTING);
        }
        String actual = HexFormat.of().formatHex(digest.digest());
        if (!actual.equals(expectedSha)) {
            Files.deleteIfExists(tmp);
            throw new IOException("资源 sha256 与 manifest 不符（JAR 损坏？）：" + name);
        }
        try {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException atomicUnsupported) {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static String sha256(Path file) throws IOException {
        MessageDigest digest = sha256Digest();
        try (InputStream in = Files.newInputStream(file)) {
            byte[] buffer = new byte[8192];
            for (int read; (read = in.read(buffer)) != -1; ) {
                digest.update(buffer, 0, read);
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private static MessageDigest sha256Digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("JVM 缺少 SHA-256 实现", e);
        }
    }
}
