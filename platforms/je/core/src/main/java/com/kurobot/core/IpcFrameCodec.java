package com.kurobot.core;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.Optional;
import java.util.UUID;

/**
 * IPC 帧编解码器：线格式 {@code {"header":{"type":"...","id":"...?"},"body":{...}}}，
 * 与 bridge/protocol 的 zod schema 逐字段一致（帧格式 SSOT 的 Java 侧镜像，一个字节不改）。
 *
 * <ul>
 *   <li>出帧（Java→Node）：game_chat / player_join / player_quit / status / shutdown 事件
 *       （header 仅 type），broadcast / execute_command 请求与两种 *_result 响应（header 携带
 *       UUID id）。</li>
 *   <li>入帧（Node→Java）：ready 事件、broadcast / execute_command 请求、两种 *_result 响应。</li>
 *   <li>事件帧严禁携带 id（事件 header 严格校验：仅允许 type 一个键）；请求/响应帧 id
 *       必填且必须可解析为 UUID（对齐 {@code z.uuid()}），header 其余键宽松（对齐非 strict 的
 *       frameHeaderSchema）。</li>
 *   <li>无法解析为 JSON、结构不符、字段非法或未知 type 的行一律返回 {@link Optional#empty()}，
 *       由调用方告警并跳过（不得崩溃）。</li>
 * </ul>
 */
final class IpcFrameCodec {
    static final String TYPE_READY = "ready";
    static final String TYPE_BROADCAST = "broadcast";
    static final String TYPE_EXECUTE_COMMAND = "execute_command";
    static final String TYPE_GAME_CHAT = "game_chat";
    static final String TYPE_PLAYER_JOIN = "player_join";
    static final String TYPE_PLAYER_QUIT = "player_quit";
    static final String TYPE_STATUS = "status";
    static final String TYPE_SHUTDOWN = "shutdown";
    static final String TYPE_BROADCAST_RESULT = "broadcast_result";
    static final String TYPE_EXECUTE_COMMAND_RESULT = "execute_command_result";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private IpcFrameCodec() {}

    // ---- 出帧（Java → Node）----

    static String encodeGameChat(String playerName, String content) {
        ObjectNode body = MAPPER.createObjectNode();
        body.put("playerName", playerName);
        body.put("content", content);
        return encodeEvent(TYPE_GAME_CHAT, body);
    }

    static String encodeShutdown(String reason) {
        ObjectNode body = MAPPER.createObjectNode();
        body.put("reason", reason);
        return encodeEvent(TYPE_SHUTDOWN, body);
    }

    static String encodePlayerJoin(String playerName) {
        ObjectNode body = MAPPER.createObjectNode();
        body.put("playerName", playerName);
        return encodeEvent(TYPE_PLAYER_JOIN, body);
    }

    static String encodePlayerQuit(String playerName) {
        ObjectNode body = MAPPER.createObjectNode();
        body.put("playerName", playerName);
        return encodeEvent(TYPE_PLAYER_QUIT, body);
    }

    static String encodeStatus(double tps, int onlinePlayers, long uptimeSeconds) {
        ObjectNode body = MAPPER.createObjectNode();
        body.put("tps", tps);
        body.put("onlinePlayers", onlinePlayers);
        body.put("uptimeSeconds", uptimeSeconds);
        return encodeEvent(TYPE_STATUS, body);
    }

    static String encodeBroadcastRequest(String id, String message) {
        ObjectNode body = MAPPER.createObjectNode();
        body.put("message", message);
        return encodeRequest(TYPE_BROADCAST, id, body);
    }

    static String encodeExecuteCommandRequest(String id, String command) {
        ObjectNode body = MAPPER.createObjectNode();
        body.put("command", command);
        return encodeRequest(TYPE_EXECUTE_COMMAND, id, body);
    }

    /** ok 响应不带 error 字段；error 响应 error 必填（对齐 resultBodySchema）。 */
    static String encodeResult(String type, String id, boolean ok, String error) {
        ObjectNode body = MAPPER.createObjectNode();
        body.put("ok", ok);
        if (!ok) {
            body.put("error", error);
        }
        return encodeRequest(type, id, body);
    }

