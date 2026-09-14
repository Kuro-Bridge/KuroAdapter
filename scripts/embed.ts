/**
 * scripts/embed.ts —— 嵌入式打包工具（MVP 阶段二；MVP-4 扩展 napuketto 嵌包）
 *
 * 职责：下载/校验 node 官方 dist（win-x64）→ 只取 node.exe + LICENSE，连同
 * bridge/embedded/dist/index.mjs 产出到 platforms/je/paper/src/main/resources/embedded/。
 * MVP-4（ADR-029）：另收集 @napuketto/cli 依赖树（npm 安装到缓存，真实文件非 symlink）
 * → 单一 zip 资源 napuketto.zip + 许可聚合 NAPUKETTO_LICENSES → 进 manifest。
 *
 * - 只用 Node 内置依赖；Node ≥ 23.6 原生 TS 剥离直接执行（pnpm build:jar 接线，无需编译）。
 * - 幂等：产物已存在且 sha256 一致则跳过；写盘 tmp + rename 原子替换。
 * - zip 有本地缓存（缺省 <仓库根>/.cache/node-dist/，gitignored）；镜像与缓存可经环境变量
 *   覆盖：KUROBOT_NODE_DIST_BASE（默认 https://nodejs.org/dist）、KUROBOT_NODE_CACHE_DIR、
 *   KUROBOT_NPM_REGISTRY（napuketto 安装镜像，网络敏感时切 npmmirror）。
 *   换镜像不改校验逻辑（sha256 仍对官方 SHASUMS256.txt）。
 * - node 版本钉 26.7.0（与 mise 一致，任务书 §1.2）；多平台矩阵是后续债务。
 * - 红线：napuketto.zip 只含 npm 发布物（MIT 及其许可注记的资产）；wrapper.node / QQ
 *   安装包等腾讯二进制绝不出现（napuketto 运行期自取）。
 *
 * 用法（仓库根，pnpm -r build 之后）：node scripts/embed.ts
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/** 任务书 §1.2：只嵌 win-x64，版本钉 26.7.0（与 mise 一致）。导出供测试对齐。 */
export const NODE_VERSION = "26.7.0";
export const NODE_PLATFORM_DIR = `node-v${NODE_VERSION}-win-x64`;
const ZIP_NAME = `${NODE_PLATFORM_DIR}.zip`;
const DEFAULT_DIST_BASE = "https://nodejs.org/dist";
const ENV_DIST_BASE = "KUROBOT_NODE_DIST_BASE";
const ENV_CACHE_DIR = "KUROBOT_NODE_CACHE_DIR";
/**
 * SHASUMS 严格模式（DEBT-2）：设为 1 时在线拉取 SHASUMS256.txt 失败即失败，拒绝回退缓存
 * （发布/CI 用，杜绝「信任上次缓存值」的窗口）；缺省行为不变（回退 + WARN 明示来源）。
 */
const ENV_STRICT = "KUROBOT_NODE_DIST_STRICT";

/** SHASUMS256.txt 行格式：`<sha256><两空格><文件名>`（容忍 \r 与多余空白）。 */
const SHASUM_LINE = /^([0-9a-f]{64})\s\s+(\S.*)$/;
/** dist 基址的尾斜杠（含多个）。 */
const TRAILING_SLASHES = /\/+$/;

const MANIFEST_NAME = "manifest.json";
const PRODUCT_NODE_EXE = "node.exe";
const PRODUCT_BUNDLE = "index.mjs";
const PRODUCT_LICENSE = "NODE_LICENSE";
/** MVP-4 嵌包产物名（:core EmbeddedRuntime 按 manifest.napukettoZip 指针展开到 bin/napuketto/） */
export const PRODUCT_NAPUKETTO_ZIP = "napuketto.zip";
export const PRODUCT_NAPUKETTO_LICENSES = "NAPUKETTO_LICENSES";
const ENV_NPM_REGISTRY = "KUROBOT_NPM_REGISTRY";

