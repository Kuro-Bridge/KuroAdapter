#!/usr/bin/env node
/**
 * toolings/packaging/release.ts —— 发布产物收拢（ADR-042）
 *
 * 前置（本脚本不替你构建）：
 *   pnpm build:jar                  → Paper shadowJar + Fabric remapJar + embedded 资源
 *   pnpm build:endstone             → portable 层回归（发布前必跑）
 *   cmake --build --preset windows-clang-cl → endstone_kurobridge.dll
 *
 * 输出（dist-release/，已 gitignore）：
 *   kurobridge-<ver>.jar            Paper universal（正式）
 *   kurobridge-fabric-<ver>.jar     Fabric mod（正式）
 *   kurobridge-lse-<ver>.zip        LSE 分发包（预览；解压到 plugins/kurobridge/）
 *   kurobridge-endstone-<ver>.zip   Endstone 分发包（预览；解压到 BDS 根）
 *   SHA256SUMS.txt
 *
 * 校验（任一失败即 exit 1）：
 *   1) 产物齐全且非空；2) embedded/manifest.json 的 sha256 逐文件比对；
 *   3) JAR 必需条目存在；4) JAR 条目名不含三类腾讯闭源件；5) zip 回读条目与预期一致。
 *
 * 依赖：Windows 用系统自带 tar.exe 写 zip（bsdtar，条目分隔符为 `/`）；POSIX 用 info-zip
 * 的 zip。两者都不引入新依赖。
 */

import { createHash } from "node:crypto";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IS_WIN32, run } from "../lib/proc.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const OUT_DIR = join(ROOT, "dist-release");
const EMBEDDED_DIR = join(ROOT, "platforms/je/paper/src/main/resources/embedded");
const MIN_JAR_BYTES = 30 * 1024 * 1024;

/** 腾讯闭源件：wrapper.node、QQNT 运行时库、QQ 安装包（ADR-029 红线） */
const FORBIDDEN_ENTRY_PATTERNS: readonly RegExp[] = [
    /(^|\/)wrapper\.node$/i,
    /(^|\/)QQNT[^/]*\.(dll|exe|so|dylib)$/i,
    /(^|\/)QQ[^/]*\.(exe|apk|dmg|msi)$/i,
];

const PAPER_REQUIRED_ENTRIES: readonly string[] = [
    "plugin.yml",
    "embedded/node.exe",
    "embedded/index.mjs",
    "embedded/manifest.json",
    "embedded/napuketto.zip",
    "embedded/NODE_LICENSE",
    "embedded/NAPUKETTO_LICENSES",
];

const FABRIC_REQUIRED_ENTRIES: readonly string[] = [
    "fabric.mod.json",
    "embedded/node.exe",
    "embedded/index.mjs",
    "embedded/manifest.json",
];

/** embedded/manifest.json 的形状（toolings/packaging/embed.ts 产出） */
interface EmbeddedManifest {
    readonly nodeVersion: string;
    readonly files: Readonly<Record<string, string>>;
    readonly napukettoZip?: { readonly sha256: string };
}

function fail(message: string): never {
    console.error(`[release] 失败：${message}`);
    process.exit(1);
}

function readJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function mustExist(path: string, label: string): void {
    if (!existsSync(path)) {
        fail(`${label} 缺失：${path}（先完成对应构建）`);
    }
    if (statSync(path).size === 0) {
        fail(`${label} 为空文件：${path}`);
    }
}

/** 从 EOCD 反向定位中央目录（不支持 ZIP64；发布产物远小于 4 GB） */
function findEocd(buffer: Buffer): number {
    const earliest = Math.max(0, buffer.length - 65557);
    for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
        if (buffer.readUInt32LE(offset) === 0x06054b50) {
            return offset;
        }
    }
    return fail("不是合法 zip：未找到 EOCD 记录");
}

