/**
 * toolings/packaging/embed.ts 单测（多平台矩阵批次）。
 *
 * 两条归档读取链都在测试内手搓 fixture，不发真网：
 * - zip（Windows 目标）：本地头 + 中央目录 + EOCD，stored/deflate 两法；
 * - tar.gz（Linux 目标）：512 字节头 + ustar/PAX/GNU LongName 变体 + gzip。
 * node 二进制 / LICENSE / index.mjs 全部是假内容，重点验证「名字解析与偏移量」。
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { type RuntimeManifest, resolveEmbedTargets } from "../lib/runtime.js";
import {
    archiveName,
    archiveUrl,
    assertNoTencentClosedSource,
    buildZip,
    collectLicenses,
    collectZipEntries,
    defaultEmbedTargets,
    distUrls,
    type EmbedResult,
    extractZipEntry,
    licenseEntryPath,
    NODE_VERSION,
    nodeEntryPath,
    parseShasums,
    readArchiveEntry,
    runEmbed,
    runtimeTarget,
} from "./embed.js";
import { extractTarEntry, extractTarGzEntry } from "./tar.js";

function sha256(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
}

/** 假 npm install：造一个最小但结构真实的依赖树（真实文件，含 @scope 包与 .bin 噪声） */
function fakeNapukettoInstall(_version: string, targetDir: string): void {
    const nm = join(targetDir, "node_modules");
    const cli = join(nm, "@napuketto", "cli");
    mkdirSync(join(cli, "dist"), { recursive: true });
    writeFileSync(
        join(cli, "package.json"),
        JSON.stringify({ name: "@napuketto/cli", version: _version, license: "MIT" }),
        "utf8",
    );
    writeFileSync(join(cli, "dist", "index.mjs"), "// napuketto cli entry", "utf8");
    writeFileSync(join(cli, "LICENSE"), "MIT license text (cli)", "utf8");
    const kernel = join(nm, "@napuketto", "kernel");
    mkdirSync(kernel, { recursive: true });
    writeFileSync(join(kernel, "package.json"), "{}", "utf8");
    writeFileSync(join(kernel, "LICENSE.md"), "MIT license text (kernel)", "utf8");
    const zod = join(nm, "zod");
    mkdirSync(zod, { recursive: true });
    writeFileSync(join(zod, "package.json"), "{}", "utf8");
    writeFileSync(join(zod, "LICENSE"), "MIT license text (zod)", "utf8");
    mkdirSync(join(nm, ".bin"), { recursive: true });
    writeFileSync(join(nm, ".bin", "napuketto.cmd"), "shim should not be bundled", "utf8");
}

interface TestEntry {
    name: string;
    data: Buffer;
    method?: 0 | 8;
}

/** 手搓最小 zip（无 extra/comment，数据紧跟本地头；中央目录 + EOCD 收尾）。 */
function testZip(entries: TestEntry[]): Buffer {
    const parts: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, "latin1");
        const method = entry.method ?? 8;
        const compressed = method === 0 ? entry.data : deflateRawSync(entry.data);
        const checksum = crc32(entry.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        parts.push(local, name, compressed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(entry.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);

        offset += 30 + name.length + compressed.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, cd, eocd]);
}

// ---- tar.gz fixture（与 tar.ts 的读取面严格对应）----

function writeOctal(buffer: Buffer, start: number, length: number, value: number): void {
    const text = value.toString(8).padStart(length - 1, "0");
    buffer.write(text, start, "ascii");
    buffer[start + length - 1] = 0;
}

/** 造一个 tar 头 + 数据块；prefix 用于 ustar 长路径字段。 */
function tarChunk(name: string, data: Buffer, typeflag = "0", prefix = ""): Buffer {
    const header = Buffer.alloc(512);
    header.write(name, 0, Math.min(Buffer.byteLength(name), 100), "utf8");
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.length);
    writeOctal(header, 136, 12, 0);
    header.write("        ", 148, "ascii"); // checksum 占位 = 8 空格
    header[156] = typeflag.charCodeAt(0);
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    if (prefix !== "") {
        header.write(prefix, 345, Math.min(Buffer.byteLength(prefix), 155), "ascii");
    }
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeOctal(header, 148, 8, checksum);

    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    return Buffer.concat([header, padded]);
}