export interface EmbedOptions {
    /** bridge/embedded/dist/index.mjs（须先 pnpm -r build）。 */
    distBundle: string;
    /** 产物目录（platforms/je/paper/src/main/resources/embedded）。 */
    outDir: string;
    /** zip / SHASUMS256.txt / napuketto 依赖树缓存目录。 */
    cacheDir: string;
    /** dist 基址（镜像覆盖）；缺省取 KUROBOT_NODE_DIST_BASE 或官方地址。 */
    distBase?: string;
    /** 下载器（可注入，测试不发真网）；缺省 fetch。 */
    download?: (url: string) => Promise<Buffer>;
    /** 日志输出；缺省 console.log。 */
    log?: (message: string) => void;
    /**
     * SHASUMS 严格模式（DEBT-2）：true = 在线 SHASUMS 拉取失败直接失败，不回退缓存。
     * 缺省读环境变量 KUROBOT_NODE_DIST_STRICT=1，未设为 false（回退 + WARN）。
     */
    strict?: boolean;
    /**
     * napuketto 嵌包（MVP-4）。cliVersion 是 @napuketto/cli 的精确版本（SSOT =
     * bridge/embedded/package.json，runCli 读取）；install 可注入（测试不发真网），
     * 缺省 npm install 到 <cacheDir>/napuketto-cli-<version>/。
     */
    napuketto?: {
        cliVersion: string;
        install?: (version: string, targetDir: string) => void;
    };
}

export interface EmbedResult {
    /** 本次实际写入（含哈希不符重建）的产物文件名。 */
    copied: string[];
    /** sha256 一致而跳过的产物文件名。 */
    reused: string[];
}

interface ZipEntry {
    name: string;
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    crc32: number;
    localOffset: number;
}

/** 解析 SHASUMS256.txt → 文件名到 sha256 的映射。 */
export function parseShasums(text: string): Map<string, string> {
    const sums = new Map<string, string>();
    for (const rawLine of text.split("\n")) {
        const line = rawLine.trimEnd();
        if (line.length === 0) {
            continue;
        }
        const match = SHASUM_LINE.exec(line);
        if (match === null) {
            continue; // 非校验行（签名说明等）直接忽略
        }
        const sha256 = match[1];
        const name = match[2];
        if (sha256 === undefined || name === undefined) {
            continue;
        }
        sums.set(name.trim(), sha256);
    }
    return sums;
}

/** dist 基址 + 版本 → SHASUMS256.txt 与 zip 的下载地址（基址去尾斜杠）。 */
export function distUrls(
    distBase: string,
    version: string,
): { shasumsUrl: string; zipUrl: string } {
    const base = distBase.replace(TRAILING_SLASHES, "");
    return {
        shasumsUrl: `${base}/v${version}/SHASUMS256.txt`,
        zipUrl: `${base}/v${version}/node-v${version}-win-x64.zip`,
    };
}

/**
 * 从 zip 缓冲中按精确名取出一个条目（stored/deflate，crc32 校验）。
 * 不支持 zip64——node 官方 win-x64 zip 远小于 4GB，超出即抛错。
 */
export function extractZipEntry(zip: Buffer, entryName: string): Buffer {
    const entry = readCentralDirectory(zip).find((candidate) => candidate.name === entryName);
    if (entry === undefined) {
        throw new Error(`zip 内找不到条目：${entryName}`);
    }
    const localNameLength = readUInt16(zip, entry.localOffset + 26);
    const localExtraLength = readUInt16(zip, entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
    const compressed = zip.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method !== 0 && entry.method !== 8) {
        throw new Error(`不支持的压缩方法（method=${entry.method}）：${entryName}`);
    }
    const data = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    if (data.length !== entry.uncompressedSize) {
        throw new Error(
            `解压长度不符（${data.length} != ${entry.uncompressedSize}）：${entryName}`,
        );
    }
    if (crc32(data) !== entry.crc32) {
        throw new Error(`crc32 校验失败：${entryName}`);
    }
    return data;
}

