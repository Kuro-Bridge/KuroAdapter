/**
 * @kurobot/bridge-core —— kurobot 业务核心 + kurobot-ws 协议服务端（平台无关，ADR-007）
 *
 * 组装形态（引导层负责，见 bridge/embedded）：
 *
 * ```ts
 * const context = new CoreContext({ logger, serverId, version, newRequestId });
 * const server = new KurobotServer({ context, wsServer });
 * const relay = new Relay({ context, server, ipc, onShutdown });
 * await server.start();
 * ```
 */

import type { CoreOptions } from "./context.js";
import { CoreContext } from "./context.js";
import type { RelayOptions } from "./relay.js";
import { IpcRequestError, Relay } from "./relay.js";
import type { ServerOptions } from "./server.js";
import { KurobotServer } from "./server.js";
import type { IpcChannel, Logger, WsConnection, WsServer } from "./transport.js";

export type {
    CoreOptions,
    IpcChannel,
    Logger,
    RelayOptions,
    ServerOptions,
    WsConnection,
    WsServer,
};
export { CoreContext, IpcRequestError, KurobotServer, Relay };
