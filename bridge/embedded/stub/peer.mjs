/**
 * stub 协议端（开发/沙盒验收用，决策 D-06）
 *
 * 伪装 kurobot-ws 对端：连接 → hello 握手 → 握手成功后主动发一条平台消息 →
 * 周期 ping 心跳；收到游戏 chat / join / leave / status / bindings_updated 打印到
 * stderr（经 Node/Java 中继进服务器控制台）。断线按 1s→2s→4s…封顶 30s 重连
 * （draft §3 指数退避的简化版）。
 *
 * 协议 v0.2（MVP 阶段一）：hello 协议版本 0.2.0；平台消息携带 channel
 * （STUB_CHANNEL 常量，沙盒验收时写入配置绑定表即可端到端连通）。
 *
 * 用法：node peer.mjs <wsPort>
 * 零依赖：Node 26 内置全局 WebSocket（Undici）。
 */

const PEER_ID = `stub-${process.pid}`;
const PROTOCOL_VERSION = "0.2.1";
const WS_SUBPROTOCOL = "kurobot-ws.v1";
const STUB_CHANNEL = "stub-channel";
const HEARTBEAT_INTERVAL_MS = 5000;

const port = process.argv[2];
if (port === undefined || Number.isNaN(Number(port))) {
    process.stderr.write("[KuroBot][stub] 用法：node peer.mjs <wsPort>\n");
    process.exit(2);
}

function log(message) {
    process.stderr.write(`[KuroBot][stub] ${message}\n`);
}

function sendFrame(ws, message) {
    const header = { type: message.type };
    if (message.id !== undefined) {
        header.id = message.id;
    }
    ws.send(JSON.stringify({ header, body: message.body }));
}

let backoffMs = 1000;
let heartbeatTimer = null;

function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, WS_SUBPROTOCOL);

    ws.addEventListener("open", () => {
        backoffMs = 1000;
        log(`已连入 ws://127.0.0.1:${port}（子协议 ${WS_SUBPROTOCOL}），发送 hello`);
        sendFrame(ws, {
            type: "hello",
            id: crypto.randomUUID(),
            body: {
                peerId: PEER_ID,
                platform: "stub",
                version: "0.0.1",
                protocolVersion: PROTOCOL_VERSION,
            },
        });
        heartbeatTimer = setInterval(() => {
            sendFrame(ws, { type: "ping", id: crypto.randomUUID(), body: { timestamp: Date.now() } });
        }, HEARTBEAT_INTERVAL_MS);
    });

    ws.addEventListener("message", (event) => {
        let frame;
        try {
            frame = JSON.parse(String(event.data));
        } catch {
            log(`收到非 JSON 帧，忽略：${String(event.data).slice(0, 120)}`);
            return;
        }
        const { type } = frame.header;
        if (type === "hello_ack") {
            if (frame.body.ok) {
                log(
                    `握手成功：serverId=${frame.body.serverId} protocolVersion=${frame.body.protocolVersion}` +
                        ` channelBindings=[${frame.body.channelBindings.join(",")}]`,
                );
                // 沙盒验收：握手后主动发一条平台消息 → 绑定该频道时进游戏 broadcast
                sendFrame(ws, {
                    type: "chat",
                    body: { channel: STUB_CHANNEL, sender: "stub-群友", content: "大家好，我是 stub 协议端" },
                });
            } else {
                log(`握手被拒：${frame.body.reason}`);
            }
            return;
        }
        if (type === "chat") {
            log(`收到游戏聊天：[${frame.body.channel}] <${frame.body.playerName}> ${frame.body.content}`);
            return;
        }
        if (type === "join" || type === "leave") {
            log(`收到${type === "join" ? "进服" : "退服"}：[${frame.body.channel}] ${frame.body.playerName}`);
            return;
        }
        if (type === "status") {
            const s = frame.body;
            log(`收到状态：tps=${s.tps} 在线=${s.onlinePlayers} uptime=${s.uptimeSeconds}s`);
            return;
        }
        if (type === "bindings_updated") {
            log(`收到绑定变更：[${frame.body.channelBindings.join(",")}]`);
            // 沙盒验收（§4.3b）：自己被绑定后再发一条平台消息，验证「写绑定 → 消息进游戏」
            if (frame.body.channelBindings.includes(STUB_CHANNEL)) {
                sendFrame(ws, {
                    type: "chat",
                    body: {
                        channel: STUB_CHANNEL,
                        sender: "stub-群友",
                        content: "绑定已生效，这是变更后的第一条消息",
                    },
                });
            }
            return;
        }
        if (type === "pong") {
            return;
        }
        log(`收到未处理帧类型：${type}`);
    });

    const scheduleReconnect = () => {
        if (heartbeatTimer !== null) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
            log(`连接断开，${backoffMs}ms 后重连`);
            const wait = backoffMs;
            backoffMs = Math.min(backoffMs * 2, 30_000);
            setTimeout(connect, wait);
        }
    };
    ws.addEventListener("close", scheduleReconnect);
    ws.addEventListener("error", (event) => {
        log(`连接错误：${String(event.message ?? event.error ?? "unknown")}`);
    });
}

log(`stub 协议端启动（peerId=${PEER_ID}，channel=${STUB_CHANNEL}）`);
connect();
