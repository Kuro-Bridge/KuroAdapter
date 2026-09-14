/**
 * @kurobot/bridge-embedded —— Node 引导层（spike 形态，决策 D-05/D-07）
 *
 * 启动序列：
 * 1. 组装 core（CoreContext + KurobotServer + Relay），注入 Node 实现
 *    （ws 服务端 / stdin-stdout IPC / stderr logger）。
 * 2. WS 服务端监听（MVP-3：config.ws 固定端口/绑定地址；缺省 listen(0) 动态端口、
 *    全部接口）→ IPC 发 `ready`（携带实际端口）。
 * 3. 协议端分支（MVP-4）：config.embedded.napuketto.enabled → 守卫（平台/固定端口/
 *    CLI 入口）后拉起嵌入 napuketto CLI（src/napuketto.ts，stdout/stderr 捕获打
 *    `[napuketto]` 前缀）；否则 KUROBOT_STUB_PEER 指向 stub 脚本时拉起（端口经 argv）。
 * 4. 关机：Java 发 `shutdown` 帧 或 关 stdin（EOF）→ [napuketto 树杀 →] 杀 stub → 退出。
 *
 * 生命周期两条路径（决策 D-08）：shutdown 帧 / stdin EOF 自杀；Java destroyForcibly 兜底。
 * 绑定失败语义（MVP-3）：固定端口被占 → 明确 error 日志（含端口与原因）→ 非零退出，
 * 重启收敛于 Java 看护器退避（1s/5s/15s，10 分钟窗 3 次放弃）。
 * napuketto 快速失败（MVP-4，ADR-029）：enabled 且无 ws.port / CLI 入口缺失 → 同族语义
 * （明确 error + exit(1)）；非 Windows 宿主 → error 日志 + 不拉起（继续纯 WS 服务端）。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
    AdminTable,
    BindingTable,
    CoreContext,
    defaultConfig,
    type KurobotConfig,
    KurobotServer,
    type Logger,
    Relay,
} from "@kurobot/bridge-core";
import { encodeFrame, PROTOCOL_VERSION } from "@kurobot/protocol";

import { NodeConfigStore } from "./config-store.js";
import { StdioIpcChannel } from "./ipc-stdio.js";
import { createStderrLogger } from "./logger.js";
import { decideNapukettoLaunch, type NapukettoHandle, spawnNapuketto } from "./napuketto.js";
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

/**
 * napuketto 分支（MVP-4，ADR-029）：守卫 + 拉起嵌入 CLI。
 * spawn → 句柄；skip（非 Windows）→ null（继续纯 WS 服务端）；fatal → 本进程退出。
 */
function launchNapukettoBranch(config: KurobotConfig, logger: Logger): NapukettoHandle | null {
    const binDir = process.argv[1] !== undefined ? dirname(process.argv[1]) : process.cwd();
    const decision = decideNapukettoLaunch({
        config,
        platform: process.platform,
        cwd: process.cwd(),
        binDir,
    });
    if (decision.action === "skip") {
        log("error", `napuketto 未拉起：${decision.reason}`);
        return null;
    }
    if (decision.action === "fatal") {
        log("error", decision.reason);
        process.exit(1);
    }
    mkdirSync(decision.dataDir, { recursive: true });
    const handle = spawnNapuketto(
        {
            cliEntry: decision.cliEntry,
            configPath: decision.configPath,
            dataDir: decision.dataDir,
        },
        { logger },
    );
    handle.onUnexpectedExit(({ code, error }) => {
        const cause = error === undefined ? "" : `，${String(error)}`;
        log(
            "error",
            `napuketto CLI 意外退出（code=${code ?? "null"}${cause}），本进程退出交由 Java 看护器退避重启`,
        );
        process.exit(1);
    });
    return handle;
}

async function main(): Promise<void> {
    const logger = createStderrLogger();
    const ipc = new StdioIpcChannel();
    // 配置：缺失生成默认（空绑定、不鉴权、无管理员）；非法不致命——记错误、降级运行，等服主修复
    const configStore = new NodeConfigStore({ logger });
    let initialConfig: KurobotConfig;
    try {
        initialConfig = await configStore.load();
    } catch (error: unknown) {
        log("error", `加载配置失败，以空绑定降级运行：${String(error)}`);
        initialConfig = defaultConfig();
    }
    const context = new CoreContext({
        logger,
        serverId: SERVER_ID,
        version: VERSION,
        // token 在进程生命周期内固定：reload 不刷新（改 token 需重启 Node，见 DEBT1-NOTES）
        token: initialConfig.token,
        newRequestId: randomUUID,
        clock: new NodeClock(),
        scheduler: new NodeScheduler(),
    });
    const bindings = new BindingTable(initialConfig.channels);
    log("info", `当前绑定频道：[${bindings.channels().join(", ")}]`);
    log(
        "info",
        `鉴权 token：${initialConfig.token === "" ? "未启用（空）" : "已启用"}；管理员映射：${initialConfig.admins.length} 条`,
    );
    // 安全基线（MVP-3）：external 形态（显式配置 ws 监听段）暴露面变大，空 token 提示但不阻断
    if (initialConfig.ws !== undefined && initialConfig.token === "") {
        log(
            "warn",
            "已配置 ws 监听段但 token 为空——任何对端均可免鉴权连入，external 模式建议配置 token",
        );
    }

    const wsServer = new NodeWsServer({
        host: initialConfig.ws?.host,
        port: initialConfig.ws?.port,
        logger,
    });
    const server = new KurobotServer({
        context,
        wsServer,
        channelBindings: () => bindings.channels(),
    });

    let stub: ChildProcess | null = null;
    let napuketto: NapukettoHandle | null = null;
    const relay = new Relay({
        context,
        server,
        ipc,
        bindings,
        admins: new AdminTable(initialConfig.admins),
        configStore,
        onShutdown: (reason) => {
            log("info", `收到 Java 关机通知（${reason}），退出`);
            void shutdown(0);
        },
    });

    // 统一关停路径：napuketto 优雅树杀（taskkill /T /F，等 exit ≤5s）→ stub 有界强杀 → 自退
    const shutdown = async (exitCode: number): Promise<void> => {
        relay.dispose();
        if (napuketto !== null) {
            await napuketto.stop();
        }
        terminate(stub, exitCode);
    };

    let port: number;
    try {
        port = await server.start();
    } catch (error: unknown) {
        // 绑定失败（WsBindError 含 host/port 与原因）：明确日志 + 非零退出，重启收敛于 Java 看护器退避
        log(
            "error",
            `WS 服务端启动失败：${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
    }
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

    // 协议端分支（MVP-4）：embedded.napuketto.enabled → 拉起嵌入 CLI；否则 stub / external
    const napukettoEnabled = initialConfig.embedded?.napuketto.enabled === true;
    const stubPath = process.env["KUROBOT_STUB_PEER"];
    if (napukettoEnabled) {
        napuketto = launchNapukettoBranch(initialConfig, logger);
    } else if (stubPath !== undefined && stubPath.length > 0) {
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
        void shutdown(0);
    });

    process.on("SIGTERM", () => {
        void shutdown(0);
    });
}

main().catch((error: unknown) => {
    log("error", `引导失败：${String(error)}`);
    process.exit(1);
});