/** 主流程：确保 zip 就位（下载/校验/缓存）→ [napuketto 依赖树打包] → 产物（幂等）。 */
export async function runEmbed(options: EmbedOptions): Promise<EmbedResult> {
    const log = options.log ?? ((message: string) => console.log(message));
    const download = options.download ?? fetchUrl;
    const distBase = options.distBase ?? process.env[ENV_DIST_BASE] ?? DEFAULT_DIST_BASE;
    const strict = options.strict ?? process.env[ENV_STRICT] === "1";
    const { shasumsUrl, zipUrl } = distUrls(distBase, NODE_VERSION);

    const bundleData = await readProduct(
        options.distBundle,
        `bridge/embedded 产物（先 pnpm -r build）`,
    );
    const zip = await ensureZip({
        cacheDir: options.cacheDir,
        zipUrl,
        shasumsUrl,
        download,
        log,
        strict,
    });
    const nodeExe = extractZipEntry(zip, `${NODE_PLATFORM_DIR}/${PRODUCT_NODE_EXE}`);
    const license = extractZipEntry(zip, `${NODE_PLATFORM_DIR}/LICENSE`);

    const products: Array<{ name: string; data: Buffer }> = [
        { name: PRODUCT_NODE_EXE, data: nodeExe },
        { name: PRODUCT_LICENSE, data: license },
        { name: PRODUCT_BUNDLE, data: bundleData },
    ];
    let napukettoZipSha: string | undefined;
    if (options.napuketto !== undefined) {
        const bundle = await ensureNapukettoBundle({
            cacheDir: options.cacheDir,
            cliVersion: options.napuketto.cliVersion,
            install: options.napuketto.install ?? defaultInstallNapuketto,
            log,
        });
        products.push({ name: PRODUCT_NAPUKETTO_ZIP, data: bundle.zip });
        products.push({ name: PRODUCT_NAPUKETTO_LICENSES, data: bundle.licenses });
        napukettoZipSha = sha256Buffer(bundle.zip);
    }
    await mkdir(options.outDir, { recursive: true });

    const files: Record<string, string> = {};
    const copied: string[] = [];
    const reused: string[] = [];
    for (const product of products) {
        const sha256 = sha256Buffer(product.data);
        files[product.name] = sha256;
        const outcome = await writeIfChanged(
            join(options.outDir, product.name),
            product.data,
            sha256,
        );
        (outcome ? copied : reused).push(product.name);
        log(
            `[embed] ${product.name} ${outcome ? "已写入" : "已就绪（sha256 一致，跳过）"} ${sha256}`,
        );
    }

    const manifestBody: Record<string, unknown> = { nodeVersion: NODE_VERSION, files };
    if (napukettoZipSha !== undefined) {
        manifestBody["napukettoZip"] = {
            name: PRODUCT_NAPUKETTO_ZIP,
            sha256: napukettoZipSha,
            cliVersion: options.napuketto?.cliVersion,
        };
    }
    const manifest = `${JSON.stringify(manifestBody, null, 4)}\n`;
    const manifestData = Buffer.from(manifest, "utf8");
    const outcome = await writeIfChanged(
        join(options.outDir, MANIFEST_NAME),
        manifestData,
        sha256Buffer(manifestData),
    );
    (outcome ? copied : reused).push(MANIFEST_NAME);
    log(`[embed] ${MANIFEST_NAME} ${outcome ? "已写入" : "已就绪（内容一致，跳过）"}`);

    log(
        `[embed] 完成：写入 ${copied.length} / 复用 ${reused.length}（node ${NODE_VERSION} win-x64）`,
    );
    return { copied, reused };
}

