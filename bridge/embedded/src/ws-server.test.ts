/**
 * NodeWsServer 监听参数化与绑定失败语义（MVP-3，localhost 真网）
 *
 * 覆盖：动态端口缺省行为（现状回归）、固定端口 start 返回配置值、端口被占（EADDRINUSE）
 * 经异步 error 事件 reject WsBindError（构造不抛——实测 Node 26 + ws 8.x，见 design）。
 * host 绑定的「只听指定地址」语义不经单测断言（连入拒绝面依赖本机地址拓扑），
 * 由沙盒验收以 netstat 覆盖。
 */
import { type AddressInfo, createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { NodeWsServer, WsBindError } from "./ws-server.js";

const SUBPROTOCOL = "kurobridge-ws.v1";

const servers: NodeWsServer[] = [];

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

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await server.stop();
    }
});

describe("NodeWsServer 参数化（MVP-3）", () => {
    it("缺省动态端口：start 返回实际端口，带子协议连入触发 onConnection（现状回归）", async () => {
        const server = started();
        const connections: unknown[] = [];
        server.onConnection((connection) => {
            connections.push(connection);
        });
        const port = await server.start();
        expect(port).toBeGreaterThan(0);

        const ws = new WebSocket(`ws://127.0.0.1:${port}`, SUBPROTOCOL);
        await new Promise<void>((resolve, reject) => {
            ws.addEventListener("open", () => resolve());
            ws.addEventListener("error", () => reject(new Error("连入失败")));
        });
        await vi.waitFor(() => {
            expect(connections.length).toBe(1);
        });
        ws.close();
        await server.stop();
    });

    it("固定端口：start 返回配置端口（external 对端连入点）", async () => {
        const port = await freePort();
        const server = started({ port });
        const actual = await server.start();
        expect(actual).toBe(port);
    });

    it("指定 host + 固定端口可绑定并接受 127.0.0.1 连入", async () => {
        const port = await freePort();
        const server = started({ host: "127.0.0.1", port });
        const actual = await server.start();
        expect(actual).toBe(port);
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, SUBPROTOCOL);
        await new Promise<void>((resolve, reject) => {
            ws.addEventListener("open", () => resolve());
            ws.addEventListener("error", () => reject(new Error("连入失败")));
        });
        ws.close();
    });

    it("端口被占：start reject WsBindError（含端口与 EADDRINUSE 原因），构造不抛", async () => {
        const occupant = createServer();
        await new Promise<void>((resolve) => {
            occupant.listen(0, () => resolve());
        });
        const port = (occupant.address() as AddressInfo).port;
        try {
            const server = started({ port });
            // EADDRINUSE 异步到达（error 事件），start 以 reject 收口而非同步 throw
            await expect(server.start()).rejects.toThrow(WsBindError);
            await expect(server.start()).rejects.toThrow(`port=${port}`);
            await expect(server.start()).rejects.toThrow(/EADDRINUSE/);
            // 绑定失败后 stop() 为 no-op（实例未登记），进程清理路径安全
            await expect(server.stop()).resolves.toBeUndefined();
        } finally {
            await new Promise<void>((resolve) => {
                occupant.close(() => resolve());
            });
        }
    });
});
