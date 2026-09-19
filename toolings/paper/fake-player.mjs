/**
 * toolings/paper/fake-player.mjs —— 离线模式假人（DEBT-1 阶段 5 沙盒验收测试资产，零依赖）
 *
 * 用最小 MC Java 协议（1.21.4 = protocol 769，online-mode=false 免加密）实现：
 * 登录 → configuration 应答（finish_configuration ack / keepalive / known packs）→
 * PLAY 态 →（可选）发一条聊天 → 回应 play keepalive 保活，直至超时/被踢。
 *
 * 动机（DEBT1-NOTES）：§4.7（游戏内 /kill → death 帧与 §4.9（kurobot.relay negate → 聊天
 * 不转发）都需要真实玩家在线触发 Bukkit 事件，无人值守会话用本假人充当玩家。
 *
 * 用法：node toolings/paper/fake-player.mjs <playerName> <host> <port> [chat <文本...>]
 *   - join 后等待 ~1.5s 再发聊天（等 PLAY 态稳定）；不传 chat 则只挂机保活。
 *   - 生命周期 90s 自动退出；收到 S2C disconnect / socket 错误立即退出（exit 1）。
 * 零依赖：node:net / node:zlib / node:crypto。
 */

import { createHash } from "node:crypto";
import net from "node:net";
import { deflateSync, inflateSync } from "node:zlib";

const PROTOCOL_VERSION = 769; // MC 1.21.4
const LIFETIME_MS = 90_000;

const [playerName, host, port, ...restArgs] = process.argv.slice(2);
if (playerName === undefined || host === undefined || port === undefined) {
    process.stderr.write(
        "[fake-player] 用法：node fake-player.mjs <playerName> <host> <port> [chat <文本...>]\n",
    );
    process.exit(2);
}
let chatMessage = null;
if (restArgs[0] === "chat" && restArgs.length >= 2) {
    chatMessage = restArgs.slice(1).join(" ");
}

function log(message) {
    process.stderr.write(`[fake-player:${playerName}] ${message}\n`);
}

/** 离线玩家 UUID（对齐 Bukkit nameUUIDFromBytes("OfflinePlayer:"+name) 的 MD5 v3） */
function offlineUuid(name) {
    const digest = createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();
    digest[6] = (digest[6] & 0x0f) | 0x30; // version 3
    digest[8] = (digest[8] & 0x3f) | 0x80; // variant IETF
    return digest;
}

// ---- varint / buffer 编解码 ----

function writeVarint(value) {
    const bytes = [];
    let v = value;
    do {
        let byte = v & 0x7f;
        v >>>= 7;
        if (v !== 0) byte |= 0x80;
        bytes.push(byte);
    } while (v !== 0);
    return Buffer.from(bytes);
}

function writeString(text) {
    const payload = Buffer.from(text, "utf8");
    return Buffer.concat([writeVarint(payload.length), payload]);
}

function readVarint(buffer, offset) {
    let value = 0;
    let shift = 0;
    let index = offset;
    for (;;) {
        if (index >= buffer.length) {
            return null;
        }
        const byte = buffer[index];
        value |= (byte & 0x7f) << shift;
        index += 1;
        if ((byte & 0x80) === 0) {
            return { value, next: index };
        }
        shift += 7;
        if (shift > 35) {
            throw new Error("varint 过长");
        }
    }
}

function concat(parts) {
    return Buffer.concat(parts);
}

// ---- 帧层（长度前缀 + 可选 zlib 压缩）----

let compressionThreshold = -1;

function encodePacket(packetId, ...bodyParts) {
    const payload = concat([writeVarint(packetId), ...bodyParts]);
    if (compressionThreshold < 0) {
        return concat([writeVarint(payload.length), payload]);
    }
    const inner = concat([writeVarint(0), payload]); // dataLength=0 → 未压缩传输
    if (payload.length < compressionThreshold) {
        return concat([writeVarint(inner.length), inner]);
    }
    const deflated = deflateSync(payload);
    const framed = concat([writeVarint(payload.length), deflated]);
    return concat([writeVarint(framed.length), framed]);
}

/** 从缓冲前部解析一帧；不足返回 null，成功返回 { packetId, body, consumed } */
function decodeFrame(buffer) {
    const length = readVarint(buffer, 0);
    if (length === null) {
        return null;
    }
    const total = length.next + length.value;
    if (buffer.length < total) {
        return null;
    }
    let payload = buffer.subarray(length.next, total);
    if (compressionThreshold >= 0) {
        const dataLength = readVarint(payload, 0);
        payload = payload.subarray(dataLength.next);
        if (dataLength.value > 0) {
            payload = inflateSync(payload);
        }
    }
    const packetId = readVarint(payload, 0);
    return { packetId: packetId.value, body: payload.subarray(packetId.next), consumed: total };
}

// ---- 状态机 ----

const socket = new net.Socket();
let readBuffer = Buffer.alloc(0);
let state = "login"; // login → configuration → play
let chatSent = false;

function send(packetId, ...bodyParts) {
    const frame = encodePacket(packetId, ...bodyParts);
    socket.write(frame);
}