/** 确保 zip 在缓存就位且 sha256 与官方 SHASUMS256.txt 一致；返回其内容。 */
async function ensureZip(dependencies: {
    cacheDir: string;
    zipUrl: string;
    shasumsUrl: string;
    download: (url: string) => Promise<Buffer>;
    log: (message: string) => void;
    strict: boolean;
}): Promise<Buffer> {
    const { cacheDir, zipUrl, shasumsUrl, download, log, strict } = dependencies;
    const expected = await expectedZipSha(cacheDir, shasumsUrl, download, log, strict);
    const cachedZip = join(cacheDir, ZIP_NAME);
    if (await fileExists(cachedZip)) {
        const cached = await readFile(cachedZip);
        if (sha256Buffer(cached) === expected) {
            return cached;
        }
        log("[embed] 缓存 zip 哈希不符（版本更换？），重新下载");
    }
    log(`[embed] 下载 ${zipUrl}`);
    const zip = await download(zipUrl);
    const actual = sha256Buffer(zip);
    if (actual !== expected) {
        throw new Error(
            `zip sha256 校验失败：期望 ${expected}，实际 ${actual}（可经 ${ENV_DIST_BASE} 换镜像重试）`,
        );
    }
    await mkdir(cacheDir, { recursive: true });
    const tmp = `${cachedZip}.tmp`;
    await writeFile(tmp, zip);
    await rename(tmp, cachedZip);
    return zip;
}

/**
 * 取官方期望的 zip sha256：优先在线拉 SHASUMS256.txt；失败时——严格模式直接失败（拒绝
 * 信任缓存值），非严格回退缓存并 WARN 明示来源（离线复用上次校验值，DEBT-2）。
 */
async function expectedZipSha(
    cacheDir: string,
    shasumsUrl: string,
    download: (url: string) => Promise<Buffer>,
    log: (message: string) => void,
    strict: boolean,
): Promise<string> {
    const cachedShasums = join(cacheDir, "SHASUMS256.txt");
    let text: string;
    try {
        text = (await download(shasumsUrl)).toString("utf8");
        await mkdir(cacheDir, { recursive: true });
        const tmp = `${cachedShasums}.tmp`;
        await writeFile(tmp, text, "utf8");
        await rename(tmp, cachedShasums);
    } catch (error: unknown) {
        if (strict) {
            throw new Error(
                `无法获取 SHASUMS256.txt（${String(error)}），且 ${ENV_STRICT}=1 拒绝回退缓存`,
            );
        }
        if (!(await fileExists(cachedShasums))) {
            throw new Error(
                `无法获取 SHASUMS256.txt（${String(error)}；可经 ${ENV_DIST_BASE} 换镜像）`,
            );
        }
        log(
            `[embed] [WARN] SHASUMS256.txt 在线拉取失败，回退本地缓存` +
                `（本次校验值来源=缓存而非官方在线值；发布/CI 可设 ${ENV_STRICT}=1 拒绝回退）`,
        );
        text = await readFile(cachedShasums, "utf8");
    }
    const expected = parseShasums(text).get(ZIP_NAME);
    if (expected === undefined) {
        throw new Error(`SHASUMS256.txt 缺少 ${ZIP_NAME} 条目`);
    }
    return expected;
}