/** PAX 记录：`<长度> <键>=<值>\n`，长度含自身；迭代到稳定值。 */
function paxRecord(key: string, value: string): Buffer {
    const body = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(body) + 1;
    for (;;) {
        const candidate = `${length}${body}`;
        const actual = Buffer.byteLength(candidate);
        if (actual === length) {
            return Buffer.from(candidate, "utf8");
        }
        length = actual;
    }
}

function testTar(chunks: Buffer[]): Buffer {
    return Buffer.concat([...chunks, Buffer.alloc(1024)]); // 两个零块收尾
}

function testTarGz(chunks: Buffer[]): Buffer {
    return gzipSync(testTar(chunks));
}

describe("parseShasums", () => {
    it("解析标准行（两空格分隔），容忍 CRLF 与无关行", () => {
        const text = [
            "# signify 公钥签名说明行会被忽略",
            `${"a".repeat(64)}  node-v${NODE_VERSION}-win-x64.zip`,
            `${"b".repeat(64)}  node-v${NODE_VERSION}-linux-x64.tar.gz\r`,
            "",
        ].join("\n");
        expect(parseShasums(text)).toEqual(
            new Map([
                [`node-v${NODE_VERSION}-win-x64.zip`, "a".repeat(64)],
                [`node-v${NODE_VERSION}-linux-x64.tar.gz`, "b".repeat(64)],
            ]),
        );
    });

    it("空文本/全噪声行 → 空映射", () => {
        expect(parseShasums("").size).toBe(0);
        expect(parseShasums("not a checksum line\nanother").size).toBe(0);
    });
});

describe("distUrls / archiveName / 归档内路径", () => {
    it("dist 目录 + SHASUMS 地址，基址尾斜杠归一", () => {
        expect(distUrls("https://nodejs.org/dist/", NODE_VERSION)).toEqual({
            distDir: `https://nodejs.org/dist/v${NODE_VERSION}`,
            shasumsUrl: `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`,
        });
        expect(distUrls("https://npmmirror.com/mirrors/node", NODE_VERSION).distDir).toContain(
            `npmmirror.com/mirrors/node/v${NODE_VERSION}`,
        );
    });

    it("Windows 用 zip + 根目录 node.exe；Linux 用 tar.gz + bin/node", () => {
        const win = runtimeTarget("win-x64");
        const linux = runtimeTarget("linux-arm64");
        expect(archiveName(NODE_VERSION, win)).toBe(`node-v${NODE_VERSION}-win-x64.zip`);
        expect(archiveName(NODE_VERSION, linux)).toBe(`node-v${NODE_VERSION}-linux-arm64.tar.gz`);
        expect(nodeEntryPath(NODE_VERSION, win)).toBe(`node-v${NODE_VERSION}-win-x64/node.exe`);
        expect(nodeEntryPath(NODE_VERSION, linux)).toBe(
            `node-v${NODE_VERSION}-linux-arm64/bin/node`,
        );
        expect(licenseEntryPath(NODE_VERSION, linux)).toBe(
            `node-v${NODE_VERSION}-linux-arm64/LICENSE`,
        );
        expect(archiveUrl("https://example.test", NODE_VERSION, linux)).toBe(
            `https://example.test/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.gz`,
        );
    });

    it("未知目标直接抛错（覆盖列表的合法性收口）", () => {
        expect(() => runtimeTarget("freebsd-x64")).toThrow("未知的内嵌目标");
    });
});

describe("resolveEmbedTargets（KUROBRIDGE_EMBED_TARGETS 覆盖）", () => {
    const manifest: RuntimeManifest = {
        nodeVersion: NODE_VERSION,
        targets: ["win-x64", "linux-x64", "linux-arm64"],
    };

    it("未设置/空串 → manifest 的 targets", () => {
        expect(resolveEmbedTargets(manifest, undefined)).toEqual(manifest.targets);
        expect(resolveEmbedTargets(manifest, "  ")).toEqual(manifest.targets);
    });

    it("逗号分隔覆盖、去空白、去重保序", () => {
        expect(resolveEmbedTargets(manifest, "linux-x64, win-x64 ")).toEqual([
            "linux-x64",
            "win-x64",
        ]);
        expect(resolveEmbedTargets(manifest, "linux-x64,linux-x64")).toEqual(["linux-x64"]);
    });

    it("未知目标/全空 → 抛错（不做静默忽略）", () => {
        expect(() => resolveEmbedTargets(manifest, "win-x64,darwin-arm64")).toThrow(
            "未知目标：darwin-arm64",
        );
        expect(() => resolveEmbedTargets(manifest, " , ")).toThrow("为空");
    });
});