function handlePacket(packetId, body) {
    if (state === "login") {
        if (packetId === 0x03) {
            // set_compression
            compressionThreshold = readVarint(body, 0).value;
            log(`set_compression：threshold=${compressionThreshold}`);
            return;
        }
        if (packetId === 0x02) {
            // login_success → login_acknowledged，进入 configuration
            log("login_success（offline）");
            state = "configuration";
            send(0x03); // login_acknowledged
            // client_information（C2S 0x00）：locale/viewDistance/chatMode/chatColors/skin/
            // mainHand/过滤/列表/particleStatus（1.21.4 新增末位字段，缺了会被踢）
            send(
                0x00,
                writeString("zh_cn"),
                writeVarint(8),
                writeVarint(0),
                Buffer.from([1]),
                Buffer.from([127]),
                writeVarint(1),
                Buffer.from([1]),
                Buffer.from([1]),
                writeVarint(0),
            );
            return;
        }
        if (packetId === 0x00) {
            const textLength = readVarint(body, 0);
            log(
                `登录被拒（disconnect）：${body
                    .subarray(textLength.next, textLength.next + textLength.value)
                    .toString("utf8")
                    .slice(0, 200)}`,
            );
            process.exit(1);
        }
        log(`login 态忽略包 id=0x${packetId.toString(16)}`);
        return;
    }
    if (state === "configuration") {
        if (packetId === 0x04) {
            // keep_alive（S2C 0x04，long）→ 回同值
            send(0x04, body.subarray(0, 8));
            return;
        }
        if (packetId === 0x0c) {
            // select_known_packs（required bool + 数组）→ 回空列表（C2S 0x07）
            send(0x07, writeVarint(0));
            return;
        }
        if (packetId === 0x03) {
            // finish_configuration → ack，进入 play
            log("finish_configuration → 进入 play 态");
            state = "play";
            send(0x03);
            if (chatMessage !== null) {
                setTimeout(sendChat, 1500);
            }
            return;
        }
        if (packetId === 0x02) {
            const textLength = readVarint(body, 0);
            log(
                `configuration 被踢：${body
                    .subarray(textLength.next, textLength.next + textLength.value)
                    .toString("utf8")
                    .slice(0, 200)}`,
            );
            process.exit(1);
        }
        return; // registry_data / feature_flags / tags 等全部忽略
    }
    if (state === "play") {
        // synchronize_position（1.21.4 实测 S2C 0x42）→ confirm_teleportation（C2S 0x00）：
        // 不确认则玩家停在半生成状态（实测 health 0、怪物不索敌、死亡事件不触发）
        if (packetId === 0x42) {
            const teleportId = readVarint(body, 0);
            send(0x00, writeVarint(teleportId.value));
            globalThis.__teleportConfirmed = true;
            log(`已确认传送（id=${teleportId.value}）`);
            return;
        }
        // keepalive 响应等 ID 随版本漂移（1.21.4 实测 0x18 被解码为 interact），误发包反而
        // 立即被踢；本假人的证据窗口（join → chat/kill）只有几秒，静默挂机即可
        if (globalThis.__seenPlayPackets === undefined) {
            globalThis.__seenPlayPackets = new Set();
        }
        const seen = globalThis.__seenPlayPackets;
        if (!seen.has(packetId)) {
            seen.add(packetId);
            log(`play 包 id=0x${packetId.toString(16)} len=${body.length}（首见，忽略）`);
        }
        return;
    }
}

/** serverbound chat（1.21.4 C2S play = 0x07）。body：msg/ts/salt/无签名 + LastSeenMessages.Update。 */
function sendChat() {
    if (chatSent || state !== "play") {
        return;
    }
    chatSent = true;
    const timestamp = Buffer.alloc(8);
    timestamp.writeBigInt64BE(BigInt(Date.now()));
    const salt = Buffer.alloc(8);
    send(
        0x07,
        writeString(chatMessage.slice(0, 256)),
        timestamp,
        salt,
        Buffer.from([0]), // has_signature=false（离线模式无签名会话）
        writeVarint(0), // Update.offset=0
        Buffer.alloc(3), // Update.acknowledged：固定 20 位 BitSet（3 字节零，无长度前缀）
    );
    log(`已发送聊天：${chatMessage}`);
}

socket.on("data", (chunk) => {
    readBuffer = concat([readBuffer, chunk]);
    for (;;) {
        let frame;
        try {
            frame = decodeFrame(readBuffer);
        } catch (error) {
            log(`解帧失败：${String(error)}（buffer=${readBuffer.length}B）`);
            process.exit(1);
        }
        if (frame === null) {
            return;
        }
        readBuffer = readBuffer.subarray(frame.consumed);
        handlePacket(frame.packetId, frame.body);
    }
});

socket.on("error", (error) => {
    log(`socket 错误：${error.message}`);
    process.exit(1);
});

socket.on("close", () => {
    log("连接关闭，退出");
    process.exit(0);
});

setTimeout(() => {
    log("生命周期到期，主动退出");
    process.exit(0);
}, LIFETIME_MS).unref();

log(`连接 ${host}:${port}（protocol ${PROTOCOL_VERSION}，offline）`);
socket.connect(Number(port), host, () => {
    const portBuffer = Buffer.alloc(2);
    portBuffer.writeUInt16BE(Number(port), 0);
    // handshake（C2S 0x00）：protocol / address / port / nextState=2(login)
    send(0x00, writeVarint(PROTOCOL_VERSION), writeString(host), portBuffer, writeVarint(2));
    // login_start（C2S login 0x00）：name + uuid
    send(0x00, writeString(playerName), offlineUuid(playerName));
    log(`已发送 handshake + login_start（name=${playerName}）`);
});
