/**
 * toolings/packaging/embed.ts —— 嵌入式打包工具（MVP 阶段二；MVP-4 扩展 napuketto 嵌包）
 *
 * 职责：按 toolings/runtime-manifest.json 的目标清单下载/校验 node 官方 dist → 每平台只取
 * 一个 node 二进制（+ 一份共用 LICENSE），连同 bridge/embedded/dist/index.mjs 产出到各平台
 * 模块的 src/main/resources/embedded/（paper + fabric，目标目录 SSOT 见 defaultEmbedTargets；
 * 产物契约 = :core EmbeddedRuntime 消费的 manifest.json v2：shared / runtimes 两段）。
 * MVP-4（ADR-029）：另收集 @napuketto/cli 依赖树（npm 安装到缓存，真实文件非 symlink）→
 * 单一 zip 资源 napuketto.zip + 许可聚合 NAPUKETTO_LICENSES → 进 manifest 的 napukettoZip。
 *
 * - 只用 Node 内置依赖（zip 用自带最小 reader；Linux 的 tar.gz 用 toolings/packaging/tar.ts）；
 *   Node ≥ 23.6 原生 TS 剥离直接执行（pnpm build:jar 接线，无需编译）。
 * - 幂等：产物已存在且 sha256 一致则跳过；写盘 tmp + rename 原子替换。
 * - zip 有本地缓存（缺省 <仓库根>/.cache/node-dist/，gitignored）；镜像与缓存可经环境变量
 *   覆盖：KUROBRIDGE_NODE_DIST_BASE（默认 https://nodejs.org/dist）、KUROBRIDGE_NODE_CACHE_DIR、
 *   KUROBRIDGE_NPM_REGISTRY（napuketto 安装镜像，网络敏感时切 npmmirror）。
 *   换镜像不改校验逻辑（sha256 仍对官方 SHASUMS256.txt）。
 * - node 版本与默认目标清单钉在 toolings/runtime-manifest.json（SSOT 单一来源）；
 *   KUROBRIDGE_EMBED_TARGETS 可覆盖目标（Lean JAR / 本地快构建），合法性仍由 runtime.ts 校验。
 * - 红线：napuketto.zip 只含 npm 发布物（MIT 及其许可注记的资产）；wrapper.node / QQ
 *   安装包等腾讯二进制绝不出现（napuketto 运行期自取）。
 *
 * 用法（仓库根，pnpm -r build 之后）：node toolings/packaging/embed.ts
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

import { readRuntimeManifest, resolveEmbedTargets } from "../lib/runtime.ts";
import { extractTarGzEntry } from "./tar.ts";

/** 仓库根（模块级：版本 SSOT 读取与 CLI 入口共用，避免二次推导）。 */
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * 版本 SSOT = toolings/runtime-manifest.json（本文件不再写字面量版本；门禁
 * check-runtime-versions 对齐全仓 mise / .nvmrc / engines / @types/node / CI）。
 * 导出供测试对齐。
 */
const RUNTIME = readRuntimeManifest(REPO_ROOT);
export const NODE_VERSION = RUNTIME.nodeVersion;

/** 平台键：与 Java 侧 PlatformKey / runtime-manifest 的 targets 一一对应。 */
export type PlatformKey = "win-x64" | "win-arm64" | "linux-x64" | "linux-arm64";

export interface RuntimeTarget {
    readonly key: PlatformKey;
    /** 官方分发归档格式：Windows 为 zip，Linux 为 tar.gz（xz 需外部依赖，不用）。 */
    readonly archiveFormat: "zip" | "tar.gz";
    /** JAR 内扁平产物名（单段名让 :core 的 SAFE_NAME 防 zip-slip 模型保持一行不改）。 */
    readonly productName: string;
}

const TARGET_TABLE: Record<PlatformKey, RuntimeTarget> = {
    "win-x64": { key: "win-x64", archiveFormat: "zip", productName: "node-win-x64.exe" },
    "win-arm64": { key: "win-arm64", archiveFormat: "zip", productName: "node-win-arm64.exe" },
    "linux-x64": { key: "linux-x64", archiveFormat: "tar.gz", productName: "node-linux-x64" },
    "linux-arm64": { key: "linux-arm64", archiveFormat: "tar.gz", productName: "node-linux-arm64" },
};