describe("defaultEmbedTargets", () => {
    it("覆盖 paper 与 fabric 两平台的 embedded 资源目录（嵌入目标 SSOT）", () => {
        expect(defaultEmbedTargets("/repo")).toEqual([
            join("/repo", "platforms", "je", "paper", "src", "main", "resources", "embedded"),
            join("/repo", "platforms", "je", "fabric", "src", "main", "resources", "embedded"),
        ]);
    });
});

describe("extractZipEntry", () => {
    it("deflate 与 stored 条目均按内容取出并过 crc32", () => {
        const deflateData = Buffer.from("fake node exe binary payload");
        const storedData = Buffer.from("Node.js license (MIT) fake text");
        const dir = `node-v${NODE_VERSION}-win-x64`;
        const zip = testZip([
            { name: `${dir}/node.exe`, data: deflateData, method: 8 },
            { name: `${dir}/LICENSE`, data: storedData, method: 0 },
        ]);
        expect(extractZipEntry(zip, `${dir}/node.exe`)).toEqual(deflateData);
        expect(extractZipEntry(zip, `${dir}/LICENSE`)).toEqual(storedData);
    });

    it("条目不存在 → 报错", () => {
        const zip = testZip([{ name: "a.txt", data: Buffer.from("x") }]);
        expect(() => extractZipEntry(zip, "missing.txt")).toThrow("找不到条目");
    });

    it("内容损坏（crc32 不符）→ 报错", () => {
        // stored 条目：本地头(30) + 名(5) 之后即数据段，破坏它直接命中 crc32 校验
        const zip = testZip([{ name: "a.txt", data: Buffer.from("hello"), method: 0 }]);
        const dataOffset = 30 + "a.txt".length;
        zip[dataOffset] = (zip[dataOffset] ?? 0) ^ 0xff;
        expect(() => extractZipEntry(zip, "a.txt")).toThrow("crc32");
    });
});

describe("extractTarGzEntry（Linux 归档：PAX / GNU LongName / 目录跳过）", () => {
    const dir = `node-v${NODE_VERSION}-linux-x64`;

    it("常规路径：目录条目先出现也不影响后续按偏移取 bin/node", () => {
        const node = Buffer.from("ELF fake node binary");
        const license = Buffer.from("Node license");
        const tar = testTarGz([
            tarChunk(`${dir}/`, Buffer.alloc(0), "5"), // 目录：typeflag '5'
            tarChunk(`${dir}/bin/`, Buffer.alloc(0), "5"),
            tarChunk(`${dir}/bin/node`, node),
            tarChunk(`${dir}/LICENSE`, license),
        ]);
        expect(extractTarGzEntry(tar, `${dir}/bin/node`)).toEqual(node);
        expect(extractTarGzEntry(tar, `${dir}/LICENSE`)).toEqual(license);
    });

    it("GNU LongName（typeflag 'L'，路径超 100 字节）→ 按长名命中，不按截断名误判", () => {
        const longDir = `node-v${NODE_VERSION}-linux-x64-${"x".repeat(90)}`;
        const longPath = `${longDir}/bin/node`;
        const node = Buffer.from("long-name node");
        const tar = testTarGz([
            // GNU LongLink 前导块：名字固定，数据段是真实长路径（含尾 NUL）
            tarChunk("././@LongLink", Buffer.from(`${longPath}\0`, "utf8"), "L"),
            // 随后的真实条目只带截断名（>100 字节会被写坏），读取器必须用 LongName 覆盖
            tarChunk(`${longPath.slice(0, 100)}`, node),
        ]);
        expect(extractTarGzEntry(tar, longPath)).toEqual(node);
        expect(() => extractTarGzEntry(tar, `${longPath.slice(0, 100)}`)).toThrow("找不到条目");
    });

    it("PAX 扩展头（typeflag 'x' 的 path= 记录）→ 按 PAX 路径命中", () => {
        const longPath = `${dir}/${"deep/".repeat(20)}bin/node`;
        const node = Buffer.from("pax node");
        const records = paxRecord("path", longPath);
        const tar = testTarGz([
            tarChunk("PaxHeaders/0", records, "x"),
            tarChunk("truncated-name", node), // 头里放无关短名，真实名字由 PAX 提供
        ]);
        expect(extractTarGzEntry(tar, longPath)).toEqual(node);
        expect(() => extractTarGzEntry(tar, "truncated-name")).toThrow("找不到条目");
    });

    it("ustar prefix 字段拼出完整路径", () => {
        const node = Buffer.from("prefix node");
        const tar = testTarGz([tarChunk("bin/node", node, "0", dir)]);
        expect(extractTarGzEntry(tar, `${dir}/bin/node`)).toEqual(node);
    });

    it("命中即返回：目标之后的块损坏也不影响（提前结束）", () => {
        const node = Buffer.from("early exit node");
        const tar = testTarGz([
            tarChunk(`${dir}/bin/node`, node),
            // 故意破坏后续头（checksum 不符）；若读取器继续扫描就会抛错
            Buffer.alloc(512, 0xff),
        ]);
        expect(extractTarGzEntry(tar, `${dir}/bin/node`)).toEqual(node);
    });

    it("checksum 损坏 → 报错而不是按错位继续扫", () => {
        const tar = testTar([tarChunk(`${dir}/bin/node`, Buffer.from("x"))]);
        tar[0] = (tar[0] ?? 0) ^ 0xff; // 破坏 name 字段首字节 → checksum 不符
        expect(() => extractTarEntry(tar, `${dir}/bin/node`)).toThrow("checksum");
    });

    it("条目不存在 / 归档被截断 → 明确报错", () => {
        const tar = testTarGz([tarChunk(`${dir}/bin/node`, Buffer.from("x"))]);
        expect(() => extractTarGzEntry(tar, `${dir}/LICENSE`)).toThrow("找不到条目");
    });
});

