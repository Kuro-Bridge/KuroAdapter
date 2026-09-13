/**
 * @kurobot/bridge-core —— kurobot 业务核心 + kurobot-ws 协议服务端（平台无关，ADR-007）
 *
 * 组装形态（引导层负责，见 bridge/embedded）：
 *
 * ```ts
 * const context = new CoreContext({
 *     logger, serverId, version, newRequestId, clock, scheduler,
 * });
 * const server = new KurobotServer({ context, wsServer, channelBindings });
 * const relay = new Relay({ context, server, ipc, onShutdown });
 * await server.start();
 * ```
 */

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
    CancelFn,
    Clock,
    CoreOptions,
    IpcChannel,
    Logger,
    RelayOptions,
    ServerOptions,
    ServerTimeouts,
    TimerScheduler,
    WsConnection,
    WsServer,
};
export {
    CoreContext,
    DEFAULT_HELLO_TIMEOUT_MS,
    DEFAULT_IDLE_TIMEOUT_MS,
    DEFAULT_IPC_REQUEST_TIMEOUT_MS,
    IpcRequestError,
    KurobotServer,
    ManualClock,
    ManualScheduler,
    Relay,
};