/** 目标键 → 目标定义；未知键抛错（覆盖列表的合法性在这里收口）。 */
export function runtimeTarget(key: string): RuntimeTarget {
    const target = TARGET_TABLE[key as PlatformKey];
    if (target === undefined) {
        throw new Error(`未知的内嵌目标：${key}（已知：${Object.keys(TARGET_TABLE).join("/")}）`);
    }
    return target;
}

/** 归档内平台目录名（如 node-v26.13.0-linux-x64）。 */
function platformDir(version: string, target: RuntimeTarget): string {
    return `node-v${version}-${target.key}`;
}

/** 归档内 node 二进制路径：Windows 在根目录，Linux 在 bin/。 */
export function nodeEntryPath(version: string, target: RuntimeTarget): string {
    return target.key.startsWith("win-")
        ? `${platformDir(version, target)}/node.exe`
        : `${platformDir(version, target)}/bin/node`;
}

/** 归档内 LICENSE 路径（各平台同一份文本，取首个目标的即可）。 */
export function licenseEntryPath(version: string, target: RuntimeTarget): string {
    return `${platformDir(version, target)}/LICENSE`;
}

/** 归档文件名（如 node-v26.13.0-linux-x64.tar.gz）。 */
export function archiveName(version: string, target: RuntimeTarget): string {
    const extension = target.archiveFormat === "zip" ? "zip" : "tar.gz";
    return `${platformDir(version, target)}.${extension}`;
}

const DEFAULT_DIST_BASE = "https://nodejs.org/dist";
const ENV_DIST_BASE = "KUROBRIDGE_NODE_DIST_BASE";
const ENV_CACHE_DIR = "KUROBRIDGE_NODE_CACHE_DIR";
/** 目标覆盖（逗号分隔，如 win-x64 / linux-x64,linux-arm64）；缺省读 manifest 的 targets。 */
const ENV_TARGETS = "KUROBRIDGE_EMBED_TARGETS";
/**
 * SHASUMS 严格模式（DEBT-2）：设为 1 时在线拉取 SHASUMS256.txt 失败即失败，拒绝回退缓存
 * （发布/CI 用，杜绝「信任上次缓存值」的窗口）；缺省行为不变（回退 + WARN 明示来源）。
 */
const ENV_STRICT = "KUROBRIDGE_NODE_DIST_STRICT";

/** SHASUMS256.txt 行格式：`<sha256><两空格><文件名>`（容忍 \r 与多余空白）。 */
const SHASUM_LINE = /^([0-9a-f]{64})\s\s+(\S.*)$/;
/** dist 基址的尾斜杠（含多个）。 */
const TRAILING_SLASHES = /\/+$/;

const MANIFEST_NAME = "manifest.json";
const PRODUCT_BUNDLE = "index.mjs";
const PRODUCT_LICENSE = "NODE_LICENSE";
/** MVP-4 嵌包产物名（:core EmbeddedRuntime 按 manifest.napukettoZip 指针展开到 bin/napuketto/） */
export const PRODUCT_NAPUKETTO_ZIP = "napuketto.zip";
export const PRODUCT_NAPUKETTO_LICENSES = "NAPUKETTO_LICENSES";
const ENV_NPM_REGISTRY = "KUROBRIDGE_NPM_REGISTRY";

/** manifest v2 形状（与 :core EmbeddedRuntime 的读取面一致）。 */
export interface EmbeddedManifestV2 {
    readonly schemaVersion: 2;
    readonly nodeVersion: string;
    /** 平台无关产物（index.mjs / 许可 / napuketto.zip）。 */
    readonly shared: Record<string, string>;
    /** 平台键 → 二进制产物（扁平文件名 + sha256）。 */
    readonly runtimes: Record<string, { readonly file: string; readonly sha256: string }>;
    readonly napukettoZip?: {
        readonly name: string;
        readonly sha256: string;
        readonly cliVersion: string | undefined;
    };
}