    /** 事件帧：header 仅 type，绝不携带 id。 */
    private static String encodeEvent(String type, ObjectNode body) {
        ObjectNode frame = MAPPER.createObjectNode();
        frame.putObject("header").put("type", type);
        frame.set("body", body);
        return frame.toString();
    }

    /** 请求/响应帧：header 携带 type + id。 */
    private static String encodeRequest(String type, String id, ObjectNode body) {
        ObjectNode frame = MAPPER.createObjectNode();
        ObjectNode header = frame.putObject("header");
        header.put("type", type);
        header.put("id", id);
        frame.set("body", body);
        return frame.toString();
    }

    // ---- 入帧（Node → Java）----

    /** 解析一行 stdout；任何非法/未知的输入返回 empty，绝不抛异常。 */
    static Optional<InboundFrame> decode(String line) {
        JsonNode root;
        try {
            root = MAPPER.readTree(line);
        } catch (JsonProcessingException e) {
            return Optional.empty();
        }
        if (root == null || !root.isObject()) {
            return Optional.empty();
        }
        JsonNode header = root.get("header");
        JsonNode body = root.get("body");
        if (header == null || !header.isObject() || body == null || !body.isObject()) {
            return Optional.empty();
        }
        JsonNode typeNode = header.get("type");
        if (typeNode == null || !typeNode.isTextual()) {
            return Optional.empty();
        }
        return switch (typeNode.asText()) {
            case TYPE_READY -> decodeReady(header, body);
            case TYPE_BROADCAST -> decodeRequest(TYPE_BROADCAST, "message", header, body);
            case TYPE_EXECUTE_COMMAND -> decodeRequest(TYPE_EXECUTE_COMMAND, "command", header, body);
            case TYPE_BROADCAST_RESULT -> decodeResult(TYPE_BROADCAST_RESULT, header, body);
            case TYPE_EXECUTE_COMMAND_RESULT -> decodeResult(TYPE_EXECUTE_COMMAND_RESULT, header, body);
            default -> Optional.empty();
        };
    }

    private static Optional<InboundFrame> decodeReady(JsonNode header, JsonNode body) {
        // 事件帧 header 严格：携带 id 或多余键即拒绝（对齐 eventFrameSchema 的 strictObject）
        if (header.size() != 1) {
            return Optional.empty();
        }
        JsonNode port = body.get("wsPort");
        if (port == null || !port.isIntegralNumber() || port.asInt() <= 0) {
            return Optional.empty();
        }
        // autoRestart 可选（v0.2.1）：缺省 null，消费方按 true 处理；非布尔即整帧非法
        JsonNode autoRestart = body.get("autoRestart");
        if (autoRestart != null && !autoRestart.isBoolean()) {
            return Optional.empty();
        }
        return Optional.of(new InboundFrame.Ready(port.asInt(), autoRestart == null ? null : autoRestart.asBoolean()));
    }

    private static Optional<InboundFrame> decodeRequest(String type, String field, JsonNode header, JsonNode body) {
        String id = uuidId(header);
        if (id == null) {
            return Optional.empty();
        }
        JsonNode value = body.get(field);
        if (value == null || !value.isTextual() || value.asText().isEmpty()) {
            return Optional.empty();
        }
        return Optional.of(new InboundFrame.Request(type, id, value.asText()));
    }

    private static Optional<InboundFrame> decodeResult(String type, JsonNode header, JsonNode body) {
        String id = uuidId(header);
        if (id == null) {
            return Optional.empty();
        }
        JsonNode okNode = body.get("ok");
        if (okNode == null || !okNode.isBoolean()) {
            return Optional.empty();
        }
        boolean ok = okNode.asBoolean();
        String error = null;
        if (!ok) {
            JsonNode errorNode = body.get("error");
            if (errorNode == null
                    || !errorNode.isTextual()
                    || errorNode.asText().isEmpty()) {
                return Optional.empty();
            }
            error = errorNode.asText();
        }
        return Optional.of(new InboundFrame.Result(type, id, ok, error));
    }

    /** 请求/响应帧的 id：必填、文本、可解析为 UUID；否则视为非法帧。 */
    private static String uuidId(JsonNode header) {
        JsonNode idNode = header.get("id");
        if (idNode == null || !idNode.isTextual()) {
            return null;
        }
        String id = idNode.asText();
        try {
            UUID.fromString(id);
            return id;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