/** 产物已存在且 sha256 一致则跳过；否则 tmp + rename 原子写入。返回是否写入。 */
async function writeIfChanged(path: string, data: Buffer, sha256: string): Promise<boolean> {
    if (await fileExists(path)) {
        const existing = await readFile(path);
        if (sha256Buffer(existing) === sha256) {
            return false;
        }
    }
    const tmp = `${path}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path);
    return true;
}

// ---- napuketto 嵌包（MVP-4，ADR-029）----

interface ZipInputEntry {
    /** zip 内相对名，"/" 分隔（zip 规范） */
    name: string;
    data: Buffer;
}

/**
 * 零依赖 zip writer（与既有最小 reader 对称）：stored/deflate 择优 + crc32，
 * UTF-8 名字标志位（bit 11）。不支持 extra/comment/zip64——自包含依赖树用不到。
 */
export function buildZip(entries: ZipInputEntry[]): Buffer {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, "utf8");
        const deflated = deflateRawSync(entry.data);
        const method = deflated.length < entry.data.length ? 8 : 0;
        const payload = method === 8 ? deflated : Buffer.from(entry.data);
        const checksum = crc32(entry.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0800, 6); // flags: UTF-8 名字
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        localParts.push(local, name, payload);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4); // version made by
        central.writeUInt16LE(20, 6); // version needed
        central.writeUInt16LE(0x0800, 8); // flags
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(payload.length, 20);
        central.writeUInt32LE(entry.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42); // local header offset
        centralParts.push(central, name);
        offset += 30 + name.length + payload.length;
    }
    const central = Buffer.concat(centralParts);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...localParts, central, eocd]);
}

/** node_modules → zip 条目（"/" 分隔名）；跳过 .bin（npm shim/symlink，运行期不需要）与非普通文件 */
export async function collectZipEntries(nodeModulesDir: string): Promise<ZipInputEntry[]> {
    const entries: ZipInputEntry[] = [];
    async function walk(dir: string, relative: string): Promise<void> {
        for (const item of await readdir(dir, { withFileTypes: true })) {
            if (item.name === ".bin") {
                continue;
            }
            const childRelative = relative === "" ? item.name : `${relative}/${item.name}`;
            const childAbsolute = join(dir, item.name);
            if (item.isDirectory()) {
                await walk(childAbsolute, childRelative);
                continue;
            }
            if (!item.isFile()) {
                continue; // symlink 等：npm 安装产物应全为真实文件，异常内容不进 zip
            }
            entries.push({
                name: `node_modules/${childRelative}`,
                data: await readFile(childAbsolute),
            });
        }
    }
    await walk(nodeModulesDir, "");
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return entries;
}

const LICENSE_FILE_NAMES = new Set([
    "LICENSE",
    "LICENSE.MD",
    "LICENSE.TXT",
    "LICENCE",
    "LICENCE.MD",
    "LICENCE.TXT",
]);

/**
 * 包内子目录资产的许可文件（顶层扫描覆盖不到的）：@napuketto/loader 自带 7zip 资产是
 * LGPL（与 npm 包原样分发），其许可文本必须随聚合产物走（待遇对齐 NODE_LICENSE）。
 */
const EXTRA_LICENSE_FILES = [
    "node_modules/@napuketto/loader/assets/7zip/License.txt",
    "node_modules/@napuketto/loader/assets/7zip/License-linux.txt",
];

/** 聚合依赖树内全部顶层包的许可文件（@scope 包下钻一层）→ 单一文本（待遇对齐 NODE_LICENSE） */
export async function collectLicenses(nodeModulesDir: string): Promise<Buffer> {
    const chunks: string[] = [];
    const addPackage = async (pkgDir: string): Promise<void> => {
        for (const name of await readdir(pkgDir)) {
            if (!LICENSE_FILE_NAMES.has(name.toUpperCase())) {
                continue;
            }
            const text = await readFile(join(pkgDir, name), "utf8");
            const packagePath = pathToPosix(
                join("node_modules", pkgDir.slice(nodeModulesDir.length + 1)),
            );
            chunks.push(`${"=".repeat(78)}\n${packagePath}/${name}\n${"=".repeat(78)}\n${text}\n`);
            return; // 一包一许可（首个命中即停）
        }
    };
    await forEachTopLevelPackage(nodeModulesDir, addPackage);
    for (const relative of EXTRA_LICENSE_FILES) {
        try {
            const text = await readFile(join(nodeModulesDir, relative), "utf8");
            chunks.push(`${"=".repeat(78)}\n${relative}\n${"=".repeat(78)}\n${text}\n`);
        } catch {
            // 资产不在（包版本变动）——跳过；嵌包清单在 NOTES 记录核对要求
        }
    }
    return Buffer.from(chunks.join(""), "utf8");
}

/** 遍历依赖树顶层包目录（含 @scope 下钻一层），对每个包目录执行 action */
async function forEachTopLevelPackage(
    nodeModulesDir: string,
    action: (pkgDir: string) => Promise<void>,
): Promise<void> {
    for (const item of await readdir(nodeModulesDir, { withFileTypes: true })) {
        if (!item.isDirectory() || item.name.startsWith(".")) {
            continue;
        }
        const entryDir = join(nodeModulesDir, item.name);
        if (item.name.startsWith("@")) {
            for (const scoped of await readdir(entryDir, { withFileTypes: true })) {
                if (scoped.isDirectory()) {
                    await action(join(entryDir, scoped.name));
                }
            }
        } else {
            await action(entryDir);
        }
    }
}

function pathToPosix(value: string): string {
    return value.split("\\").join("/");
}

/** 确保 napuketto 依赖树 + zip + 许可就位（缓存幂等）；返回待嵌入产物内容。 */
async function ensureNapukettoBundle(deps: {
    cacheDir: string;
    cliVersion: string;
    install: (version: string, targetDir: string) => void;
    log: (message: string) => void;
}): Promise<{ zip: Buffer; licenses: Buffer }> {
    const { cacheDir, cliVersion, install, log } = deps;
    const targetDir = join(cacheDir, `napuketto-cli-${cliVersion}`);
    const nodeModules = join(targetDir, "node_modules");
    const cliPackage = join(nodeModules, "@napuketto", "cli", "package.json");
    const zipCache = join(targetDir, "bundle.zip");
    const licensesCache = join(targetDir, "NAPUKETTO_LICENSES");
    if (
        (await fileExists(zipCache)) &&
        (await fileExists(licensesCache)) &&
        (await fileExists(cliPackage))
    ) {
        log(`[embed] napuketto 缓存命中（@napuketto/cli ${cliVersion}），跳过安装与打包`);
        return { zip: await readFile(zipCache), licenses: await readFile(licensesCache) };
    }
    if (!(await fileExists(cliPackage))) {
        log(`[embed] npm 安装 @napuketto/cli@${cliVersion}（真实文件树，供打 zip）`);
        install(cliVersion, targetDir);
    }
    const entries = await collectZipEntries(nodeModules);
    if (entries.length === 0) {
        throw new Error(`napuketto 依赖树为空：${nodeModules}`);
    }
    const zip = buildZip(entries);
    const licenses = await collectLicenses(nodeModules);
    await mkdir(targetDir, { recursive: true });
    await writeIfChanged(zipCache, zip, sha256Buffer(zip));
    await writeIfChanged(licensesCache, licenses, sha256Buffer(licenses));
    log(
        `[embed] napuketto 打包完成：${entries.length} 个文件，zip ${zip.length} 字节，` +
            `许可聚合 ${licenses.length} 字节`,
    );
    return { zip, licenses };
}

/** 缺省安装器：npm install 到 targetDir（真实文件，非 pnpm symlink）；镜像经 KUROBOT_NPM_REGISTRY */
function defaultInstallNapuketto(version: string, targetDir: string): void {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
        join(targetDir, "package.json"),
        `${JSON.stringify({ name: "kurobot-napuketto-bundle", private: true, version: "0.0.0" }, null, 4)}\n`,
        "utf8",
    );
    const args = [
        "install",
        `@napuketto/cli@${version}`,
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
    ];
    const registry = process.env[ENV_NPM_REGISTRY];
    if (registry !== undefined && registry !== "") {
        args.push("--registry", registry);
    }
    const result = spawnSync("npm", args, {
        cwd: targetDir,
        stdio: "inherit",
        shell: process.platform === "win32",
    });
    if (result.status !== 0) {
        throw new Error(
            `npm install @napuketto/cli@${version} 失败（exit=${result.status}）；` +
                `网络敏感时可设 ${ENV_NPM_REGISTRY}=https://registry.npmmirror.com 重试`,
        );
    }
}

