package com.kurobridge.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermission;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.Consumer;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * JAR 内 embedded 资源 → 磁盘 bin 目录的解压加载链（多平台矩阵版）。
 *
 * <p>manifest v2 分两段：{@code shared}（index.mjs / 许可 / napuketto.zip，与平台无关）与
 * {@code runtimes}（平台键 → 扁平二进制名 + sha256）。运行期按 {@link PlatformKey#detect()}
 * 只解压命中的那一个二进制——三平台 Universal JAR 不会把三份 node 全铺到磁盘。
 *
 * <p>策略（幂等，支持版本升级覆盖）：
 * <ul>
 *   <li>逐文件比对 sha256（对照 JAR 内 manifest.json）：一致 → 复用，不触碰磁盘。</li>
 *   <li>缺失或哈希不符 → 从资源流解压（tmp 文件 + 原子 move；拷贝中 DigestInputStream 校验
 *       sha256，不符即失败回滚）。</li>
 *   <li>POSIX 文件系统上每次都补 node 可执行位（幂等，约 0.1ms）：只在新解压后补不够——
 *       升级自旧包、备份还原、rsync 不带 -p、快照回滚都会让 sha256 一致但执行位丢失。</li>
 *   <li>只在插件启动路径调用（node 此时必然未运行，无文件占用问题），无运行期覆盖逻辑。</li>
 * </ul>
 *
 * <p>MVP-4（ADR-029）napuketto 嵌包：manifest 含 {@code napukettoZip} 指针时，把 zip 展开到
 * {@code bin/napuketto/node_modules/}。**这段与平台无关，Linux 也照常展开**——「Linux 暂不
 * 拉起 napuketto」是进程侧判据（bridge/embedded 的 decideNapukettoLaunch），不是解包侧的
 * 死胡同；上游发布 Linux 原生兼容后只需改进程侧一处。
 *
 * <p>防 zip slip（逐文件路径）：manifest 的文件名必须匹配 {@link #SAFE_NAME}（单段、无路径
 * 分隔符、无 {@code ..}），且 resolve+normalize 后仍须落在 bin 目录内（双保险）。资源按固定名
 * 读取（不枚举 zip entry），不存在 entry 名注入面。
 *
 * <p>零 Bukkit API（:core 模块纪律）；资源读取经 {@link ResourceSource} 注入（:paper 传
 * classloader，测试传内存映射）。日志经注入的 {@code log} 消费者输出（无级别前缀，由宿主定级）。
 */
public final class EmbeddedRuntime {
    /** manifest 允许的文件名：单段、字母数字与 ._-、不以点开头（杜绝 ../ 与分隔符注入）。 */
    private static final Pattern SAFE_NAME = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]*");

    private static final String MANIFEST_NAME = "manifest.json";
    private static final String FILE_BUNDLE = "index.mjs";
    private static final String FILE_NAPUKETTO_ZIP = "napuketto.zip";
    private static final String FILE_NAPUKETTO_DIR = "napuketto";
    private static final String FILE_NAPUKETTO_SENTINEL = ".kurobridge-install.json";
    private static final int MANIFEST_SCHEMA_VERSION = 2;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** 资源源：名字 → 内容流（名字不含 {@code embedded/} 前缀；不存在须抛 IOException）。 */
    @FunctionalInterface
    public interface ResourceSource {
        InputStream open(String name) throws IOException;
    }

    /** 安装结果：node 可执行文件与 bundle 的磁盘路径（绝对路径）+ manifest 声明的版本与平台键。 */
    public static final class Installed {
        private final Path nodeExecutable;
        private final Path bundle;
        private final String nodeVersion;
        private final String platformKey;

        Installed(Path nodeExecutable, Path bundle, String nodeVersion, String platformKey) {
            this.nodeExecutable = nodeExecutable;
            this.bundle = bundle;
            this.nodeVersion = nodeVersion;
            this.platformKey = platformKey;
        }

        public Path nodeExecutable() {
            return nodeExecutable;
        }

        public Path bundle() {
            return bundle;
        }

        public String nodeVersion() {
            return nodeVersion;
        }

        public String platformKey() {
            return platformKey;
        }
    }

    /** 当前平台在 manifest 的 runtimes 里没有条目（macOS / 陌生架构 / Lean JAR 缺平台）。 */
    public static final class UnsupportedPlatformException extends IOException {
        private static final long serialVersionUID = 1L;
        private final String platformKey;
        /** 非序列化视图（异常不跨进程序列化；-Xlint:serial 要求 transient）。 */
        private final transient Set<String> available;

        UnsupportedPlatformException(String platformKey, Set<String> available) {
            super("当前平台 " + (platformKey == null ? "(无法识别)" : platformKey) + " 没有内嵌运行时" + "（JAR 内可用：" + available
                    + "）；请改用含该平台运行时的 JAR，或以 KUROBRIDGE_BUNDLE + KUROBRIDGE_NODE 走开发覆盖形态");
            this.platformKey = platformKey;
            this.available = available;
        }

        public String platformKey() {
            return platformKey;
        }

        public Set<String> available() {
            return available;
        }
    }

    /** runtimes 的一段：JAR 内扁平文件名 + sha256。 */
    private static final class RuntimeEntry {
        private final String file;
        private final String sha256;

        RuntimeEntry(String file, String sha256) {
            this.file = file;
            this.sha256 = sha256;
        }

        String file() {
            return file;
        }

        String sha256() {
            return sha256;
        }
    }

    /** manifest 内容：共享文件表、平台运行时表、napuketto 嵌包 zip sha（可选）。 */
    private static final class Manifest {
        private final String nodeVersion;
        private final TreeMap<String, String> shared;
        private final TreeMap<String, RuntimeEntry> runtimes;
        private final String napukettoZipSha;

        Manifest(
                String nodeVersion,
                TreeMap<String, String> shared,
                TreeMap<String, RuntimeEntry> runtimes,
                String napukettoZipSha) {
            this.nodeVersion = nodeVersion;
            this.shared = shared;
            this.runtimes = runtimes;
            this.napukettoZipSha = napukettoZipSha;
        }

        String nodeVersion() {
            return nodeVersion;
        }

        TreeMap<String, String> shared() {
            return shared;
        }

        TreeMap<String, RuntimeEntry> runtimes() {
            return runtimes;
        }

        String napukettoZipSha() {
            return napukettoZipSha;
        }
    }

    private EmbeddedRuntime() {}

    /**
     * 安装 embedded 运行时到 bin 目录（只解当前平台命中的二进制）。
     *
     * @param binDir 目标目录（如 {@code plugins/kurobridge/bin}；不存在则创建）
     * @param source JAR 资源源（名字 → 流，{@code embedded/} 前缀由实现方处理）
     * @param log 进度日志消费者（复用/解压/哈希不符均逐条输出）
     * @return node 可执行文件与 index.mjs 的磁盘路径
     * @throws UnsupportedPlatformException 当前平台不在 manifest 的 runtimes 内
     * @throws IOException manifest 缺失/损坏、文件名校验不过、资源哈希不符或磁盘读写失败
     */
    public static Installed install(Path binDir, ResourceSource source, Consumer<String> log) throws IOException {
        Manifest manifest = readManifest(source);
        String platformKey = PlatformKey.detect();
        RuntimeEntry runtime = platformKey == null ? null : manifest.runtimes().get(platformKey);
        if (runtime == null) {
            throw new UnsupportedPlatformException(
                    platformKey, manifest.runtimes().keySet());
        }
        requireShared(manifest, FILE_BUNDLE);

        Path normalizedBin = binDir.toAbsolutePath().normalize();
        Files.createDirectories(normalizedBin);

        // 名字校验整体前置：任何越权名都在触碰磁盘前拒绝（不产生部分解压）
        TreeMap<String, Path> targets = new TreeMap<>();
        for (String name : manifest.shared().keySet()) {
            targets.put(name, safeTarget(normalizedBin, name));
        }
        Path nodeTarget = safeTarget(normalizedBin, runtime.file());

        int extracted = 0;
        int reused = 0;
        for (Map.Entry<String, String> entry : manifest.shared().entrySet()) {
            String name = entry.getKey();
            Path target = targets.get(name);
            if (Files.isRegularFile(target) && sha256(target).equals(entry.getValue())) {
                reused++;
                log.accept("embedded 文件已就绪，复用（sha256 一致）：" + name);
                continue;
            }
            if (Files.exists(target)) {
                log.accept("检测到打包内容变更（升级），已重建 plugins/kurobridge/bin 内文件：" + name);
            } else {
                log.accept("embedded 文件缺失，从 JAR 解压：" + name);
            }
            extract(source, name, target, entry.getValue());
            extracted++;
        }

        if (Files.isRegularFile(nodeTarget) && sha256(nodeTarget).equals(runtime.sha256())) {
            reused++;
            log.accept("embedded node 已就绪，复用（sha256 一致）：" + runtime.file());
        } else {
            if (Files.exists(nodeTarget)) {
                log.accept("检测到打包内容变更（升级），已重建 plugins/kurobridge/bin 内文件：" + runtime.file());
            } else {
                log.accept("embedded 文件缺失，从 JAR 解压：" + runtime.file());
            }
            extract(source, runtime.file(), nodeTarget, runtime.sha256());
            extracted++;
        }
        makeExecutable(nodeTarget, log);

        if (manifest.napukettoZipSha() != null) {
            installNapuketto(
                    normalizedBin.resolve(FILE_NAPUKETTO_DIR),
                    normalizedBin.resolve(FILE_NAPUKETTO_ZIP),
                    manifest.napukettoZipSha(),
                    log);
        }
        log.accept("embedded 运行时就绪（node " + manifest.nodeVersion() + " / " + platformKey + "）：解压 " + extracted
                + " / 复用 " + reused + " → " + normalizedBin);
        return new Installed(nodeTarget, targets.get(FILE_BUNDLE), manifest.nodeVersion(), platformKey);
    }

    /**
     * 补 POSIX 可执行位（幂等）：owner/group/others 全补 x，等价官方分发包的 0755。
     *
     * <p>Windows/NTFS 不进入此逻辑（文件系统无 posix 视图）；Linux 上即使文件系统不支持
     * chmod（如某些 FUSE 挂载）也只 WARN，仍交给预检去判断「能不能真的执行」。
     */
    static void makeExecutable(Path file, Consumer<String> log) throws IOException {
        if (!file.getFileSystem().supportedFileAttributeViews().contains("posix")) {
            return;
        }
        Set<PosixFilePermission> permissions;
        try {
            permissions = Files.getPosixFilePermissions(file);
        } catch (UnsupportedOperationException e) {
            return; // 视图声称支持但实际不可用：交给预检兜底
        }
        if (permissions.contains(PosixFilePermission.OWNER_EXECUTE)) {
            return;
        }
        permissions.add(PosixFilePermission.OWNER_EXECUTE);
        permissions.add(PosixFilePermission.GROUP_EXECUTE);
        permissions.add(PosixFilePermission.OTHERS_EXECUTE);
        try {
            Files.setPosixFilePermissions(file, permissions);
            log.accept("已补可执行位（+x）：" + file.getFileName());
        } catch (IOException | UnsupportedOperationException e) {
            log.accept("[WARN] 补可执行位失败（继续尝试拉起）：" + file.getFileName() + "，" + e.getMessage());
        }
    }

    /**
     * napuketto 嵌包展开（MVP-4）：bin/napuketto.zip → bin/napuketto/node_modules/...
     * 哨兵 sha256 与 zip 一致 → 复用；否则删目录重建（升级/缺失自愈）。
     * 与平台无关：Linux 也照常展开（进程侧是否拉起是另一层判据）。
     */
    private static void installNapuketto(Path targetDir, Path zipFile, String expectedSha, Consumer<String> log)
            throws IOException {
        Path sentinel = targetDir.resolve(FILE_NAPUKETTO_SENTINEL);
        if (Files.isRegularFile(sentinel)) {
            String recorded =
                    MAPPER.readTree(Files.readAllBytes(sentinel)).path("sha256").asText("");
            if (recorded.equals(expectedSha)) {
                log.accept("napuketto 嵌包已就绪，复用（哨兵 sha256 一致）：" + targetDir.getFileName());
                return;
            }
            log.accept("检测到 napuketto 嵌包变更（升级），重建 " + targetDir.getFileName() + " 目录");
            deleteRecursively(targetDir);
        } else if (Files.exists(targetDir)) {
            log.accept("napuketto 目录存在但无安装哨兵（残留/损坏），重建：" + targetDir.getFileName());
            deleteRecursively(targetDir);
        }
        Files.createDirectories(targetDir);
        int count = 0;
        try (ZipInputStream zip = new ZipInputStream(Files.newInputStream(zipFile))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                Path target = safeZipTarget(targetDir, entry.getName());
                if (entry.isDirectory()) {
                    Files.createDirectories(target);
                    continue;
                }
                Files.createDirectories(target.getParent());
                Files.copy(zip, target, StandardCopyOption.REPLACE_EXISTING);
                count++;
            }
        }
        String sentinelJson =
                MAPPER.createObjectNode().put("sha256", expectedSha).toString();
        Files.write(sentinel, sentinelJson.getBytes(StandardCharsets.UTF_8));
        log.accept("napuketto 嵌包展开完成（" + count + " 个文件）→ " + targetDir);
    }

    /** zip entry 名校验：拒绝绝对路径/反斜杠/盘符；normalize 后必须仍在目标目录内（防 ../ 逃逸）。 */
    private static Path safeZipTarget(Path targetDir, String name) throws IOException {
        if (name.trim().isEmpty() || name.startsWith("/") || name.contains("\\") || name.contains(":")) {
            throw new IOException("napuketto.zip 含非法条目名（疑似路径注入）：" + name);
        }
        Path target = targetDir.resolve(name).normalize();
        if (!target.startsWith(targetDir)) {
            throw new IOException("napuketto.zip 条目解析后逃出目标目录：" + name);
        }
        return target;
    }

    private static void deleteRecursively(Path root) throws IOException {
        List<Path> paths;
        try (Stream<Path> walk = Files.walk(root)) {
            paths = walk.sorted((a, b) -> b.getNameCount() - a.getNameCount()).collect(Collectors.toList());
        }
        for (Path path : paths) {
            Files.deleteIfExists(path);
        }
    }

    /** 读 manifest v2：schemaVersion / nodeVersion / shared / runtimes / napukettoZip。 */
    private static Manifest readManifest(ResourceSource source) throws IOException {
        byte[] manifestBytes;
        try (InputStream in = source.open(MANIFEST_NAME)) {
            manifestBytes = readAllBytes(in);
        }
        JsonNode root = MAPPER.readTree(manifestBytes);
        JsonNode schema = root.get("schemaVersion");
        if (schema == null || !schema.isInt() || schema.asInt() != MANIFEST_SCHEMA_VERSION) {
            throw new IOException("embedded/manifest.json 的 schemaVersion 必须为 " + MANIFEST_SCHEMA_VERSION + "（实际 "
                    + (schema == null ? "(缺失)" : schema.asText()) + "）：先重跑 embed 产物");
        }
        JsonNode sharedNode = root.get("shared");
        if (sharedNode == null || !sharedNode.isObject()) {
            throw new IOException("embedded/manifest.json 缺少 shared 对象");
        }
        TreeMap<String, String> shared = new TreeMap<>();
        Iterator<Map.Entry<String, JsonNode>> sharedFields = sharedNode.fields();
        while (sharedFields.hasNext()) {
            Map.Entry<String, JsonNode> field = sharedFields.next();
            shared.put(field.getKey(), field.getValue().asText());
        }

        JsonNode runtimesNode = root.get("runtimes");
        if (runtimesNode == null || !runtimesNode.isObject()) {
            throw new IOException("embedded/manifest.json 缺少 runtimes 对象");
        }
        TreeMap<String, RuntimeEntry> runtimes = new TreeMap<>();
        Iterator<Map.Entry<String, JsonNode>> runtimeFields = runtimesNode.fields();
        while (runtimeFields.hasNext()) {
            Map.Entry<String, JsonNode> field = runtimeFields.next();
            JsonNode file = field.getValue().get("file");
            JsonNode sha = field.getValue().get("sha256");
            if (file == null || !file.isTextual() || sha == null || !sha.isTextual()) {
                throw new IOException("embedded/manifest.json 的 runtimes." + field.getKey() + " 缺少 file/sha256 文本字段");
            }
            runtimes.put(field.getKey(), new RuntimeEntry(file.asText(), sha.asText()));
        }

        JsonNode version = root.get("nodeVersion");
        JsonNode napukettoZip = root.get("napukettoZip");
        String napukettoSha = napukettoZip != null && napukettoZip.has("sha256")
                ? napukettoZip.get("sha256").asText()
                : null;
        return new Manifest(version == null ? "?" : version.asText("?"), shared, runtimes, napukettoSha);
    }

    private static void requireShared(Manifest manifest, String name) throws IOException {
        if (!manifest.shared().containsKey(name)) {
            throw new IOException("embedded/manifest.json 缺少共享产物条目：" + name);
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
        String actual = toHex(digest.digest());
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
        return toHex(digest.digest());
    }

    /** 字节数组 → 小写十六进制（Java 8 基线无 HexFormat，ADR-038）。 */
    private static String toHex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            builder.append(Character.forDigit((value >> 4) & 0xF, 16));
            builder.append(Character.forDigit(value & 0xF, 16));
        }
        return builder.toString();
    }

    /** 流全量读入（Java 8 基线无 InputStream.readAllBytes，ADR-038）。 */
    private static byte[] readAllBytes(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        for (int read; (read = in.read(chunk)) != -1; ) {
            buffer.write(chunk, 0, read);
        }
        return buffer.toByteArray();
    }

    private static MessageDigest sha256Digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("JVM 缺少 SHA-256 实现", e);
        }
    }
}
