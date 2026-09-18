/**
 * scripts/embed.ts 单测（MVP 阶段二任务书 §3 阶段 1：纯逻辑 + 可注入下载器，不发真网）。
 *
 * zip 读取器用测试内手搓的最小 zip（本地头 + 中央目录 + EOCD，stored/deflate 两法）
 * 喂给 extractZipEntry / runEmbed；node.exe / LICENSE / index.mjs 全部是假内容。
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import {
    assertNoTencentClosedSource,
    buildZip,
    collectLicenses,
    collectZipEntries,
    distUrls,
    type EmbedResult,
    extractZipEntry,
    NODE_PLATFORM_DIR,
    NODE_VERSION,
    parseShasums,
    runEmbed,
} from "./embed.js";

const ZIP_NAME = `${NODE_PLATFORM_DIR}.zip`;

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

describe("parseShasums", () => {
    it("解析标准行（两空格分隔），容忍 CRLF 与无关行", () => {
        const text = [
            "# signify 公钥签名说明行会被忽略",
            `${"a".repeat(64)}  node-v26.7.0-win-x64.zip`,
            `${"b".repeat(64)}  node-v26.7.0-linux-x64.tar.xz\r`,
            "",
        ].join("\n");
        expect(parseShasums(text)).toEqual(
            new Map([
                ["node-v26.7.0-win-x64.zip", "a".repeat(64)],
                ["node-v26.7.0-linux-x64.tar.xz", "b".repeat(64)],
            ]),
        );
    });

    it("空文本/全噪声行 → 空映射", () => {
        expect(parseShasums("").size).toBe(0);
        expect(parseShasums("not a checksum line\nanother").size).toBe(0);
    });
});

describe("distUrls", () => {
    it("拼出 v<版本> 路径并去基址尾斜杠", () => {
        expect(distUrls("https://nodejs.org/dist/", "26.7.0")).toEqual({
            shasumsUrl: "https://nodejs.org/dist/v26.7.0/SHASUMS256.txt",
            zipUrl: "https://nodejs.org/dist/v26.7.0/node-v26.7.0-win-x64.zip",
        });
        expect(distUrls("https://npmmirror.com/mirrors/node", "26.7.0").zipUrl).toContain(
            "npmmirror.com/mirrors/node/v26.7.0/",
        );
    });
});

describe("extractZipEntry", () => {
    it("deflate 与 stored 条目均按内容取出并过 crc32", () => {
        const deflateData = Buffer.from("fake node exe binary payload");
        const storedData = Buffer.from("Node.js license (MIT) fake text");
        const zip = testZip([
            { name: `${NODE_PLATFORM_DIR}/node.exe`, data: deflateData, method: 8 },
            { name: `${NODE_PLATFORM_DIR}/LICENSE`, data: storedData, method: 0 },
        ]);
        expect(extractZipEntry(zip, `${NODE_PLATFORM_DIR}/node.exe`)).toEqual(deflateData);
        expect(extractZipEntry(zip, `${NODE_PLATFORM_DIR}/LICENSE`)).toEqual(storedData);
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

describe("runEmbed", () => {
    const fakeExe = Buffer.from(`fake node exe ${NODE_VERSION}`);
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

    interface Harness {
        outDir: string;
        cacheDir: string;
        zipRequests: number;
        rerun: () => Promise<EmbedResult>;
        installCount: () => number;
    }

    async function setup(): Promise<Harness> {
        const root = await makeTemp();
        const outDir = join(root, "embedded");
        const cacheDir = join(root, "cache");
        await writeFile(join(root, "index.mjs"), fakeBundle);
        const zip = testZip([
            { name: `${NODE_PLATFORM_DIR}/node.exe`, data: fakeExe },
            { name: `${NODE_PLATFORM_DIR}/LICENSE`, data: fakeLicense },
        ]);
        const shasums = `${sha256(zip)}  ${ZIP_NAME}\n${"c".repeat(64)}  unrelated-file.tgz\n`;
        let zipRequests = 0;
        const download = (url: string): Promise<Buffer> => {
            if (url.endsWith("SHASUMS256.txt")) {
                return Promise.resolve(Buffer.from(shasums, "utf8"));
            }
            if (url.endsWith(ZIP_NAME)) {
                zipRequests += 1;
                return Promise.resolve(zip);
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
                distBase: "https://example.test/node",
                download,
                log: (message) => logs.push(message),
                napuketto: { cliVersion: "1.2.3", install },
            });
        return { outDir, cacheDir, zipRequests, rerun, installCount: () => installs };
    }

    it("从假 dist 产出六件产物，manifest 与磁盘内容一致", async () => {
        const harness = await setup();
        const result = await harness.rerun();
        expect(result.copied.sort()).toEqual([
            "NAPUKETTO_LICENSES",
            "NODE_LICENSE",
            "index.mjs",
            "manifest.json",
            "napuketto.zip",
            "node.exe",
        ]);

        expect(await readFile(join(harness.outDir, "node.exe"))).toEqual(fakeExe);
        expect(await readFile(join(harness.outDir, "NODE_LICENSE"))).toEqual(fakeLicense);
        expect(await readFile(join(harness.outDir, "index.mjs"))).toEqual(fakeBundle);

        const manifest = JSON.parse(await readFile(join(harness.outDir, "manifest.json"), "utf8"));
        expect(manifest.nodeVersion).toBe(NODE_VERSION);
        expect(manifest.files["napuketto.zip"]).toBeTypeOf("string");
        expect(manifest.files["NAPUKETTO_LICENSES"]).toBeTypeOf("string");
        expect(manifest.napukettoZip).toEqual({
            name: "napuketto.zip",
            sha256: manifest.files["napuketto.zip"],
            cliVersion: "1.2.3",
        });
    });

    it("二次运行全复用且不再下载 zip（幂等）", async () => {
        const harness = await setup();
        await harness.rerun();
        const zipDownloadsFirstRun = harness.zipRequests;
        const installsFirstRun = harness.installCount();
        const second = await harness.rerun();
        expect(second.copied).toEqual([]);
        expect(second.reused.sort()).toEqual([
            "NAPUKETTO_LICENSES",
            "NODE_LICENSE",
            "index.mjs",
            "manifest.json",
            "napuketto.zip",
            "node.exe",
        ]);
        expect(harness.zipRequests).toBe(zipDownloadsFirstRun);
        expect(harness.installCount()).toBe(installsFirstRun);
    });

    it("产物损坏后自动重建（哈希不符 → 覆盖）", async () => {
        const harness = await setup();
        await harness.rerun();
        await writeFile(join(harness.outDir, "node.exe"), Buffer.from("corrupted"));
        const third = await harness.rerun();
        expect(third.copied).toEqual(["node.exe"]);
        expect(await readFile(join(harness.outDir, "node.exe"))).toEqual(fakeExe);
    });

    it("zip sha256 与 SHASUMS 不符 → 拒绝", async () => {
        const root = await makeTemp();
        await writeFile(join(root, "index.mjs"), fakeBundle);
        const zip = testZip([{ name: `${NODE_PLATFORM_DIR}/node.exe`, data: fakeExe }]);
        const shasums = `${"0".repeat(64)}  ${ZIP_NAME}\n`; // 与 zip 实际哈希不符
        const attempt = runEmbed({
            distBundle: join(root, "index.mjs"),
            outDir: join(root, "embedded"),
            cacheDir: join(root, "cache"),
            distBase: "https://example.test/node",
            download: (url) =>
                url.endsWith("SHASUMS256.txt")
                    ? Promise.resolve(Buffer.from(shasums, "utf8"))
                    : Promise.resolve(zip),
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
        const zip = testZip([
            { name: `${NODE_PLATFORM_DIR}/node.exe`, data: fakeExe },
            { name: `${NODE_PLATFORM_DIR}/LICENSE`, data: fakeLicense },
        ]);
        const cacheDir = join(root, "cache");
        await mkdir(cacheDir, { recursive: true });
        // 缓存里的 SHASUMS 与 zip 实际哈希一致——回退本可成功，严格模式必须拒绝
        await writeFile(join(cacheDir, "SHASUMS256.txt"), `${sha256(zip)}  ${ZIP_NAME}\n`, "utf8");
        const localLogs: string[] = [];
        const attempt = runEmbed({
            distBundle: join(root, "index.mjs"),
            outDir: join(root, "embedded"),
            cacheDir,
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
        expect(result.copied.map((name) => name)).toContain("node.exe");
        expect(
            localLogs.some(
                (line) =>
                    line.includes("[WARN]") &&
                    line.includes("来源=缓存") &&
                    line.includes("KUROBRIDGE_NODE_DIST_STRICT=1"),
            ),
        ).toBe(true);
        expect(await readFile(join(root, "embedded", "node.exe"))).toEqual(fakeExe);
    });
});