describe("readArchiveEntry（按目标格式分发）", () => {
    it("zip 目标走 zip reader，tar.gz 目标走 tar reader", () => {
        const dir = `node-v${NODE_VERSION}-linux-arm64`;
        const tar = testTarGz([tarChunk(`${dir}/bin/node`, Buffer.from("tar payload"))]);
        expect(readArchiveEntry(runtimeTarget("linux-arm64"), tar, `${dir}/bin/node`)).toEqual(
            Buffer.from("tar payload"),
        );

        const winDir = `node-v${NODE_VERSION}-win-x64`;
        const zip = testZip([{ name: `${winDir}/node.exe`, data: Buffer.from("zip payload") }]);
        expect(readArchiveEntry(runtimeTarget("win-x64"), zip, `${winDir}/node.exe`)).toEqual(
            Buffer.from("zip payload"),
        );
    });
});

describe("buildZip / collectZipEntries / collectLicenses（MVP-4）", () => {
    it("buildZip 产物可被既有 reader 读回（deflate/stored 对称）", () => {
        const small = Buffer.from("x"); // 压缩后更大 → stored
        const large = Buffer.from("deflate me please ".repeat(50)); // 压缩更小 → deflate
        const zip = buildZip([
            { name: "node_modules/a/pkg/stored.bin", data: small },
            { name: "node_modules/a/pkg/deflated.js", data: large },
        ]);
        expect(extractZipEntry(zip, "node_modules/a/pkg/stored.bin")).toEqual(small);
        expect(extractZipEntry(zip, "node_modules/a/pkg/deflated.js")).toEqual(large);
    });

    it("collectZipEntries：扁平化为 zip 名（node_modules/ 前缀 + / 分隔）、跳过 .bin 与 symlink、排序稳定", async () => {
        const root = await mkdtemp(join(tmpdir(), "kurobridge-nk-"));
        try {
            fakeNapukettoInstall("1.2.3", root);
            const entries = await collectZipEntries(join(root, "node_modules"));
            const names = entries.map((entry) => entry.name);
            expect(names).toEqual([
                "node_modules/@napuketto/cli/LICENSE",
                "node_modules/@napuketto/cli/dist/index.mjs",
                "node_modules/@napuketto/cli/package.json",
                "node_modules/@napuketto/kernel/LICENSE.md",
                "node_modules/@napuketto/kernel/package.json",
                "node_modules/zod/LICENSE",
                "node_modules/zod/package.json",
            ]);
            expect(names.some((name) => name.includes(".bin"))).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("collectLicenses：聚合全部顶层包许可（@scope 下钻），一包一许可带路径头", async () => {
        const root = await mkdtemp(join(tmpdir(), "kurobridge-nk-"));
        try {
            fakeNapukettoInstall("1.2.3", root);
            const licenses = (await collectLicenses(join(root, "node_modules"))).toString("utf8");
            expect(licenses).toContain("MIT license text (cli)");
            expect(licenses).toContain("MIT license text (kernel)");
            expect(licenses).toContain("MIT license text (zod)");
            expect(licenses).toContain("node_modules/@napuketto/cli/LICENSE");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe("assertNoTencentClosedSource（腾讯闭源件红线门禁，ADR-034）", () => {
    it("干净列表（npm 发布物）通过：含 loader 自研 stub 与 7zip 资产", () => {
        expect(() =>
            assertNoTencentClosedSource([
                "node_modules/@napuketto/cli/dist/index.mjs",
                "node_modules/@napuketto/loader/assets/7zip/7z.dll",
                // 自研 stub（ADR-029，原样分发）：裸名 QQNT.dll 无间隔字样，不命中 QQNT 正则（.+ 要求间隔）
                "node_modules/@napuketto/loader/assets/stub/QQNT.dll",
            ]),
        ).not.toThrow();
    });

    it("三类违例各被拒：wrapper.node / QQNT 二进制 / QQ 安装包（basename 匹配、大小写不敏感）", () => {
        const violations = [
            "node_modules/napuketto/wrapper.node",
            "node_modules/@napuketto/cli/vendor/QQNTWrap.dll",
            "node_modules/x/bin/QQNTBootstrap.exe",
            "node_modules/dl/QQ9.9.9-Installer.exe",
            "node_modules/dl/QQ_7.1.apk",
            "node_modules/dl/QQSetup.DMG",
        ];
        for (const entry of violations) {
            expect(() => assertNoTencentClosedSource([entry]), entry).toThrow("腾讯闭源件");
        }
    });

    it("文件名精确相等才命中：相似名/路径段含字样不误伤", () => {
        expect(() =>
            assertNoTencentClosedSource([
                "node_modules/docs/wrapper.node.md",
                "node_modules/x/not-wrapper.node.txt",
                "node_modules/MYQQNTNOTES.txt",
            ]),
        ).not.toThrow();
    });
});

describe("runEmbed（多目标）", () => {
    const fakeWin = Buffer.from(`fake win node ${NODE_VERSION}`);
    const fakeLinux = Buffer.from(`fake linux node ${NODE_VERSION}`);
    const fakeLicense = Buffer.from("fake node license");
    const fakeBundle = Buffer.from("// fake embedded bundle");

    const tempDirs: string[] = [];
    const logs: string[] = [];

    afterEach(async () => {
        await Promise.all(
            tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
        );
    });

    async function makeTemp(): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), "kurobridge-embed-"));
        tempDirs.push(dir);
        return dir;
    }

    function winArchive(): Buffer {
        const dir = `node-v${NODE_VERSION}-win-x64`;
        return testZip([
            { name: `${dir}/node.exe`, data: fakeWin },
            { name: `${dir}/LICENSE`, data: fakeLicense },
        ]);
    }

    function linuxArchive(key: "linux-x64" | "linux-arm64" = "linux-x64"): Buffer {
        const dir = `node-v${NODE_VERSION}-${key}`;
        return testTarGz([
            tarChunk(`${dir}/bin/`, Buffer.alloc(0), "5"),
            tarChunk(`${dir}/bin/node`, fakeLinux),
            tarChunk(`${dir}/LICENSE`, fakeLicense),
        ]);
    }

    interface Harness {
        outDir: string;
        cacheDir: string;
        downloadCount: () => number;
        rerun: () => Promise<EmbedResult>;
        installCount: () => number;
    }

    async function setup(targets: string[] = ["win-x64", "linux-x64"]): Promise<Harness> {
        const root = await makeTemp();
        const outDir = join(root, "embedded");
        const cacheDir = join(root, "cache");
        await writeFile(join(root, "index.mjs"), fakeBundle);
        const zip = winArchive();
        const tar = linuxArchive();
        const zipName = archiveName(NODE_VERSION, runtimeTarget("win-x64"));
        const tarName = archiveName(NODE_VERSION, runtimeTarget("linux-x64"));
        const shasums =
            `${sha256(zip)}  ${zipName}\n` +
            `${sha256(tar)}  ${tarName}\n` +
            `${"c".repeat(64)}  unrelated-file.tgz\n`;
        let downloads = 0;
        const download = (url: string): Promise<Buffer> => {
            if (url.endsWith("SHASUMS256.txt")) {
                return Promise.resolve(Buffer.from(shasums, "utf8"));
            }
            if (url.endsWith(zipName)) {
                downloads += 1;
                return Promise.resolve(zip);
            }
            if (url.endsWith(tarName)) {
                downloads += 1;
                return Promise.resolve(tar);
            }
            return Promise.reject(new Error(`测试下载器不认识：${url}`));
        };
        let installs = 0;
        const install = (version: string, targetDir: string): void => {
            installs += 1;
            fakeNapukettoInstall(version, targetDir);
        };
        const rerun = () =>
            runEmbed({
                distBundle: join(root, "index.mjs"),
                outDir,
                cacheDir,
                targets,
                distBase: "https://example.test/node",
                download,
                log: (message) => logs.push(message),
                napuketto: { cliVersion: "1.2.3", install },
            });
        return {
            outDir,
            cacheDir,
            downloadCount: () => downloads,
            rerun,
            installCount: () => installs,
        };
    }

    it("两目标产出 7 件产物，manifest v2 的 shared/runtimes 与磁盘一致", async () => {
        const harness = await setup();
        const result = await harness.rerun();
        expect(result.copied.sort()).toEqual([
            "NAPUKETTO_LICENSES",
            "NODE_LICENSE",
            "index.mjs",
            "manifest.json",
            "napuketto.zip",
            "node-linux-x64",
            "node-win-x64.exe",
        ]);

        expect(await readFile(join(harness.outDir, "node-win-x64.exe"))).toEqual(fakeWin);
        expect(await readFile(join(harness.outDir, "node-linux-x64"))).toEqual(fakeLinux);
        expect(await readFile(join(harness.outDir, "NODE_LICENSE"))).toEqual(fakeLicense);
        expect(await readFile(join(harness.outDir, "index.mjs"))).toEqual(fakeBundle);

        const manifest = JSON.parse(await readFile(join(harness.outDir, "manifest.json"), "utf8"));
        expect(manifest.schemaVersion).toBe(2);
        expect(manifest.nodeVersion).toBe(NODE_VERSION);
        expect(Object.keys(manifest.shared).sort()).toEqual([
            "NAPUKETTO_LICENSES",
            "NODE_LICENSE",
            "index.mjs",
            "napuketto.zip",
        ]);
        expect(manifest.shared["napuketto.zip"]).toBeTypeOf("string");
        expect(manifest.runtimes).toEqual({
            "win-x64": { file: "node-win-x64.exe", sha256: sha256(fakeWin) },
            "linux-x64": { file: "node-linux-x64", sha256: sha256(fakeLinux) },
        });
        expect(manifest.napukettoZip).toEqual({
            name: "napuketto.zip",
            sha256: manifest.shared["napuketto.zip"],
            cliVersion: "1.2.3",
        });
        expect(harness.downloadCount()).toBe(2); // zip + tar.gz
    });

    it("二次运行全复用且不再下载归档（幂等）", async () => {
        const harness = await setup();
        await harness.rerun();
        const downloadsFirstRun = harness.downloadCount();
        const installsFirstRun = harness.installCount();
        const second = await harness.rerun();
        expect(second.copied).toEqual([]);
        expect(second.reused.sort()).toEqual([
            "NAPUKETTO_LICENSES",
            "NODE_LICENSE",
            "index.mjs",
            "manifest.json",
            "napuketto.zip",
            "node-linux-x64",
            "node-win-x64.exe",
        ]);
        expect(harness.downloadCount()).toBe(downloadsFirstRun);
        expect(harness.installCount()).toBe(installsFirstRun);
    });

    it("单个平台产物损坏后只重建该产物（哈希不符 → 覆盖）", async () => {
        const harness = await setup();
        await harness.rerun();
        await writeFile(join(harness.outDir, "node-linux-x64"), Buffer.from("corrupted"));
        const third = await harness.rerun();
        expect(third.copied).toEqual(["node-linux-x64"]);
        expect(await readFile(join(harness.outDir, "node-linux-x64"))).toEqual(fakeLinux);
    });

    it("归档 sha256 与 SHASUMS 不符 → 拒绝", async () => {
        const root = await makeTemp();
        await writeFile(join(root, "index.mjs"), fakeBundle);
        const tar = linuxArchive();
        const tarName = archiveName(NODE_VERSION, runtimeTarget("linux-x64"));
        const shasums = `${"0".repeat(64)}  ${tarName}\n`; // 与归档实际哈希不符
        const attempt = runEmbed({
            distBundle: join(root, "index.mjs"),
            outDir: join(root, "embedded"),
            cacheDir: join(root, "cache"),
            targets: ["linux-x64"],
            distBase: "https://example.test/node",
            download: (url) =>
                url.endsWith("SHASUMS256.txt")
                    ? Promise.resolve(Buffer.from(shasums, "utf8"))
                    : Promise.resolve(tar),
            log: (message) => logs.push(message),
        });
        await expect(attempt).rejects.toThrow("sha256 校验失败");
    });

    /** 预置「缓存可用 + 在线 SHASUMS 必失败」的下载器环境（严格模式两用例共用）。 */
    async function setupOfflineShasums(
        strict: boolean,
    ): Promise<{ attempt: Promise<EmbedResult>; localLogs: string[]; root: string }> {
        const root = await makeTemp();
        await writeFile(join(root, "index.mjs"), fakeBundle);
        const zip = winArchive();
        const zipName = archiveName(NODE_VERSION, runtimeTarget("win-x64"));
        const cacheDir = join(root, "cache");
        await mkdir(cacheDir, { recursive: true });
        // 缓存里的 SHASUMS 与 zip 实际哈希一致——回退本可成功，严格模式必须拒绝
        await writeFile(join(cacheDir, "SHASUMS256.txt"), `${sha256(zip)}  ${zipName}\n`, "utf8");
        const localLogs: string[] = [];
        const attempt = runEmbed({
            distBundle: join(root, "index.mjs"),
            outDir: join(root, "embedded"),
            cacheDir,
            targets: ["win-x64"],
            distBase: "https://example.test/node",
            download: (url) =>
                url.endsWith("SHASUMS256.txt")
                    ? Promise.reject(new Error("模拟在线 SHASUMS 不可达"))
                    : Promise.resolve(zip),
            log: (message) => localLogs.push(message),
            strict,
        });
        return { attempt, localLogs, root };
    }

    it("严格模式（strict: true）：在线 SHASUMS 失败 → 直接失败，拒绝回退缓存（DEBT-2）", async () => {
        const { attempt } = await setupOfflineShasums(true);
        await expect(attempt).rejects.toThrow("拒绝回退缓存");
    });

    it("非严格模式（缺省）：在线 SHASUMS 失败 → 回退缓存成功 + WARN 明示来源是缓存（DEBT-2）", async () => {
        const { attempt, localLogs, root } = await setupOfflineShasums(false);
        const result = await attempt;
        expect(result.copied).toContain("node-win-x64.exe");
        expect(
            localLogs.some(
                (line) =>
                    line.includes("[WARN]") &&
                    line.includes("来源=缓存") &&
                    line.includes("KUROBRIDGE_NODE_DIST_STRICT=1"),
            ),
        ).toBe(true);
        expect(await readFile(join(root, "embedded", "node-win-x64.exe"))).toEqual(fakeWin);
    });

    it("清理不属于本次目标的旧运行时产物（Lean 切换 / node.exe 残留）", async () => {
        const harness = await setup(["win-x64"]);
        await mkdir(harness.outDir, { recursive: true });
        await writeFile(join(harness.outDir, "node.exe"), Buffer.from("stale-v1-product"));
        await writeFile(
            join(harness.outDir, "node-linux-arm64"),
            Buffer.from("stale-lean-leftover"),
        );
        await writeFile(join(harness.outDir, "keep-me.txt"), Buffer.from("keep"));

        await harness.rerun();

        await expect(readFile(join(harness.outDir, "node.exe"))).rejects.toThrow();
        await expect(readFile(join(harness.outDir, "node-linux-arm64"))).rejects.toThrow();
        expect(await readFile(join(harness.outDir, "keep-me.txt"))).toEqual(Buffer.from("keep"));
        expect(logs.some((line) => line.includes("清理过期内嵌产物"))).toBe(true);
    });

    it("targets 为空 → 直接拒绝（不产出半个包）", async () => {
        const harness = await setup([]);
        await expect(harness.rerun()).rejects.toThrow("targets 为空");
    });
});
