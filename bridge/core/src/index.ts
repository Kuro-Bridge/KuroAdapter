/**
 * @kurobot/bridge-core —— kurobot 业务核心 + kurobot-ws 协议服务端（平台无关，ADR-007）
 *
 * 组装形态（引导层负责，见 bridge/embedded）：
 *
 * ```ts
 * const context = new CoreContext({
 *     logger, serverId, version, newRequestId, clock, scheduler,
 * });
 * const bindings = new BindingTable(initialConfig.channels);
 * const server = new KurobotServer({
 *     context,
 *     wsServer,
 *     channelBindings: () => bindings.channels(),
 * });
 * const relay = new Relay({ context, server, ipc, bindings, configStore, onShutdown });
 * await server.start();
 * ```
 */

import { AdminTable } from "./business/admins.js";
import { BindingTable } from "./business/bindings.js";
import type { AdminMapping, ConfigStore, KurobotConfig } from "./business/config.js";
import { ConfigError, defaultConfig, parseConfig } from "./business/config.js";
import { gameEventChannels, platformChatTarget } from "./business/forwarding.js";
import type { CancelFn, Clock, TimerScheduler } from "./clock.js";
import { ManualClock, ManualScheduler } from "./clock.js";
import type { CoreOptions } from "./context.js";
import { CoreContext } from "./context.js";
import type { RelayOptions } from "./relay.js";
import { DEFAULT_IPC_REQUEST_TIMEOUT_MS, IpcRequestError, Relay } from "./relay.js";
import type { ServerOptions, ServerTimeouts } from "./server.js";
import { DEFAULT_HELLO_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, KurobotServer } from "./server.js";
import type { IpcChannel, Logger, WsConnection, WsServer } from "./transport.js";

export type {
    AdminMapping,
    CancelFn,
    Clock,
    ConfigStore,
    CoreOptions,
    IpcChannel,
    KurobotConfig,
    Logger,
    RelayOptions,
    ServerOptions,
    ServerTimeouts,
    TimerScheduler,
    WsConnection,
    WsServer,
};
export {
    AdminTable,
    BindingTable,
    ConfigError,
    CoreContext,
    DEFAULT_HELLO_TIMEOUT_MS,
    DEFAULT_IDLE_TIMEOUT_MS,
    DEFAULT_IPC_REQUEST_TIMEOUT_MS,
    defaultConfig,
    gameEventChannels,
    IpcRequestError,
    KurobotServer,
    ManualClock,
    ManualScheduler,
    parseConfig,
    platformChatTarget,
    Relay,
};
