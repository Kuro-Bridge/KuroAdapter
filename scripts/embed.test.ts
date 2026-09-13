/**
 * scripts/embed.ts 单测（MVP 阶段二任务书 §3 阶段 1：纯逻辑 + 可注入下载器，不发真网）。
 *
 * zip 读取器用测试内手搓的最小 zip（本地头 + 中央目录 + EOCD，stored/deflate 两法）
 * 喂给 extractZipEntry / runEmbed；node.exe / LICENSE / index.mjs 全部是假内容。
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import {
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

interface TestEntry {
    name: string;
    data: Buffer;
    method?: 0 | 8;
}

/** 手搓最小 zip（无 extra/comment，数据紧跟本地头；中央目录 + EOCD 收尾）。 */
function buildZip(entries: TestEntry[]): Buffer {
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
        const zip = buildZip([
            { name: `${NODE_PLATFORM_DIR}/node.exe`, data: deflateData, method: 8 },
            { name: `${NODE_PLATFORM_DIR}/LICENSE`, data: storedData, method: 0 },
        ]);
        expect(extractZipEntry(zip, `${NODE_PLATFORM_DIR}/node.exe`)).toEqual(deflateData);
        expect(extractZipEntry(zip, `${NODE_PLATFORM_DIR}/LICENSE`)).toEqual(storedData);
    });

    it("条目不存在 → 报错", () => {
        const zip = buildZip([{ name: "a.txt", data: Buffer.from("x") }]);
        expect(() => extractZipEntry(zip, "missing.txt")).toThrow("找不到条目");
    });

    it("内容损坏（crc32 不符）→ 报错", () => {
        // stored 条目：本地头(30) + 名(5) 之后即数据段，破坏它直接命中 crc32 校验
        const zip = buildZip([{ name: "a.txt", data: Buffer.from("hello"), method: 0 }]);
        const dataOffset = 30 + "a.txt".length;
        zip[dataOffset] = (zip[dataOffset] ?? 0) ^ 0xff;
        expect(() => extractZipEntry(zip, "a.txt")).toThrow("crc32");
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
        const dir = await mkdtemp(join(tmpdir(), "kurobot-embed-"));
        tempDirs.push(dir);
        return dir;
    }

    interface Harness {
        outDir: string;
        cacheDir: string;
        zipRequests: number;
        rerun: () => Promise<EmbedResult>;
    }

    async function setup(): Promise<Harness> {
        const root = await makeTemp();
        const outDir = join(root, "embedded");
        const cacheDir = join(root, "cache");
        await writeFile(join(root, "index.mjs"), fakeBundle);
        const zip = buildZip([
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
        const rerun = () =>
            runEmbed({
                distBundle: join(root, "index.mjs"),
                outDir,
                cacheDir,
                distBase: "https://example.test/node",
                download,
                log: (message) => logs.push(message),
            });
        return { outDir, cacheDir, zipRequests, rerun };
    }

    it("从假 dist 产出四件产物，manifest 与磁盘内容一致", async () => {
        const harness = await setup();
        const result = await harness.rerun();
        expect(result.copied.sort()).toEqual([
            "NODE_LICENSE",
            "index.mjs",
            "manifest.json",
            "node.exe",
        ]);

        expect(await readFile(join(harness.outDir, "node.exe"))).toEqual(fakeExe);
        expect(await readFile(join(harness.outDir, "NODE_LICENSE"))).toEqual(fakeLicense);
        expect(await readFile(join(harness.outDir, "index.mjs"))).toEqual(fakeBundle);

        const manifest = JSON.parse(await readFile(join(harness.outDir, "manifest.json"), "utf8"));
        expect(manifest.nodeVersion).toBe(NODE_VERSION);
        expect(manifest.files).toEqual({
            "node.exe": sha256(fakeExe),
            NODE_LICENSE: sha256(fakeLicense),
            "index.mjs": sha256(fakeBundle),
        });
    });

    it("二次运行全复用且不再下载 zip（幂等）", async () => {
        const harness = await setup();
        await harness.rerun();
        const zipDownloadsFirstRun = harness.zipRequests;
        const second = await harness.rerun();
        expect(second.copied).toEqual([]);
        expect(second.reused.sort()).toEqual([
            "NODE_LICENSE",
            "index.mjs",
            "manifest.json",
            "node.exe",
        ]);
        expect(harness.zipRequests).toBe(zipDownloadsFirstRun);
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
        const zip = buildZip([{ name: `${NODE_PLATFORM_DIR}/node.exe`, data: fakeExe }]);
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
});
