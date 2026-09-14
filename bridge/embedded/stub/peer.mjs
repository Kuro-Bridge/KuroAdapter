/**
 * stub 协议端（开发/沙盒验收用，决策 D-06）
 *
 * 伪装 kurobridge-ws 对端：连接 → hello 握手 → 握手成功后主动发一条平台消息 →
 * 周期 ping 心跳；收到游戏 chat / join / leave / death / status / bindings_updated /
 * command_result / query_result 打印到 stderr（经 Node/Java 中继进服务器控制台）。
 * 断线按 1s→2s→4s…封顶 30s 重连（draft §3 指数退避的简化版）。
 *
 * 重连上限（DEBT-2 孤儿治理）：连续 10 次未成功连入 → 打印原因并以退出码 1 退出——
 * 宿主强杀 node 后孤儿 stub 不再无限重连。open 成功即清零计数。
 *
 * 协议 v0.3.0（DEBT-1）：主版本兼容协商（hello 版本可用 env 覆盖）；hello 可携带 token；
 * 新增验收钩子与交互命令（command/query/未知帧）。在 DEBT-2 的自杀逻辑之上叠加，勿回退。
 * 协议 v0.3.1（MVP-3）：hello 可携带 client 自报身份；支持独立进程连入（external 对端
 * 形态模拟）。
 *
 * env 钩子（无人值守沙盒验收）：
 * - KUROBRIDGE_STUB_PROTOCOL_VERSION  覆盖 hello.protocolVersion（验协商拒绝 / 0.2.0 兼容连入）
 * - KUROBRIDGE_STUB_TOKEN             hello 携带 token
 * - KUROBRIDGE_STUB_CLIENT            hello 携带 client 自报身份（如 napukettoqq/1.0）
 * - KUROBRIDGE_STUB_WS_URL            覆盖连接地址（缺省 ws://127.0.0.1:<argv[2]>）——独立进程
 *                                  模拟 external 对端连入（设此变量时 argv 端口可省略）
 * - KUROBRIDGE_STUB_ADMIN_SOURCE      command 的 source 覆盖，格式 channel:userId
 *                                  （缺省 stub-channel:stub-admin，与沙盒配置 admins 对齐）
 * - KUROBRIDGE_STUB_SEND_COMMAND      握手成功后自动发送的命令（";" 分隔多条，逐条等待结果）
 * - KUROBRIDGE_STUB_SEND_QUERY        握手成功后自动查询（status / bindings，逗号并列）
 * - KUROBRIDGE_STUB_SEND_UNKNOWN      握手成功后自动发未知帧（event / request，验容忍策略）
 *
 * 交互命令（stdin 行命令；被 node 以 stdio ignore 拉起时 stdin 即 EOF，静默禁用不影响常驻）：
 * - command <文本...>   以管理员来源发送 command 请求
 * - query <status|bindings>
 * - unknown <event|request>
 *
 * 用法：node peer.mjs <wsPort>（或设 KUROBRIDGE_STUB_WS_URL 后省略端口）
 * 零依赖：Node 26 内置全局 WebSocket（Undici）。
 */

import { createInterface } from "node:readline";

const PEER_ID = `stub-${process.pid}`;
const PROTOCOL_VERSION = "0.3.1";
const WS_SUBPROTOCOL = "kurobridge-ws.v1";
const STUB_CHANNEL = "stub-channel";
const HEARTBEAT_INTERVAL_MS = 5000;
/** 连续重连失败上限（DEBT-2 孤儿治理）：达到即退出（孤儿 stub 不再无限重连） */
const MAX_CONSECUTIVE_FAILURES = 10;

const envProtocolVersion = process.env.KUROBRIDGE_STUB_PROTOCOL_VERSION;
const HELLO_VERSION =
    envProtocolVersion !== undefined && envProtocolVersion !== ""
        ? envProtocolVersion
        : PROTOCOL_VERSION;
const HELLO_TOKEN = process.env.KUROBRIDGE_STUB_TOKEN ?? "";

/** hello 的 client 自报身份（v0.3.1，MVP-3）：仅服务端连接日志辨识用 */
const envClient = process.env.KUROBRIDGE_STUB_CLIENT;
const HELLO_CLIENT = envClient !== undefined && envClient !== "" ? envClient : "";

/**
 * 连接地址（MVP-3）：KUROBRIDGE_STUB_WS_URL 覆盖（external 对端形态，独立进程连入）；
 * 缺省维持现状 ws://127.0.0.1:<argv[2]>（孙进程拉起形态）。
 */
