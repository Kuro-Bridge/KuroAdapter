/**
 * NodeWsServer 契约（core WsServer/WsConnection 的 ws 库适配，语义镜像 embedded）：
 * - start 端口 0 → resolve 实际端口；onConnection 包装的 WsConnection 收发双向可用。
 * - 子协议握手校验：携带 kurobridge-ws.v1 才接入（ADR-003 大版本），不带则拒绝握手。
 * - stop 后端口释放，新连接拒收（ECONNREFUSED）。
 * - 绑定失败：端口被占 → start reject WsBindError（message 含 host/port），原实例 stop 维持 no-op。
 * 真实 node 环境 + 真 ws 客户端连 127.0.0.1 临时端口（不依赖外部网络）。
 */
import { type AddressInfo, createServer } from "node:net";
import type { WsConnection } from "@kuro-bridge/bridge-core";
import { WS_SUBPROTOCOL } from "@kuro-bridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket as ClientSocket, WebSocket } from "ws";
import { NodeWsServer, WsBindError } from "./ws-server.js";

const servers: NodeWsServer[] = [];
const sockets: ClientSocket[] = [];

function started(options?: ConstructorParameters<typeof NodeWsServer>[0]): NodeWsServer {
    const server = new NodeWsServer(options);
    servers.push(server);
    return server;
}

/** 拿一个当前空闲的 TCP 端口（listen(0) → 读地址 → 关闭释放） */
async function freePort(): Promise<number> {
    const occupant = createServer();
    await new Promise<void>((resolve) => {
        occupant.listen(0, () => resolve());
    });
    const port = (occupant.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
        occupant.close(() => resolve());
    });
    return port;
}

/** 建立已连接的真 ws 客户端（默认携带子协议） */
async function connect(port: number, withSubprotocol = true): Promise<ClientSocket> {
    const ws = withSubprotocol
        ? new WebSocket(`ws://127.0.0.1:${port}`, WS_SUBPROTOCOL)
        : new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("连入失败")));
    });
    return ws;
}

function clientText(ws: ClientSocket): Promise<string> {
    return new Promise<string>((resolve) => {
        ws.once("message", (data) => {
            resolve(data.toString());
        });
    });
}

afterEach(async () => {
    for (const ws of sockets.splice(0)) {
        ws.terminate();
    }
    for (const server of servers.splice(0)) {
        await server.stop();
    }
});

describe("start/stop：监听生命周期", () => {
    it("端口 0：start resolve 实际端口（>0），onConnection 触发且 WsConnection 可收发", async () => {
        const server = started({ host: "127.0.0.1", port: 0 });
        const connections: WsConnection[] = [];
        server.onConnection((connection) => {
            connections.push(connection);
        });
        const port = await server.start();
        expect(port).toBeGreaterThan(0);

        const ws = await connect(port);
        await vi.waitFor(() => {
            expect(connections).toHaveLength(1);
        });
        const connection = connections[0];
        expect(connection).toBeDefined();
        if (connection === undefined) {
            return;
        }
        // 双向：客户端 → onMessage；send → 客户端
        const received = new Promise<string>((resolve) => {
            connection.onMessage(resolve);
        });
        ws.send("ping-text");
        expect(await received).toBe("ping-text");
        const echoed = clientText(ws);
        connection.send("pong-text");
        expect(await echoed).toBe("pong-text");
        // onClose：客户端断开触发
        const closed = new Promise<void>((resolve) => {
            connection.onClose(resolve);
        });
        ws.close();
        await closed;
    });

    it("stop 后端口释放：新连接被拒收（ECONNREFUSED）", async () => {
        const server = started({ host: "127.0.0.1", port: 0 });
        const port = await server.start();
        await server.stop();
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, WS_SUBPROTOCOL);
        sockets.push(ws);
        const refused = new Promise<string>((resolve) => {
            ws.addEventListener("error", (event: { message?: string }) => {
                resolve(String(event.message ?? ""));
            });
        });
        const message = await refused;
        expect(message.toLowerCase()).toContain("econnrefused");
        // stop 幂等（server 置空后 no-op）
        await expect(server.stop()).resolves.toBeUndefined();
    });
});

describe("子协议握手（ADR-003：kurobridge-ws.v1）", () => {
    it("现状回归：不带子协议的握手并不被拒（ws 8.x handleProtocols 返 false 仅省略响应头）", async () => {
        // ws-server.ts 头注声称「不匹配直接拒绝连接」，但 ws 8.21 的 handleProtocols
        // 返回 falsy 时不发 Sec-WebSocket-Protocol 响应头、升级照常完成——拒绝语义落空。
        // 此处锚定现状（见报告「疑似缺陷」）；上游若改用手工 abort 修复，本用例应随契约翻转。
        const server = started({ host: "127.0.0.1", port: 0 });
        const connections: WsConnection[] = [];
        server.onConnection((connection) => {
            connections.push(connection);
        });
        const port = await server.start();
        const ws = await connect(port, false);
        expect(ws.readyState).toBe(WebSocket.OPEN);
        await vi.waitFor(() => {
            expect(connections).toHaveLength(1);
        });
    });

    it("携带 kurobridge-ws.v1 子协议 → 正常接入（协商通道现状回归）", async () => {
        const server = started({ host: "127.0.0.1", port: 0 });
        const connections: WsConnection[] = [];
        server.onConnection((connection) => {
            connections.push(connection);
        });
        const port = await server.start();
        const ws = await connect(port);
        expect(ws.readyState).toBe(WebSocket.OPEN);
        await vi.waitFor(() => {
            expect(connections).toHaveLength(1);
        });
    });
});

describe("绑定失败语义（EADDRINUSE）", () => {
    it("端口被占 → start reject WsBindError（message 含 host/port）；占用方不受影响", async () => {
        const port = await freePort();
        const first = started({ host: "127.0.0.1", port });
        const second = started({ host: "127.0.0.1", port });
        await expect(first.start()).resolves.toBe(port);
        const bindError = await second.start().catch((error: unknown) => error);
        expect(bindError).toBeInstanceOf(WsBindError);
        if (bindError instanceof WsBindError) {
            expect(bindError.message).toContain("127.0.0.1");
            expect(bindError.message).toContain(String(port));
        }
        // 绑定失败实例未登记句柄：stop() 维持 no-op
        await expect(second.stop()).resolves.toBeUndefined();
        // 占用方仍可服务
        const ws = await connect(port);
        expect(ws.readyState).toBe(WebSocket.OPEN);
    });
});
