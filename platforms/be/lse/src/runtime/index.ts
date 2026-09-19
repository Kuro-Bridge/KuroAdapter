/**
 * lse node shim 入口：QuickJS 壳经 system.newProcess 拉起，宿主 bridge/core 的
 * KurobridgeServer + Relay（R2′ WS 回环薄壳，裁决册 §4.1/4.2；对 koishi 的真 WS 服务端）。
 *
 * 启动序列：argv（--server-root/--game-port/--game-token，缺一即退）→ 配置（缺失写默认、
 * 非法降级空绑定，对齐 embedded）→ 组装 core（镜像 embedded 顺序）→ 先绑 koishi WS
 * （config.ws 固定端口或缺省动态端口），再绑 127.0.0.1 游戏通道 → 壳鉴权接入后经
 * 游戏通道发 ready{wsPort, autoRestart}。
 * 关机（脐带，D-08）：游戏通道断开 / SIGTERM → relay.dispose → 退出；任一端口绑定失败 →
 * 明确 error + 非零退出，收敛于壳看护器退避（1s/5s/15s，10 分钟窗 3 次放弃）。
 */
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers";
import {
    AdminTable,
    BindingTable,
    CoreContext,
    defaultConfig,
    type KurobridgeConfig,
    KurobridgeServer,
    Relay,
} from "@kuro-bridge/bridge-core";
import { encodeFrame, PROTOCOL_VERSION } from "@kuro-bridge/protocol";
import { FileConfigStore } from "./config-store.js";
import { GameGate } from "./game-gate.js";
import { createStderrLogger } from "./logger.js";
import { NodeClock, NodeScheduler } from "./platform.js";
import { NodeWsServer } from "./ws-server.js";

/**
 * kurobridge 版本（hello_ack 上报唯一取值点）。
 * 与 platforms/be/lse/package.json / plugin.json 版本联动（当前 0.1.0；
 * lse 包暂未纳入 check-versions 六点门禁，改动须手动同步）。
 */
const BRIDGE_VERSION = "0.1.0";

interface ShimArgs {
    readonly serverRoot: string;
    readonly gamePort: number;
    readonly gameToken: string;
}

/** 两两成对的旗标解析；未知/缺失/端口越界一律视为非法（壳命令串拼装面，从严） */
function parseArgs(argv: readonly string[]): ShimArgs | null {
    const values = new Map<string, string>();
    for (let index = 0; index + 1 < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (key !== undefined && value !== undefined) {
            values.set(key, value);
        }
    }
    const serverRoot = values.get("--server-root");
    const gamePortText = values.get("--game-port");
    const gameToken = values.get("--game-token");
    if (serverRoot === undefined || gamePortText === undefined || gameToken === undefined) {
        return null;
    }
    const gamePort = Number(gamePortText);
    if (!Number.isInteger(gamePort) || gamePort < 1 || gamePort > 65535) {
        return null;
    }
    return { serverRoot, gamePort, gameToken };
}

async function main(): Promise<void> {
    const logger = createStderrLogger();
    const args = parseArgs(process.argv.slice(2));
    if (args === null) {
        logger.error(
            "缺少启动参数：需要 --server-root <BDS根> --game-port <端口> --game-token <令牌>",
        );
        process.exit(1);
    }
    // 配置：缺失生成默认（空绑定、不鉴权、无管理员）；非法不致命——记错误、降级运行，等服主修复
    const configStore = new FileConfigStore({ logger, serverRoot: args.serverRoot });
    let config: KurobridgeConfig;
    try {
        config = await configStore.load();
    } catch (error: unknown) {
        logger.error(`加载配置失败，以空绑定降级运行：${String(error)}`);
        config = defaultConfig();
    }
    const context = new CoreContext({
        logger,
        // ADR-034：serverId 来自 config 的 server 段（缺省 "kurobridge"）
        serverId: config.server?.id ?? "kurobridge",
        version: BRIDGE_VERSION,
        // token 在进程生命周期内固定：reload 不刷新（对齐 embedded，DEBT1-NOTES）
        token: config.token,
        newRequestId: randomUUID,
        clock: new NodeClock(),
        scheduler: new NodeScheduler(),
    });
    const bindings = new BindingTable(config.channels);
    logger.info(`当前绑定频道：[${bindings.channels().join(", ")}]`);

    const wsServer = new NodeWsServer({
        host: config.ws?.host,
        port: config.ws?.port,
        logger,
    });
    const server = new KurobridgeServer({
        context,
        wsServer,
        channelBindings: () => bindings.channels(),
    });
    let wsPort: number;
    try {
        wsPort = await server.start();
    } catch (error: unknown) {
        // 绑定失败（WsBindError 含 host/port 与原因）：明确日志 + 非零退出（对齐 embedded L191）
        logger.error(
            `WS 服务端启动失败：${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
    }

    let relay: Relay | null = null;
    const gate = new GameGate({ port: args.gamePort, token: args.gameToken, logger });
    let shuttingDown = false;
    const shutdown = (exitCode: number): void => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        relay?.dispose();
        // 有界强退（对齐 embedded terminate）：收尾卡住时 3s 后强制退出
        const timer = setTimeout(() => {
            process.exit(exitCode);
        }, 3000);
        timer.unref();
        void gate
            .close()
            .catch((error: unknown) => {
                logger.error(`游戏通道关闭失败（忽略，继续退出）：${String(error)}`);
            })
            .finally(() => {
                process.exit(exitCode);
            });
    };
    gate.onChannelLost(() => {
        logger.info("游戏通道断开（脐带断），退出");
        shutdown(0);
    });
    gate.onChannel((ipc) => {
        relay = new Relay({
            context,
            server,
            ipc,
            bindings,
            admins: new AdminTable(config.admins),
            configStore,
            onShutdown: (reason) => {
                logger.info(`收到关机通知（${reason}），退出`);
                shutdown(0);
            },
        });
        // autoRestart 随 ready 上报（v0.2.1）：业务配置的宿主参数交给壳看护器，本进程只做搬运
        ipc.send(
            encodeFrame({
                type: "ready",
                body: { wsPort, autoRestart: config.runtime.autoRestart },
            }),
        );
        logger.info(
            `游戏通道 ready 已发送（wsPort=${wsPort}，autoRestart=${config.runtime.autoRestart}，协议 ${PROTOCOL_VERSION}）`,
        );
    });
    try {
        await gate.start();
    } catch (error: unknown) {
        logger.error(
            `游戏通道绑定失败（127.0.0.1:${args.gamePort}）：${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        process.exit(1);
    }
    logger.info(`游戏通道已监听 ws://127.0.0.1:${args.gamePort}，等待壳接入`);

    process.on("SIGTERM", () => {
        logger.info("收到 SIGTERM，退出");
        shutdown(0);
    });
}

main().catch((error: unknown) => {
    // main 失败可能早于 logger 实例创建：此处新建（行格式契约仍收敛在 logger.ts）
    createStderrLogger().error(`引导失败：${String(error)}`);
    process.exit(1);
});
