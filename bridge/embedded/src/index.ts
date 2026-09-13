/**
 * @kurobot/bridge-embedded —— Node 引导层（spike 形态，决策 D-05/D-07）
 *
 * 启动序列：
 * 1. 组装 core（CoreContext + KurobotServer + Relay），注入 Node 实现
 *    （ws 服务端 / stdin-stdout IPC / stderr logger）。
 * 2. WS 服务端 listen(0) 拿动态端口 → IPC 发 `ready`（携带端口）。
 * 3. 环境变量 KUROBOT_STUB_PEER 指向 stub 脚本时，作为孙进程拉起（端口经 argv）。
 * 4. 关机：Java 发 `shutdown` 帧 或 关 stdin（EOF）→ 杀 stub → 退出进程。
 *
 * 生命周期两条路径（决策 D-08）：shutdown 帧 / stdin EOF 自杀；Java destroyForcibly 兜底。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    BindingTable,
    CoreContext,
    type KurobotConfig,
    KurobotServer,
    Relay,
} from "@kurobot/bridge-core";
import { encodeFrame, PROTOCOL_VERSION } from "@kurobot/protocol";

import { NodeConfigStore } from "./config-store.js";
import { StdioIpcChannel } from "./ipc-stdio.js";
import { createStderrLogger } from "./logger.js";
import { NodeClock, NodeScheduler } from "./node-platform.js";
import { NodeWsServer } from "./ws-server.js";

const SERVER_ID = "kurobot-spike";
const VERSION = "0.1.0";

function log(level: string, message: string): void {
    process.stderr.write(`[KuroBot][node][${level}] ${message}\n`);
}

/** 有界等待后强杀孙进程，随后本进程退出 */
function terminate(spawned: ChildProcess | null, exitCode: number): void {
    const timer = setTimeout(() => {
        process.exit(exitCode);
    }, 3000);
    timer.unref();
    if (spawned !== null && spawned.exitCode === null) {
        spawned.kill();
        spawned.on("exit", () => {
            process.exit(exitCode);
        });
        return;
    }
    process.exit(exitCode);
}

async function main(): Promise<void> {
    const logger = createStderrLogger();
    const ipc = new StdioIpcChannel();
    const context = new CoreContext({
        logger,
        serverId: SERVER_ID,
        version: VERSION,
        newRequestId: randomUUID,
        clock: new NodeClock(),
        scheduler: new NodeScheduler(),
    });

    // 配置：缺失生成默认（空绑定）；非法不致命——记错误、以空绑定降级运行，等服主修复
    const configStore = new NodeConfigStore({ logger });
    let initialConfig: KurobotConfig;
    try {
        initialConfig = await configStore.load();
    } catch (error: unknown) {
        log("error", `加载配置失败，以空绑定降级运行：${String(error)}`);
        initialConfig = { channels: [], runtime: { autoRestart: true } };
    }
    const bindings = new BindingTable(initialConfig.channels);
    log("info", `当前绑定频道：[${bindings.channels().join(", ")}]`);

    const wsServer = new NodeWsServer();
    const server = new KurobotServer({
        context,
        wsServer,
        channelBindings: () => bindings.channels(),
    });

    let stub: ChildProcess | null = null;
    const relay = new Relay({
        context,
        server,
        ipc,
        bindings,
        configStore,
        onShutdown: (reason) => {
            log("info", `收到 Java 关机通知（${reason}），退出`);
            relay.dispose();
            terminate(stub, 0);
        },
    });

    const port = await server.start();
    // autoRestart 随 ready 上报（v0.2.1）：业务配置的宿主参数交给 Java 看护器，Node 只做搬运
    ipc.send(
        encodeFrame({
            type: "ready",
            body: { wsPort: port, autoRestart: initialConfig.runtime.autoRestart },
        }),
    );
    log(
        "info",
        `IPC ready 已发送（wsPort=${port}，autoRestart=${initialConfig.runtime.autoRestart}，协议 ${PROTOCOL_VERSION}）`,
    );

    const stubPath = process.env["KUROBOT_STUB_PEER"];
    if (stubPath !== undefined && stubPath.length > 0) {
        stub = spawn(process.execPath, [stubPath, String(port)], {
            stdio: ["ignore", "ignore", "inherit"],
        });
        stub.on("exit", (code) => {
            log("info", `stub 协议端退出（code=${code ?? "null"}）`);
        });
        log("info", `stub 协议端已拉起：${stubPath}`);
    } else {
        log("info", "未配置 KUROBOT_STUB_PEER，跳过 stub 拉起（external 形态）");
    }

    // stdin EOF：Java 关 stdin（或进程死亡）→ 自杀
    ipc.onClose(() => {
        log("info", "stdin EOF，退出");
        relay.dispose();
        terminate(stub, 0);
    });

    process.on("SIGTERM", () => {
        terminate(stub, 0);
    });
}

main().catch((error: unknown) => {
    log("error", `引导失败：${String(error)}`);
    process.exit(1);
});