/** 精确 semver（防 workspace 区间之类的值混进嵌包版本 SSOT） */
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

/** @napuketto/cli 版本 SSOT = bridge/embedded/package.json（精确 pin 校验） */
export function readNapukettoCliVersion(repoRoot: string): string {
    const raw: unknown = JSON.parse(
        readFileSync(join(repoRoot, "bridge", "embedded", "package.json"), "utf8"),
    );
    const version = (raw as { dependencies?: Record<string, unknown> }).dependencies?.[
        "@napuketto/cli"
    ];
    if (typeof version !== "string" || !EXACT_SEMVER.test(version)) {
        throw new Error(
            `bridge/embedded/package.json 缺少 @napuketto/cli 的精确版本 pin（当前值：${String(version)}）`,
        );
    }
    return version;
}

async function readProduct(path: string, what: string): Promise<Buffer> {
    try {
        return await readFile(path);
    } catch (error: unknown) {
        throw new Error(`读取 ${what} 失败：${path}（${String(error)}）`);
    }
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

function sha256Buffer(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
}

async function fetchUrl(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`下载失败（HTTP ${response.status}）：${url}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

// ---- 最小 zip 读取（EOCD → 中央目录 → 本地头），仅服务 extractZipEntry ----

function readUInt16(buffer: Buffer, offset: number): number {
    return buffer.readUInt16LE(offset);
}

function readEocd(zip: Buffer): { entries: number; cdOffset: number } {
    const minOffset = Math.max(0, zip.length - 66_000);
    for (let i = zip.length - 22; i >= minOffset; i--) {
        if (zip.readUInt32LE(i) !== 0x06054b50) {
            continue;
        }
        const entries = readUInt16(zip, i + 10);
        const cdOffset = zip.readUInt32LE(i + 16);
        if (entries === 0xffff || cdOffset === 0xffffffff) {
            throw new Error("不支持 zip64 包体");
        }
        return { entries, cdOffset };
    }
    throw new Error("zip 内找不到 EOCD（包体损坏？）");
}

function readCentralDirectory(zip: Buffer): ZipEntry[] {
    const { entries, cdOffset } = readEocd(zip);
    const result: ZipEntry[] = [];
    let pos = cdOffset;
    for (let i = 0; i < entries; i++) {
        if (pos + 46 > zip.length || zip.readUInt32LE(pos) !== 0x02014b50) {
            throw new Error("中央目录损坏（条目签名不符）");
        }
        const nameLength = readUInt16(zip, pos + 28);
        const extraLength = readUInt16(zip, pos + 30);
        const commentLength = readUInt16(zip, pos + 32);
        result.push({
            name: zip.toString("latin1", pos + 46, pos + 46 + nameLength),
            method: readUInt16(zip, pos + 10),
            compressedSize: zip.readUInt32LE(pos + 20),
            uncompressedSize: zip.readUInt32LE(pos + 24),
            crc32: zip.readUInt32LE(pos + 16),
            localOffset: zip.readUInt32LE(pos + 42),
        });
        pos += 46 + nameLength + extraLength + commentLength;
    }
    return result;
}

// ---- CLI 入口（被 import 时不执行） ----

async function runCli(): Promise<void> {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const result = await runEmbed({
        distBundle: join(root, "bridge", "embedded", "dist", "index.mjs"),
        outDir: join(root, "platforms", "je", "paper", "src", "main", "resources", "embedded"),
        cacheDir: process.env[ENV_CACHE_DIR] ?? join(root, ".cache", "node-dist"),
        napuketto: { cliVersion: readNapukettoCliVersion(root) },
    });
    console.log(
        `[embed] 产物目录就绪（写入 ${result.copied.length}，复用 ${result.reused.length}）`,
    );
}

const invokedDirectly =
    process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
    try {
        await runCli();
    } catch (error: unknown) {
        console.error(`[embed] 失败：${String(error)}`);
        process.exitCode = 1;
    }
}
