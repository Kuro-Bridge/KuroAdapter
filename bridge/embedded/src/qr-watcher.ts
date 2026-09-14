/**
 * QR 状态文件（MVP-4，ADR-029）：napuketto 登录二维码 → 稳定运维文件的零协议变更交接
 * （node.pid 式运维文件先例）。
 *
 * 两路信号：
 * 1. 文件轮询：扫 napuketto 数据目录下每个账号目录（uin）的 cache/qrcode.png
 *    （多账号取 mtime 最新）mtime+size 变化 → 拷贝为 `<qrDir>/qr.png`；
 * 2. 捕获流 URL 日志（napuketto.ts 的 onQrUrl 回调，best-effort）。
 *
 * 任一信号更新 → 原子写 `<qrDir>/qr.json`：`{ pngPath?, url?, detectedAt }`
 * （pngPath = qr.png 绝对路径，已落地才有；detectedAt = 最后一次更新的 epoch ms）。
 * 消费方是 `:paper` 的 `/kurobot qr`（只读展示，Java 不解析 napuketto 内部布局）。
 */

import { copyFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "@kurobot/bridge-core";

const QR_PNG_NAME = "qr.png";
const QR_JSON_NAME = "qr.json";
const DEFAULT_INTERVAL_MS = 2000;

export interface QrWatcherDeps {
    /** napuketto 数据根目录（扫各账号目录的 cache/qrcode.png） */
    dataDir: string;
    /** 状态文件落地目录（`plugins/kurobot/`，绝对路径） */
    qrDir: string;
    logger: Logger;
    /** 轮询间隔 ms；缺省 2000 */
    intervalMs?: number | undefined;
}

export interface QrWatcher {
    /** 捕获流解析出 QR URL 时调用（best-effort 信号） */
    setUrl(url: string): void;
    stop(): void;
}

/** 启动轮询（timer unref：node 退出不被它拖住） */
export function startQrWatcher(deps: QrWatcherDeps): QrWatcher {
    const logger = deps.logger;
    const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    const pngDest = join(deps.qrDir, QR_PNG_NAME);
    const jsonDest = join(deps.qrDir, QR_JSON_NAME);

    let url: string | undefined;
    let lastPngKey = "";
    let stopped = false;

    const writeState = async (pngPath: string | undefined): Promise<void> => {
        const body: Record<string, unknown> = { detectedAt: Date.now() };
        if (pngPath !== undefined) {
            body["pngPath"] = pngPath;
        }
        if (url !== undefined) {
            body["url"] = url;
        }
        const text = `${JSON.stringify(body, null, 4)}\n`;
        const tmp = `${jsonDest}.tmp`;
        await writeFile(tmp, text, "utf8");
        await rename(tmp, jsonDest);
    };

    const poll = async (): Promise<void> => {
        const newest = await newestQrPng();
        if (newest === null) {
            return;
        }
        const key = `${newest.mtimeMs}:${newest.size}:${newest.path}`;
        if (key === lastPngKey) {
            return;
        }
        try {
            await copyFile(newest.path, pngDest);
        } catch (error: unknown) {
            // PNG 可能正被 napuketto 覆写（mtime 已变内容写一半）——不更新 key，下轮自然重试
            logger.debug(`qr.png 拷贝失败（下轮重试）：${String(error)}`);
            return;
        }
        lastPngKey = key;
        await writeState(pngDest);
        logger.info(`检测到登录二维码刷新，已落地 ${pngDest}`);
    };

    /** 扫各账号目录的 cache/qrcode.png，取 mtime 最新者的识别信息（含 size，供变化判定） */
    const newestQrPng = async (): Promise<{
        path: string;
        mtimeMs: number;
        size: number;
    } | null> => {
        let names: string[];
        try {
            names = (await readdir(deps.dataDir, { withFileTypes: true }))
                .filter((item) => item.isDirectory())
                .map((item) => item.name);
        } catch {
            return null; // 数据目录尚未创建（napuketto 未启动）——下轮再试
        }
        let newest: { path: string; mtimeMs: number; size: number } | null = null;
        for (const name of names) {
            const candidate = join(deps.dataDir, name, "cache", "qrcode.png");
            let stats: Awaited<ReturnType<typeof stat>>;
            try {
                stats = await stat(candidate);
            } catch {
                continue; // 该账号目录还没有二维码
            }
            if (newest === null || stats.mtimeMs > newest.mtimeMs) {
                newest = { path: candidate, mtimeMs: stats.mtimeMs, size: stats.size };
            }
        }
        return newest;
    };

    const timer = setInterval(() => {
        poll().catch((error: unknown) => {
            logger.debug(`QR 轮询异常（下轮重试）：${String(error)}`);
        });
    }, intervalMs);
    timer.unref();

    return {
        setUrl(next: string): void {
            url = next;
            void writeState(joinedPngIfExists()).catch((error: unknown) => {
                logger.debug(`qr.json 写入失败：${String(error)}`);
            });
        },
        stop(): void {
            if (stopped) {
                return;
            }
            stopped = true;
            clearInterval(timer);
        },
    };

    function joinedPngIfExists(): string | undefined {
        return lastPngKey === "" ? undefined : pngDest;
    }
}