const envWsUrl = process.env.KUROBRIDGE_STUB_WS_URL;
const port = process.argv[2];
if ((envWsUrl === undefined || envWsUrl === "") && (port === undefined || Number.isNaN(Number(port)))) {
    process.stderr.write(
        "[KuroBridge][stub] 用法：node peer.mjs <wsPort>（或设 KUROBRIDGE_STUB_WS_URL 指定连接地址）\n",
    );
    process.exit(2);
}
const CONNECT_URL =
    envWsUrl !== undefined && envWsUrl !== "" ? envWsUrl : `ws://127.0.0.1:${port}`;

/** command 帧的来源（channel:userId）；缺省与沙盒配置 admins 对齐 */
function parseAdminSource(raw) {
    const fallback = { channel: STUB_CHANNEL, userId: "stub-admin" };
    if (raw === undefined || !raw.includes(":")) {
        return fallback;
    }
    const index = raw.indexOf(":");
    const channel = raw.slice(0, index);
    const userId = raw.slice(index + 1);
    return channel.length > 0 && userId.length > 0 ? { channel, userId } : fallback;
}

const ADMIN_SOURCE = parseAdminSource(process.env.KUROBRIDGE_STUB_ADMIN_SOURCE);

function log(message) {
    process.stderr.write(`[KuroBridge][stub] ${message}\n`);
}

function sendFrame(ws, message) {
    const header = { type: message.type };
    if (message.id !== undefined) {
        header.id = message.id;
    }
    ws.send(JSON.stringify({ header, body: message.body }));
}

/** 发送请求帧并等待同 id 的结果帧（command_result / query_result / 未知回执通用） */
function sendRequestAwait(ws, type, body, pending, label) {
    const id = crypto.randomUUID();
    const promise = new Promise((resolve) => {
        pending.set(id, { label, resolve });
    });
    sendFrame(ws, { type, id, body });
    log(`已发送 ${label}（id=${id}）`);
    return promise;
}

let backoffMs = 1000;
let heartbeatTimer = null;
let consecutiveFailures = 0;
let lastErrorText = "unknown";
/** 当前连接（交互命令投递用）；重连时由 connect() 刷新 */
let currentWs = null;

/** 当前连接的在途请求（id → {label, resolve}）；断开时全部放弃 */
let pending = new Map();

function rejectPending(reason) {
    for (const { label, resolve } of pending.values()) {
        resolve({ ok: false, text: `${label} 等待结果失败：${reason}` });
    }
    pending = new Map();
}

/** 握手成功后的验收自动化序列（env 驱动，无人值守用） */
async function runAutoSequence(ws) {
    const autoCommand = process.env.KUROBRIDGE_STUB_SEND_COMMAND ?? "";
    const autoQuery = process.env.KUROBRIDGE_STUB_SEND_QUERY ?? "";
    const autoUnknown = process.env.KUROBRIDGE_STUB_SEND_UNKNOWN ?? "";

    if (autoCommand.length > 0) {
        for (const raw of autoCommand.split(";")) {
            const command = raw.trim();
            if (command.length === 0) {
                continue;
            }
            const result = await sendRequestAwait(
                ws,
                "command",
                { command, source: ADMIN_SOURCE },
                pending,
                `command: ${command}（source=${ADMIN_SOURCE.channel}:${ADMIN_SOURCE.userId}）`,
            );
            log(result.text);
        }
    }
    if (autoQuery.length > 0) {
        for (const raw of autoQuery.split(",")) {
            const kind = raw.trim();
            if (kind !== "status" && kind !== "bindings") {
                continue;
            }
            const result = await sendRequestAwait(ws, "query", { kind }, pending, `query: ${kind}`);
            log(result.text);
        }
    }
    if (autoUnknown === "event" || autoUnknown === "request") {
        const isRequest = autoUnknown === "request";
        sendFrame(
            ws,
            isRequest
                ? { type: "stub_unknown", id: crypto.randomUUID(), body: { note: "tolerance test" } }
                : { type: "stub_unknown_event", body: { note: "tolerance test" } },
        );
        log(`已发送未知${isRequest ? "请求" : "事件"}帧 stub_unknown${isRequest ? "" : "_event"}`);
    }
}

