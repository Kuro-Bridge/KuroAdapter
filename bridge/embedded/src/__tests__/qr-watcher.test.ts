/** QR 状态文件单测（MVP-4）：注入临时目录 + 短轮询间隔，不发真进程、不依赖 napuketto */
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@kuro-bridge/bridge-core";
import { afterEach, describe, expect, it } from "vitest";

import { startQrWatcher } from "../qr-watcher.ts";

const dirs: string[] = [];
const logs: Array<{ level: string; message: string }> = [];
const logger: Logger = {
    debug: (message) => logs.push({ level: "debug", message }),
    info: (message) => logs.push({ level: "info", message }),
    warn: (message) => logs.push({ level: "warn", message }),
    error: (message) => logs.push({ level: "error", message }),
};

function level(level: string): string[] {
    return logs.filter((l) => l.level === level).map((l) => l.message);
}

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDirs(): Promise<{ dataDir: string; qrDir: string }> {
    const root = await mkdtemp(join(tmpdir(), "kurobridge-qr-"));
    dirs.push(root);
    const dataDir = join(root, "napuketto-data");
    const qrDir = join(root, "kurobridge");
    await mkdir(dataDir, { recursive: true });
    await mkdir(qrDir, { recursive: true });
    return { dataDir, qrDir };
}

async function putQr(dataDir: string, uin: string, content: string): Promise<string> {
    const cacheDir = join(dataDir, uin, "cache");
    await mkdir(cacheDir, { recursive: true });
    const png = join(cacheDir, "qrcode.png");
    await writeFile(png, Buffer.from(content), "utf8");
    return png;
}

describe("startQrWatcher", () => {
    it("数据目录无二维码 → 不产状态文件", async () => {
        const { dataDir, qrDir } = await makeDirs();
        const watcher = startQrWatcher({ dataDir, qrDir, logger, intervalMs: 10 });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await expect(readFile(join(qrDir, "qr.json"))).rejects.toThrow();
        watcher.stop();
    });

    it("数据目录不存在 → 轮询静默等待；出现后自动发现并落地 qr.png/qr.json", async () => {
        const root = await mkdtemp(join(tmpdir(), "kurobridge-qr-"));
        dirs.push(root);
        const dataDir = join(root, "not-yet");
        const qrDir = join(root, "kurobridge");
        await mkdir(qrDir, { recursive: true });
        const watcher = startQrWatcher({ dataDir, qrDir, logger, intervalMs: 10 });
        await new Promise((resolve) => setTimeout(resolve, 30));
        await expect(readFile(join(qrDir, "qr.json"))).rejects.toThrow();
        await putQr(dataDir, "10001", "png-v1");
        await new Promise((resolve) => setTimeout(resolve, 50));
        const qrJson = JSON.parse(await readFile(join(qrDir, "qr.json"), "utf8")) as {
            pngPath: string;
            url?: string;
            detectedAt: number;
        };
        expect(qrJson.pngPath.toLowerCase().endsWith("qr.png")).toBe(true);
        expect(await readFile(join(qrDir, "qr.png"), "utf8")).toBe("png-v1");
        expect(qrJson.detectedAt).toBeGreaterThan(0);
        watcher.stop();
    });

    it("PNG 刷新（mtime 变化）→ 重新拷贝；URL 信号更新进 qr.json", async () => {
        const { dataDir, qrDir } = await makeDirs();
        const png = await putQr(dataDir, "10001", "png-v1");
        const watcher = startQrWatcher({ dataDir, qrDir, logger, intervalMs: 10 });
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(await readFile(join(qrDir, "qr.png"), "utf8")).toBe("png-v1");

        // QR URL 先于 PNG 刷新到达：qr.json 记 url（pngPath 沿用已落地 PNG）
        watcher.setUrl("https://ssl.ptlogin2.qq.com/qq_login?svc=1");
        await new Promise((resolve) => setTimeout(resolve, 20));
        let qrJson = JSON.parse(await readFile(join(qrDir, "qr.json"), "utf8")) as {
            pngPath: string;
            url?: string;
        };
        expect(qrJson.url).toBe("https://ssl.ptlogin2.qq.com/qq_login?svc=1");

        // PNG 过期刷新（内容 + mtime 变化）
        const later = new Date(Date.now() + 5000);
        await writeFile(png, Buffer.from("png-v2"), "utf8");
        await utimes(png, later, later);
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(await readFile(join(qrDir, "qr.png"), "utf8")).toBe("png-v2");
        qrJson = JSON.parse(await readFile(join(qrDir, "qr.json"), "utf8"));
        expect(level("info").some((m) => m.includes("已落地"))).toBe(true);
        watcher.stop();
    });

    it("多账号目录并存 → 取 mtime 最新的二维码", async () => {
        const { dataDir, qrDir } = await makeDirs();
        const old = await putQr(dataDir, "10001", "png-old");
        const later = new Date(Date.now() + 5000);
        await utimes(old, new Date(Date.now() - 10000), new Date(Date.now() - 10000));
        const newer = await putQr(dataDir, "10002", "png-newer");
        await utimes(newer, later, later);
        const watcher = startQrWatcher({ dataDir, qrDir, logger, intervalMs: 10 });
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(await readFile(join(qrDir, "qr.png"), "utf8")).toBe("png-newer");
        watcher.stop();
    });

    it("stop 后不再轮询（二次 stop 幂等）", async () => {
        const { dataDir, qrDir } = await makeDirs();
        const watcher = startQrWatcher({ dataDir, qrDir, logger, intervalMs: 10 });
        watcher.stop();
        watcher.stop();
        await putQr(dataDir, "10001", "png-after-stop");
        await new Promise((resolve) => setTimeout(resolve, 40));
        await expect(readFile(join(qrDir, "qr.json"))).rejects.toThrow();
    });
});
