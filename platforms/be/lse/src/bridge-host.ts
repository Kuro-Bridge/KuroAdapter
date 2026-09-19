/**
 * 一次「node shim 拉起尝试」的编排（裁决册 §4.2）：
 * 随机回环端口 + 会话令牌 → newProcess（fire-and-forget，每次尝试全新 spawn）→
 * GameChannel 握手（令牌明文首帧 + ready，30s 上限）→ ready 后开通事件桥接。
 * 失败源归一：newProcess false / 退出回调先于 ready / WS 错误与失连 / 握手超时。
 * 路径布局：<BDS 根>/plugins/kurobridge/{index.js, bin/node.exe, bin/index.mjs}。
 */
import { EventBridge } from "./event-bridge.js";
import { GameChannel } from "./game-channel.js";
import {
    fileExists,
    pluginFilePath,
    randomToken,
    type ShellLogger,
    spawnProcess,
} from "./lse-env.js";
import type { AttemptOutcome } from "./supervisor.js";

/** 握手总上限（newProcess → 连接 → 令牌 → ready），对齐 JE startTimeout（裁决册 §4.4） */
const READY_TIMEOUT_MS = 30_000;
/** 回环端口随机区间（闭区间 20000-40000，裁决册 §4.2） */
const GAME_PORT_MIN = 20_000;
const GAME_PORT_SPAN = 20_001;

export function attemptOnce(logger: ShellLogger): Promise<AttemptOutcome> {
    const port = GAME_PORT_MIN + Math.floor(Math.random() * GAME_PORT_SPAN);
    const token = randomToken();
    const root = dirname(dirname(pluginFilePath()));
    const binDir = join(root, "plugins", "kurobridge", "bin");
    // node 路径部署契约：Windows 随包 bin/node.exe（以存在性判定）；其余用 PATH 上的 node
    const nodePath = fileExists(join(binDir, "node.exe")) ? join(binDir, "node.exe") : "node";
    const command = [
        quote(nodePath),
        quote(join(binDir, "index.mjs")),
        "--server-root",
        quote(root),
        "--game-port",
        String(port),
        "--game-token",
        token,
    ].join(" ");
    logger.info(`拉起 node shim：${command}`);

    const channel = new GameChannel();
    const bridge = new EventBridge();
    return new Promise<AttemptOutcome>((resolve, reject) => {
        let settled = false;
        let autoRestart = true;
        const fail = (message: string): void => {
            if (settled) {
                return;
            }
            settled = true;
            bridge.uninstall();
            channel.close();
            reject(new Error(message));
        };
        channel.onFrame((frame) => {
            if (frame.type !== "ready") {
                return;
            }
            autoRestart = frame.body.autoRestart ?? true;
            logger.info(
                `node shim ready（wsPort=${frame.body.wsPort}，autoRestart=${autoRestart}）`,
            );
        });
        channel.onLost((reason) => {
            fail(`游戏通道断开：${reason}`);
        });
        // 退出回调先于 ready = 引导失败；先于「成功 settle」= 崩溃（脐带对端已死）
        const launched = spawnProcess(command, (exitCode, output) => {
            const tail = output === "" ? "" : `，输出前 200 字符：${output.slice(0, 200)}`;
            fail(`node shim 进程退出（code=${exitCode}${tail}）`);
        });
        if (!launched) {
            fail("newProcess 拉起 node shim 失败（bin/node.exe 缺失或被拦截？）");
            return;
        }
        void channel.open(`ws://127.0.0.1:${port}`, token, READY_TIMEOUT_MS).then(
            () => {
                if (settled) {
                    return;
                }
                settled = true;
                bridge.install(channel);
                logger.info("事件桥接已开通");
                resolve({ autoRestart });
            },
            (error: unknown) => {
                fail(`游戏通道握手失败：${String(error)}`);
            },
        );
    });
}

/** newProcess 参数串按整段路径加引号（quoting 规则待真机，裁决册 §6.1；先取最保守形态） */
function quote(path: string): string {
    return `"${path}"`;
}

function dirname(path: string): string {
    const normalized = path.split("\\").join("/");
    const cut = normalized.lastIndexOf("/");
    if (cut < 0) {
        return ".";
    }
    if (cut === 0) {
        return "/";
    }
    return normalized.slice(0, cut);
}

function join(...parts: string[]): string {
    const filtered: string[] = [];
    for (const part of parts) {
        if (part !== "") {
            filtered.push(part);
        }
    }
    return filtered.join("/");
}