function handleLine(ws, line) {
    if (line.length === 0) {
        return;
    }
    if (line.startsWith("command ")) {
        const command = line.slice("command ".length).trim();
        if (command.length === 0) {
            log("用法：command <文本...>");
            return;
        }
        void sendRequestAwait(
            ws,
            "command",
            { command, source: ADMIN_SOURCE },
            pending,
            `command: ${command}（source=${ADMIN_SOURCE.channel}:${ADMIN_SOURCE.userId}）`,
        ).then((result) => log(result.text));
        return;
    }
    if (line.startsWith("query ")) {
        const kind = line.slice("query ".length).trim();
        if (kind !== "status" && kind !== "bindings") {
            log("用法：query <status|bindings>");
            return;
        }
        void sendRequestAwait(ws, "query", { kind }, pending, `query: ${kind}`).then((result) =>
            log(result.text),
        );
        return;
    }
    if (line.startsWith("unknown ")) {
        const kind = line.slice("unknown ".length).trim();
        if (kind !== "event" && kind !== "request") {
            log("用法：unknown <event|request>");
            return;
        }
        sendFrame(
            ws,
            kind === "request"
                ? { type: "stub_unknown", id: crypto.randomUUID(), body: { note: "tolerance test" } }
                : { type: "stub_unknown_event", body: { note: "tolerance test" } },
        );
        log(`已发送未知${kind === "request" ? "请求" : "事件"}帧 stub_unknown${kind === "request" ? "" : "_event"}`);
        return;
    }
    log(`未知命令：${line}（支持：command <文本...> / query <status|bindings> / unknown <event|request>）`);
}

function connect() {
    const ws = new WebSocket(CONNECT_URL, WS_SUBPROTOCOL);
    currentWs = ws;

    ws.addEventListener("open", () => {
        consecutiveFailures = 0;
        backoffMs = 1000;
        log(`已连入 ${CONNECT_URL}（子协议 ${WS_SUBPROTOCOL}），发送 hello`);
        const helloBody = {
            peerId: PEER_ID,
            platform: "stub",
            version: "0.0.1",
            protocolVersion: HELLO_VERSION,
        };
        if (HELLO_TOKEN !== "") {
            helloBody.token = HELLO_TOKEN;
        }
        if (HELLO_CLIENT !== "") {
            helloBody.client = HELLO_CLIENT;
        }
        sendFrame(ws, { type: "hello", id: crypto.randomUUID(), body: helloBody });
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
                void runAutoSequence(ws).catch((error) => {
                    log(`验收自动化序列异常：${String(error)}`);
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
        if (type === "death") {
            log(`收到死亡：[${frame.body.channel}] ${frame.body.player} ${frame.body.message}`);
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
        if (type.endsWith("_result")) {
            const entry = pending.get(frame.header.id);
            if (entry !== undefined) {
                pending.delete(frame.header.id);
                entry.resolve({ ok: frame.body.ok, text: formatResult(entry.label, frame.body) });
            } else {
                log(`收到结果帧（无在途请求）：${JSON.stringify(frame.body).slice(0, 200)}`);
            }
            return;
        }
        log(`收到未处理帧类型：${type}`);
    });

    const scheduleReconnect = () => {
        if (heartbeatTimer !== null) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        rejectPending("连接已断开");
        if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
            consecutiveFailures += 1;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                log(
                    `连续 ${consecutiveFailures} 次重连失败（最后一次：${lastErrorText}），` +
                        "放弃重连并退出（孤儿治理：宿主可能已停止，不再无限重连）",
                );
                process.exit(1);
                return;
            }
            log(`连接断开，${backoffMs}ms 后重连（连续失败 ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}）`);
            const wait = backoffMs;
            backoffMs = Math.min(backoffMs * 2, 30_000);
            setTimeout(connect, wait);
        }
    };
    ws.addEventListener("close", scheduleReconnect);
    ws.addEventListener("error", (event) => {
        // Undici 的 error 事件 message 常为空串——用 || 落到 error 对象/unknown
        lastErrorText = String(event.message || event.error || "unknown");
        log(`连接错误：${lastErrorText}`);
    });
}

function formatResult(label, body) {
    if (!body.ok) {
        return `${label} 结果：失败（error=${body.error}）`;
    }
    if (body.output !== undefined) {
        return `${label} 结果：成功，输出行 [${body.output.join(" | ")}]`;
    }
    if ("data" in body) {
        return `${label} 结果：成功，data=${JSON.stringify(body.data)}`;
    }
    return `${label} 结果：成功`;
}

// 交互命令（standalone 运行时可用；stdio ignore / 管道关闭时静默禁用，不影响常驻）
const readline = createInterface({ input: process.stdin, terminal: false });
readline.on("line", (line) => {
    const ws = currentWs;
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
        log(`未连接，忽略命令：${line}`);
        return;
    }
    handleLine(ws, line.trim());
});
readline.on("close", () => {
    // stdin EOF（被 node 拉起的常态）：交互模式禁用，stub 继续运行
});

log(
    `stub 协议端启动（peerId=${PEER_ID}，channel=${STUB_CHANNEL}，hello 版本=${HELLO_VERSION}` +
        `${HELLO_TOKEN === "" ? "" : "，token=已设置"}${HELLO_CLIENT === "" ? "" : `，client=${HELLO_CLIENT}`}` +
        `，连接=${CONNECT_URL}，source=${ADMIN_SOURCE.channel}:${ADMIN_SOURCE.userId}）`,
);
connect();