/** 只读中央目录里的条目名，不做解压 */
function readZipEntries(path: string): string[] {
    const buffer = readFileSync(path);
    const eocd = findEocd(buffer);
    const count = buffer.readUInt16LE(eocd + 10);
    let cursor = buffer.readUInt32LE(eocd + 16);
    const names: string[] = [];
    for (let index = 0; index < count; index += 1) {
        if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
            fail(`zip 中央目录损坏：${path}`);
        }
        const nameLength = buffer.readUInt16LE(cursor + 28);
        const extraLength = buffer.readUInt16LE(cursor + 30);
        const commentLength = buffer.readUInt16LE(cursor + 32);
        const nameEnd = cursor + 46 + nameLength;
        if (nameEnd > buffer.length) {
            fail(`zip 条目名越界：${path}`);
        }
        names.push(buffer.subarray(cursor + 46, nameEnd).toString("utf8"));
        cursor = nameEnd + extraLength + commentLength;
    }
    return names;
}

/** embedded 清单自校验：文件 sha256 与 napuketto 指针必须与磁盘一致 */
function verifyEmbeddedManifest(): void {
    const manifestPath = join(EMBEDDED_DIR, "manifest.json");
    mustExist(manifestPath, "embedded 清单");
    const manifest = readJson<EmbeddedManifest>(manifestPath);
    for (const [name, expected] of Object.entries(manifest.files)) {
        const file = join(EMBEDDED_DIR, name);
        mustExist(file, `embedded/${name}`);
        const actual = sha256(file);
        if (actual !== expected) {
            fail(`embedded/${name} sha256 不符：清单 ${expected}，实际 ${actual}`);
        }
    }
    const napuketto = manifest.napukettoZip;
    if (napuketto !== undefined) {
        const actual = sha256(join(EMBEDDED_DIR, "napuketto.zip"));
        if (actual !== napuketto.sha256) {
            fail(`napuketto.zip sha256 不符：清单 ${napuketto.sha256}，实际 ${actual}`);
        }
    }
    console.log(
        `[release] embedded 清单通过：${Object.keys(manifest.files).length} 个文件 + napuketto 指针 sha256 一致`,
    );
}

/** JAR 结构、体积与闭源件红线 */
function assertJar(path: string, required: readonly string[], label: string): void {
    mustExist(path, label);
    const size = statSync(path).size;
    if (size < MIN_JAR_BYTES) {
        fail(`${label} 体积异常（${size} B < ${MIN_JAR_BYTES} B），疑似未嵌入运行时`);
    }
    const entries = readZipEntries(path);
    for (const entry of entries) {
        for (const pattern of FORBIDDEN_ENTRY_PATTERNS) {
            if (pattern.test(entry)) {
                fail(`${label} 命中腾讯闭源件红线：${entry}`);
            }
        }
    }
    for (const entry of required) {
        if (!entries.includes(entry)) {
            fail(`${label} 缺少条目：${entry}`);
        }
    }
    console.log(
        `[release] ${label} 通过：${entries.length} 条目 / ${(size / 1024 / 1024).toFixed(1)} MB`,
    );
}