export interface EmbedOptions {
    /** bridge/embedded/dist/index.mjs（须先 pnpm -r build）。 */
    distBundle: string;
    /** 产物目录（各平台模块的 src/main/resources/embedded，见 defaultEmbedTargets）。 */
    outDir: string;
    /** zip / tar.gz / SHASUMS256.txt / napuketto 依赖树缓存目录。 */
    cacheDir: string;
    /**
     * 本次要嵌的目标（PlatformKey）。必填：调用方决定（CLI 由 manifest + 环境变量解析；
     * 测试只给需要的目标，避免一次拉三个归档）。
     */
    targets: readonly string[];
    /** dist 基址（镜像覆盖）；缺省取 KUROBRIDGE_NODE_DIST_BASE 或官方地址。 */
    distBase?: string;
    /** 下载器（可注入，测试不发真网）；缺省 fetch。 */
    download?: (url: string) => Promise<Buffer>;
    /** 日志输出；缺省 console.log。 */
    log?: (message: string) => void;
    /**
     * SHASUMS 严格模式（DEBT-2）：true = 在线 SHASUMS 拉取失败直接失败，不回退缓存。
     * 缺省读环境变量 KUROBRIDGE_NODE_DIST_STRICT=1，未设为 false（回退 + WARN）。
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

/** dist 基址 + 版本 → 该版本的下载目录与 SHASUMS 地址（基址去尾斜杠）。 */
export function distUrls(
    distBase: string,
    version: string,
): { distDir: string; shasumsUrl: string } {
    const base = distBase.replace(TRAILING_SLASHES, "");
    const distDir = `${base}/v${version}`;
    return { distDir, shasumsUrl: `${distDir}/SHASUMS256.txt` };
}

/** 某目标的归档下载地址（zip / tar.gz 由目标定义）。 */
export function archiveUrl(distBase: string, version: string, target: RuntimeTarget): string {
    return `${distUrls(distBase, version).distDir}/${archiveName(version, target)}`;
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

/** 主流程：逐目标确保归档就位（下载/校验/缓存）→ [napuketto 依赖树打包] → 产物（幂等）。 */
export async function runEmbed(options: EmbedOptions): Promise<EmbedResult> {
    const log = options.log ?? ((message: string) => console.log(message));
    const download = options.download ?? fetchUrl;
    const distBase = options.distBase ?? process.env[ENV_DIST_BASE] ?? DEFAULT_DIST_BASE;
    const strict = options.strict ?? process.env[ENV_STRICT] === "1";
    const targets = options.targets.map((key) => runtimeTarget(key));
    if (targets.length === 0) {
        throw new Error("targets 为空：至少需要一个内嵌目标（win-x64 / linux-x64 / linux-arm64）");
    }

    const bundleData = await readProduct(
        options.distBundle,
        `bridge/embedded 产物（先 pnpm -r build）`,
    );
    const shasums = parseShasums(
        await ensureShasums({
            cacheDir: options.cacheDir,
            shasumsUrl: distUrls(distBase, NODE_VERSION).shasumsUrl,
            download,
            log,
            strict,
        }),
    );
    const { runtimeProducts, license } = await extractRuntimes({
        targets,
        shasums,
        cacheDir: options.cacheDir,
        distBase,
        download,
        log,
    });
    const { sharedProducts, napukettoZipSha } = await collectSharedProducts({
        cacheDir: options.cacheDir,
        napuketto: options.napuketto,
        license,
        bundle: bundleData,
        log,
    });

    await mkdir(options.outDir, { recursive: true });
    const written = await writeProducts(options.outDir, sharedProducts, runtimeProducts, log);
    await pruneStaleRuntimes(
        options.outDir,
        new Set(runtimeProducts.map((product) => product.name)),
        log,
    );
    const manifestBody = buildManifest(written.shared, written.runtimes, napukettoZipSha, options);
    const manifestData = Buffer.from(`${JSON.stringify(manifestBody, null, 4)}\n`, "utf8");
    const outcome = await writeIfChanged(
        join(options.outDir, MANIFEST_NAME),
        manifestData,
        sha256Buffer(manifestData),
    );
    (outcome ? written.copied : written.reused).push(MANIFEST_NAME);
    log(`[embed] ${MANIFEST_NAME} ${outcome ? "已写入" : "已就绪（内容一致，跳过）"}`);

    log(
        `[embed] 完成：写入 ${written.copied.length} / 复用 ${written.reused.length}` +
            `（node ${NODE_VERSION}；目标 ${targets.map((target) => target.key).join(", ")}）`,
    );
    return { copied: written.copied, reused: written.reused };
}

interface RuntimeProduct {
    readonly key: string;
    readonly name: string;
    readonly data: Buffer;
}

interface SharedProduct {
    readonly name: string;
    readonly data: Buffer;
}

/** 逐目标取二进制；LICENSE 各平台文本一致，取首个归档的即可。 */
async function extractRuntimes(deps: {
    targets: readonly RuntimeTarget[];
    shasums: Map<string, string>;
    cacheDir: string;
    distBase: string;
    download: (url: string) => Promise<Buffer>;
    log: (message: string) => void;
}): Promise<{ runtimeProducts: RuntimeProduct[]; license: Buffer }> {
    const runtimeProducts: RuntimeProduct[] = [];
    let license: Buffer | undefined;
    for (const target of deps.targets) {
        const archive = await ensureArchive({
            target,
            version: NODE_VERSION,
            shasums: deps.shasums,
            cacheDir: deps.cacheDir,
            distBase: deps.distBase,
            download: deps.download,
            log: deps.log,
        });
        runtimeProducts.push({
            key: target.key,
            name: target.productName,
            data: readArchiveEntry(target, archive, nodeEntryPath(NODE_VERSION, target)),
        });
        license ??= readArchiveEntry(target, archive, licenseEntryPath(NODE_VERSION, target));
    }
    if (license === undefined) {
        throw new Error("未能从任何归档取到 LICENSE（targets 非空却无产物）");
    }
    return { runtimeProducts, license };
}

/** 平台无关产物：许可 + bundle + 可选 napuketto 嵌包。 */
async function collectSharedProducts(deps: {
    cacheDir: string;
    napuketto: EmbedOptions["napuketto"];
    license: Buffer;
    bundle: Buffer;
    log: (message: string) => void;
}): Promise<{ sharedProducts: SharedProduct[]; napukettoZipSha: string | undefined }> {
    const sharedProducts: SharedProduct[] = [
        { name: PRODUCT_LICENSE, data: deps.license },
        { name: PRODUCT_BUNDLE, data: deps.bundle },
    ];
    if (deps.napuketto === undefined) {
        return { sharedProducts, napukettoZipSha: undefined };
    }
    const bundle = await ensureNapukettoBundle({
        cacheDir: deps.cacheDir,
        cliVersion: deps.napuketto.cliVersion,
        install: deps.napuketto.install ?? defaultInstallNapuketto,
        log: deps.log,
    });
    sharedProducts.push({ name: PRODUCT_NAPUKETTO_ZIP, data: bundle.zip });
    sharedProducts.push({ name: PRODUCT_NAPUKETTO_LICENSES, data: bundle.licenses });
    return { sharedProducts, napukettoZipSha: sha256Buffer(bundle.zip) };
}

/** 写产物（幂等）并汇总 manifest 需要的 sha 映射。 */
async function writeProducts(
    outDir: string,
    sharedProducts: readonly SharedProduct[],
    runtimeProducts: readonly RuntimeProduct[],
    log: (message: string) => void,
): Promise<{
    copied: string[];
    reused: string[];
    shared: Record<string, string>;
    runtimes: EmbeddedManifestV2["runtimes"];
}> {
    const copied: string[] = [];
    const reused: string[] = [];
    const shared: Record<string, string> = {};
    const runtimes: EmbeddedManifestV2["runtimes"] = {};
    for (const product of sharedProducts) {
        const digest = sha256Buffer(product.data);
        shared[product.name] = digest;
        await writeProduct(outDir, product.name, product.data, digest, "", copied, reused, log);
    }
    for (const product of runtimeProducts) {
        const digest = sha256Buffer(product.data);
        runtimes[product.key] = { file: product.name, sha256: digest };
        await writeProduct(
            outDir,
            product.name,
            product.data,
            digest,
            `（${product.key}）`,
            copied,
            reused,
            log,
        );
    }
    return { copied, reused, shared, runtimes };
}

async function writeProduct(
    outDir: string,
    name: string,
    data: Buffer,
    digest: string,
    note: string,
    copied: string[],
    reused: string[],
    log: (message: string) => void,
): Promise<void> {
    const outcome = await writeIfChanged(join(outDir, name), data, digest);
    (outcome ? copied : reused).push(name);
    log(`[embed] ${name}${note} ${outcome ? "已写入" : "已就绪（sha256 一致，跳过）"} ${digest}`);
}

/** 组装 manifest v2（napukettoZip 仅在嵌包参与时出现）。 */
function buildManifest(
    shared: Record<string, string>,
    runtimes: EmbeddedManifestV2["runtimes"],
    napukettoZipSha: string | undefined,
    options: EmbedOptions,
): {
    schemaVersion: 2;
    nodeVersion: string;
    shared: Record<string, string>;
    runtimes: EmbeddedManifestV2["runtimes"];
    napukettoZip?: { name: string; sha256: string; cliVersion: string | undefined };
} {
    const manifest: {
        schemaVersion: 2;
        nodeVersion: string;
        shared: Record<string, string>;
        runtimes: EmbeddedManifestV2["runtimes"];
        napukettoZip?: { name: string; sha256: string; cliVersion: string | undefined };
    } = { schemaVersion: 2, nodeVersion: NODE_VERSION, shared, runtimes };
    if (napukettoZipSha !== undefined) {
        manifest.napukettoZip = {
            name: PRODUCT_NAPUKETTO_ZIP,
            sha256: napukettoZipSha,
            cliVersion: options.napuketto?.cliVersion,
        };
    }
    return manifest;
}

/**
 * 从归档取条目：zip 与 tar.gz 两种读取器，按目标定义择一。
 * 导出供测试直接覆盖两条分支。
 */
export function readArchiveEntry(
    target: RuntimeTarget,
    archive: Buffer,
    entryPath: string,
): Buffer {
    return target.archiveFormat === "zip"
        ? extractZipEntry(archive, entryPath)
        : extractTarGzEntry(archive, entryPath);
}

/** 内嵌运行时产物名（含历史命名 node.exe 与 Lean 切换后残留的平台二进制）。 */
const RUNTIME_PRODUCT_NAME = /^node(-[a-z0-9]+)*(\.exe)?$/;

/**
 * 清理不属于本次目标的旧运行时产物。
 *
 * 场景：从三平台 Universal 切到 `KUROBRIDGE_EMBED_TARGETS=win-x64` 的 Lean 构建、或旧版本
 * 的 `node.exe` 残留——不清理就会被打进 JAR（体积白涨，release.ts 的条目校验也失去意义）。
 * 只匹配 `node*` 形态的文件名，`manifest.json` / `index.mjs` / 许可等共享产物不受影响。
 */
async function pruneStaleRuntimes(
    outDir: string,
    keep: ReadonlySet<string>,
    log: (message: string) => void,
): Promise<void> {
    for (const name of await readdir(outDir)) {
        if (!RUNTIME_PRODUCT_NAME.test(name) || keep.has(name)) {
            continue;
        }
        await rm(join(outDir, name), { force: true });
        log(`[embed] 清理过期内嵌产物：${name}`);
    }
}

/** 确保某目标的归档在缓存就位且 sha256 与官方 SHASUMS256.txt 一致；返回其内容。 */
async function ensureArchive(dependencies: {
    target: RuntimeTarget;
    version: string;
    shasums: Map<string, string>;
    cacheDir: string;
    distBase: string;
    download: (url: string) => Promise<Buffer>;
    log: (message: string) => void;
}): Promise<Buffer> {
    const { target, version, shasums, cacheDir, distBase, download, log } = dependencies;
    const name = archiveName(version, target);
    const expected = shasums.get(name);
    if (expected === undefined) {
        throw new Error(`SHASUMS256.txt 缺少 ${name} 条目`);
    }
    const cachedArchive = join(cacheDir, name);
    if (await fileExists(cachedArchive)) {
        const cached = await readFile(cachedArchive);
        if (sha256Buffer(cached) === expected) {
            log(`[embed] 缓存命中 ${name}`);
            return cached;
        }
        log(`[embed] 缓存 ${name} 哈希不符（版本更换？），重新下载`);
    }
    const url = archiveUrl(distBase, version, target);
    log(`[embed] 下载 ${url}`);
    const archive = await download(url);
    const actual = sha256Buffer(archive);
    if (actual !== expected) {
        throw new Error(
            `${name} sha256 校验失败：期望 ${expected}，实际 ${actual}（可经 ${ENV_DIST_BASE} 换镜像重试）`,
        );
    }
    await mkdir(cacheDir, { recursive: true });
    const tmp = `${cachedArchive}.tmp`;
    await writeFile(tmp, archive);
    await rename(tmp, cachedArchive);
    return archive;
}

/**
 * 取官方 SHASUMS256.txt 文本：优先在线拉取；失败时——严格模式直接失败（拒绝信任缓存值），
 * 非严格回退缓存并 WARN 明示来源（离线复用上次校验值，DEBT-2）。
 */
async function ensureShasums(dependencies: {
    cacheDir: string;
    shasumsUrl: string;
    download: (url: string) => Promise<Buffer>;
    log: (message: string) => void;
    strict: boolean;
}): Promise<string> {
    const { cacheDir, shasumsUrl, download, log, strict } = dependencies;
    const cachedShasums = join(cacheDir, "SHASUMS256.txt");
    try {
        const text = (await download(shasumsUrl)).toString("utf8");
        await mkdir(cacheDir, { recursive: true });
        const tmp = `${cachedShasums}.tmp`;
        await writeFile(tmp, text, "utf8");
        await rename(tmp, cachedShasums);
        return text;
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
        return readFile(cachedShasums, "utf8");
    }
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

/** 腾讯闭源件红线三类（红线 5 / ADR-014 / docs/guides/build.md 嵌入式打包 / ADR-029 嵌包边界）：
 *  wrapper.node（腾讯闭源 NAPI 模块）、QQNT 系二进制、QQ 安装包——绝不进 JAR 不进仓。 */
const WRAPPER_NODE_FILE = "wrapper.node";
const QQNT_BINARY_NAME = /^QQNT.+\.(dll|exe|so|dylib)$/i;
const QQ_INSTALLER_NAME = /^QQ.+\.(exe|apk|dmg|msi)$/i;

/**
 * 腾讯闭源件扫描断言（zip 写入前调用，把注释里的虚 claim 变真门禁）：entries 为待打包的
 * napuketto 嵌包文件路径列表（"/" 分隔的 zip 相对名，collectZipEntries 产物），按 basename
 * 匹配三类红线件，命中即 throw（napuketto 运行期自取，无需嵌入）。
 */
export function assertNoTencentClosedSource(entries: readonly string[]): void {
    for (const entry of entries) {
        const name = basename(entry);
        if (
            name === WRAPPER_NODE_FILE ||
            QQNT_BINARY_NAME.test(name) ||
            QQ_INSTALLER_NAME.test(name)
        ) {
            throw new Error(
                `napuketto 嵌包含腾讯闭源件：${entry}` +
                    "（红线 5 / ADR-014 / docs/guides/build.md 嵌入式打包：wrapper.node、QQNT 二进制与 QQ" +
                    " 安装包绝不进 JAR 不进仓，napuketto 运行期自取；请检查依赖树里混入的来源）",
            );
        }
    }
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
    assertNoTencentClosedSource(entries.map((entry) => entry.name));
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

/** 缺省安装器：npm install 到 targetDir（真实文件，非 pnpm symlink）；镜像经 KUROBRIDGE_NPM_REGISTRY */
function defaultInstallNapuketto(version: string, targetDir: string): void {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
        join(targetDir, "package.json"),
        `${JSON.stringify({ name: "kurobridge-napuketto-bundle", private: true, version: "0.0.0" }, null, 4)}\n`,
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

/**
 * 嵌入目标清单（SSOT）：paper 与 fabric 各一份同内容产物——manifest 契约不变，
 * :core EmbeddedRuntime 原样消费（多平台共享同一解压链，platforms/je/fabric/docs/design.md §6）。
 * 新增平台 = 在此追加一行 + build-jar.ts 追加对应 gradle 构件步骤。
 */
export function defaultEmbedTargets(repoRoot: string): string[] {
    return [
        join(repoRoot, "platforms", "je", "paper", "src", "main", "resources", "embedded"),
        join(repoRoot, "platforms", "je", "fabric", "src", "main", "resources", "embedded"),
    ];
}

async function runCli(): Promise<void> {
    const root = REPO_ROOT;
    const targets = resolveEmbedTargets(RUNTIME, process.env[ENV_TARGETS]);
    const override = process.env[ENV_TARGETS];
    if (override !== undefined && override.trim() !== "") {
        console.log(`[embed] ${ENV_TARGETS}=${override} 覆盖默认目标：${targets.join(", ")}`);
    }
    const shared = {
        distBundle: join(root, "bridge", "embedded", "dist", "index.mjs"),
        cacheDir: process.env[ENV_CACHE_DIR] ?? join(root, ".cache", "node-dist"),
        targets,
        napuketto: { cliVersion: readNapukettoCliVersion(root) },
    };
    let copied = 0;
    let reused = 0;
    for (const outDir of defaultEmbedTargets(root)) {
        const result = await runEmbed({ ...shared, outDir });
        copied += result.copied.length;
        reused += result.reused.length;
    }
    console.log(`[embed] 产物目录就绪（写入 ${copied}，复用 ${reused}）`);
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