function copyInto(source: string, target: string): void {
    mustExist(source, `源文件 ${basename(source)}`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
}

/** 打 zip 并回读条目名，确保分隔符与预期一致（tar.exe 写 `/`，Compress-Archive 写 `\`） */
function zipStage(stage: string, out: string, entries: readonly string[]): void {
    rmSync(out, { force: true });
    if (IS_WIN32) {
        run("release zip", "tar.exe", ["-a", "-c", "-f", out, "-C", stage, ...entries]);
    } else {
        run("release zip", "zip", ["-q", "-r", out, ...entries], { cwd: stage });
    }
    const actual = readZipEntries(out).sort();
    const expected = [...entries].sort();
    if (actual.join("\n") !== expected.join("\n")) {
        fail(
            `zip 条目与预期不符：${out}\n  实际：${actual.join(", ")}\n  预期：${expected.join(", ")}`,
        );
    }
}

/** LSE 分发包：解压到 <BDS 根>/plugins/kurobridge/；node 运行时由服主自备 */
function packLse(version: string): string {
    const stage = join(OUT_DIR, ".stage", "lse");
    const lseDir = join(ROOT, "platforms/be/lse");
    copyInto(join(lseDir, "manifest.json"), join(stage, "manifest.json"));
    copyInto(join(lseDir, "dist/index.js"), join(stage, "index.js"));
    copyInto(join(lseDir, "dist/bin/index.mjs"), join(stage, "bin/index.mjs"));
    const out = join(OUT_DIR, `kurobridge-lse-${version}.zip`);
    zipStage(stage, out, ["manifest.json", "index.js", "bin/index.mjs"]);
    console.log(`[release] LSE 分发包：${basename(out)}`);
    return out;
}

/** Endstone 分发包：解压到 BDS 根；manifest 只列实际随包的三个文件（不含 napuketto） */
function packEndstone(version: string): string {
    const stage = join(OUT_DIR, ".stage", "endstone");
    const binDir = join(stage, "plugins/kurobridge/bin");
    copyInto(
        join(ROOT, "platforms/be/endstone/build/windows-clang-cl/endstone_kurobridge.dll"),
        join(stage, "plugins/endstone_kurobridge.dll"),
    );
    const manifest = readJson<EmbeddedManifest>(join(EMBEDDED_DIR, "manifest.json"));
    const files: Record<string, string> = {};
    for (const name of ["node.exe", "index.mjs", "NODE_LICENSE"] as const) {
        const hash = manifest.files[name];
        if (hash === undefined) {
            fail(`embedded 清单缺少 ${name}`);
        }
        copyInto(join(EMBEDDED_DIR, name), join(binDir, name));
        files[name] = hash;
    }
    const generated = { nodeVersion: manifest.nodeVersion, files };
    writeFileSync(join(binDir, "manifest.json"), `${JSON.stringify(generated, null, 4)}\n`);
    const entries = [
        "plugins/endstone_kurobridge.dll",
        "plugins/kurobridge/bin/node.exe",
        "plugins/kurobridge/bin/index.mjs",
        "plugins/kurobridge/bin/NODE_LICENSE",
        "plugins/kurobridge/bin/manifest.json",
    ];
    const out = join(OUT_DIR, `kurobridge-endstone-${version}.zip`);
    zipStage(stage, out, entries);
    console.log(`[release] Endstone 分发包：${basename(out)}`);
    return out;
}

function main(): void {
    const { version } = readJson<{ version: string }>(join(ROOT, "package.json"));
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
    verifyEmbeddedManifest();

    const paperSource = join(ROOT, `platforms/je/paper/build/libs/kurobridge-${version}.jar`);
    const fabricSource = join(
        ROOT,
        `platforms/je/fabric/build/libs/kurobridge-fabric-${version}.jar`,
    );
    mustExist(paperSource, `Paper JAR（版本 ${version}）`);
    mustExist(fabricSource, `Fabric JAR（版本 ${version}）`);

    const paperOut = join(OUT_DIR, `kurobridge-${version}.jar`);
    const fabricOut = join(OUT_DIR, `kurobridge-fabric-${version}.jar`);
    copyFileSync(paperSource, paperOut);
    copyFileSync(fabricSource, fabricOut);
    assertJar(paperOut, PAPER_REQUIRED_ENTRIES, "Paper JAR");
    assertJar(fabricOut, FABRIC_REQUIRED_ENTRIES, "Fabric JAR");

    const lseOut = packLse(version);
    const endstoneOut = packEndstone(version);

    const files = [paperOut, fabricOut, lseOut, endstoneOut];
    const lines = files
        .sort((left, right) => basename(left).localeCompare(basename(right)))
        .map((file) => `${sha256(file)}  ${basename(file)}`);
    writeFileSync(join(OUT_DIR, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
    rmSync(join(OUT_DIR, ".stage"), { recursive: true, force: true });

    console.log(`[release] 完成：${files.length} 个产物 + SHA256SUMS.txt → ${OUT_DIR}`);
    for (const line of lines) {
        console.log(`  ${line}`);
    }
}

main();
