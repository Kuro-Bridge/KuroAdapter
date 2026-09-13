package com.kurobot.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** 帧编解码测试：线格式与 bridge/protocol 的 zod schema 逐字段一致。 */
class IpcFrameCodecTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private JsonNode parse(String json) throws Exception {
        return mapper.readTree(json);
    }

    // ---- 出帧 ----

    @Test
    void gameChatEventFrameHasNoId() throws Exception {
        String encoded = IpcFrameCodec.encodeGameChat("Steve", "你好 world");

        assertFalse(encoded.contains("\n"), "帧必须单行");
        JsonNode frame = parse(encoded);
        assertEquals("game_chat", frame.path("header").path("type").asText());
        assertFalse(frame.path("header").has("id"), "事件帧严禁携带 id");
        assertEquals("Steve", frame.path("body").path("playerName").asText());
        assertEquals("你好 world", frame.path("body").path("content").asText());
        assertEquals(2, frame.size(), "顶层仅 header 与 body");
    }

    @Test
    void shutdownEventFrameHasNoId() throws Exception {
        JsonNode frame = parse(IpcFrameCodec.encodeShutdown("server stopping"));
        assertEquals("shutdown", frame.path("header").path("type").asText());
        assertFalse(frame.path("header").has("id"));
        assertEquals("server stopping", frame.path("body").path("reason").asText());
    }

    @Test
    void playerJoinAndQuitEventFramesHaveNoId() throws Exception {
        JsonNode join = parse(IpcFrameCodec.encodePlayerJoin("Steve"));
        assertEquals("player_join", join.path("header").path("type").asText());
        assertFalse(join.path("header").has("id"), "事件帧严禁携带 id");
        assertEquals("Steve", join.path("body").path("playerName").asText());
        assertEquals(1, join.path("body").size(), "join body 仅 playerName");
        assertEquals(2, join.size(), "顶层仅 header 与 body");

        JsonNode quit = parse(IpcFrameCodec.encodePlayerQuit("Alex"));
        assertEquals("player_quit", quit.path("header").path("type").asText());
        assertFalse(quit.path("header").has("id"), "事件帧严禁携带 id");
        assertEquals("Alex", quit.path("body").path("playerName").asText());
        assertEquals(1, quit.path("body").size(), "quit body 仅 playerName");
    }

    @Test
    void statusEventFrameCarriesMetrics() throws Exception {
        String encoded = IpcFrameCodec.encodeStatus(19.5, 3, 12345L);

        assertFalse(encoded.contains("\n"), "帧必须单行");
        JsonNode frame = parse(encoded);
        assertEquals("status", frame.path("header").path("type").asText());
        assertFalse(frame.path("header").has("id"), "事件帧严禁携带 id");
        assertTrue(frame.path("body").path("tps").isFloatingPointNumber(), "tps 应为浮点数");
        assertEquals(19.5, frame.path("body").path("tps").asDouble(), 0.0);
        assertTrue(frame.path("body").path("onlinePlayers").isIntegralNumber(), "onlinePlayers 应为整数");
        assertEquals(3, frame.path("body").path("onlinePlayers").asInt());
        assertTrue(frame.path("body").path("uptimeSeconds").isIntegralNumber(), "uptimeSeconds 应为整数");
        assertEquals(12345L, frame.path("body").path("uptimeSeconds").asLong());
        assertEquals(3, frame.path("body").size(), "status body 仅三项指标");
        assertEquals(2, frame.size(), "顶层仅 header 与 body");
    }

    @Test
    void requestFramesCarryUuidId() throws Exception {
        String id = UUID.randomUUID().toString();

        JsonNode broadcast = parse(IpcFrameCodec.encodeBroadcastRequest(id, "公告内容"));
        assertEquals("broadcast", broadcast.path("header").path("type").asText());
        assertEquals(id, broadcast.path("header").path("id").asText());
        assertEquals("公告内容", broadcast.path("body").path("message").asText());

        JsonNode execute = parse(IpcFrameCodec.encodeExecuteCommandRequest(id, "list"));
        assertEquals("execute_command", execute.path("header").path("type").asText());
        assertEquals(id, execute.path("header").path("id").asText());
        assertEquals("list", execute.path("body").path("command").asText());
    }

    @Test
    void resultFrameOkHasNoErrorField() throws Exception {
        String id = UUID.randomUUID().toString();
        JsonNode ok = parse(IpcFrameCodec.encodeResult("broadcast_result", id, true, null));
        assertEquals(id, ok.path("header").path("id").asText());
        assertTrue(ok.path("body").path("ok").asBoolean());
        assertFalse(ok.path("body").has("error"), "ok 响应不得携带 error 字段");
    }

    @Test
    void resultFrameErrorCarriesError() throws Exception {
        String id = UUID.randomUUID().toString();
        JsonNode error = parse(IpcFrameCodec.encodeResult("execute_command_result", id, false, "no permission"));
        assertFalse(error.path("body").path("ok").asBoolean());
        assertEquals("no permission", error.path("body").path("error").asText());
    }

    @Test
    void encodedRequestRoundTripsThroughDecode() {
        String id = UUID.randomUUID().toString();
        Optional<InboundFrame> decoded = IpcFrameCodec.decode(IpcFrameCodec.encodeBroadcastRequest(id, "往返"));
        assertTrue(decoded.isPresent());
        assertTrue(decoded.get() instanceof InboundFrame.Request request
                && request.type().equals("broadcast")
                && request.id().equals(id)
                && request.payload().equals("往返"));
    }

    // ---- 入帧校验 ----

    @Test
    void decodeAcceptsValidReady() {
        Optional<InboundFrame> decoded =
                IpcFrameCodec.decode("{\"header\":{\"type\":\"ready\"},\"body\":{\"wsPort\":49152}}");
        assertTrue(decoded.isPresent());
        assertTrue(decoded.get() instanceof InboundFrame.Ready ready && ready.wsPort() == 49152);
        assertTrue(
                decoded.get() instanceof InboundFrame.Ready ready && ready.autoRestart() == null,
                "autoRestart 缺省（v0.2.1 前 Node）应为 null，消费方按 true 处理");
    }

    @Test
    void decodeReadyAutoRestartOptionalBoolean() {
        Optional<InboundFrame> on =
                IpcFrameCodec.decode("{\"header\":{\"type\":\"ready\"},\"body\":{\"wsPort\":1,\"autoRestart\":true}}");
        assertTrue(on.isPresent()
                && on.get() instanceof InboundFrame.Ready ready
                && Boolean.TRUE.equals(ready.autoRestart()));
        Optional<InboundFrame> off =
                IpcFrameCodec.decode("{\"header\":{\"type\":\"ready\"},\"body\":{\"wsPort\":1,\"autoRestart\":false}}");
        assertTrue(off.isPresent()
                && off.get() instanceof InboundFrame.Ready ready
                && Boolean.FALSE.equals(ready.autoRestart()));
        assertTrue(
                IpcFrameCodec.decode(
                                "{\"header\":{\"type\":\"ready\"},\"body\":{\"wsPort\":1,\"autoRestart\":\"yes\"}}")
                        .isEmpty(),
                "autoRestart 非布尔必须拒绝整帧");
    }

    @Test
    void decodeRejectsInvalidReady() {
        assertTrue(
                IpcFrameCodec.decode("{\"header\":{\"type\":\"ready\",\"id\":\"" + UUID.randomUUID()
                                + "\"},\"body\":{\"wsPort\":1}}")
                        .isEmpty(),
                "事件帧携带 id 必须拒绝");
        assertTrue(IpcFrameCodec.decode("{\"header\":{\"type\":\"ready\"},\"body\":{\"wsPort\":0}}")
                .isEmpty());
        assertTrue(IpcFrameCodec.decode("{\"header\":{\"type\":\"ready\"},\"body\":{\"wsPort\":-1}}")
                .isEmpty());
        assertTrue(IpcFrameCodec.decode("{\"header\":{\"type\":\"ready\"},\"body\":{\"wsPort\":\"8080\"}}")
                .isEmpty());
        assertTrue(IpcFrameCodec.decode("{\"header\":{\"type\":\"ready\"},\"body\":{}}")
                .isEmpty());
        assertTrue(
                IpcFrameCodec.decode("{\"header\":{\"type\":\"ready\",\"extra\":1},\"body\":{\"wsPort\":1}}")
                        .isEmpty(),
                "事件 header 严格：多余键拒绝");
        assertTrue(
                IpcFrameCodec.decode("{\"header\":{\"type\":\"ready\"},\"body\":{\"wsPort\":1},\"top\":2}")
                        .isPresent(),
                "顶层多余键宽松（对齐非 strict 的外层 z.object）");
    }

    @Test
    void decodeAcceptsValidRequest() {
        String id = UUID.randomUUID().toString();
        Optional<InboundFrame> decoded = IpcFrameCodec.decode(
                "{\"header\":{\"type\":\"execute_command\",\"id\":\"" + id + "\"},\"body\":{\"command\":\"say hi\"}}");
        assertTrue(decoded.isPresent());
        assertTrue(decoded.get() instanceof InboundFrame.Request request
                && request.type().equals("execute_command")
                && request.id().equals(id)
                && request.payload().equals("say hi"));
    }

    @Test
    void decodeRejectsInvalidRequest() {
        String id = UUID.randomUUID().toString();
        assertTrue(
                IpcFrameCodec.decode("{\"header\":{\"type\":\"broadcast\"},\"body\":{\"message\":\"hi\"}}")
                        .isEmpty(),
                "缺 id 必须拒绝");
        assertTrue(
                IpcFrameCodec.decode(
                                "{\"header\":{\"type\":\"broadcast\",\"id\":\"not-a-uuid\"},\"body\":{\"message\":\"hi\"}}")
                        .isEmpty(),
                "id 非 UUID 必须拒绝");
        assertTrue(
                IpcFrameCodec.decode("{\"header\":{\"type\":\"broadcast\",\"id\":\"" + id
                                + "\"},\"body\":{\"message\":\"\"}}")
                        .isEmpty(),
                "空 message 必须拒绝（min(1)）");
        assertTrue(
                IpcFrameCodec.decode(
                                "{\"header\":{\"type\":\"broadcast\",\"id\":\"" + id + "\"},\"body\":{\"message\":42}}")
                        .isEmpty(),
                "message 非字符串必须拒绝");
        assertTrue(
                IpcFrameCodec.decode("{\"header\":{\"type\":\"broadcast\",\"id\":\""
                                + id
                                + "\",\"junk\":true},\"body\":{\"message\":\"hi\"}}")
                        .isPresent(),
                "请求 header 多余键宽松（对齐 frameHeaderSchema）");
    }

    @Test
    void decodeAcceptsValidResult() {
        String id = UUID.randomUUID().toString();
        Optional<InboundFrame> ok = IpcFrameCodec.decode(
                "{\"header\":{\"type\":\"broadcast_result\",\"id\":\"" + id + "\"},\"body\":{\"ok\":true}}");
        assertTrue(ok.isPresent());
        assertTrue(ok.get() instanceof InboundFrame.Result result && result.ok() && result.error() == null);

        Optional<InboundFrame> error = IpcFrameCodec.decode("{\"header\":{\"type\":\"execute_command_result\",\"id\":\""
                + id
                + "\"},\"body\":{\"ok\":false,\"error\":\"denied\"}}");
        assertTrue(error.isPresent());
        assertTrue(
                error.get() instanceof InboundFrame.Result result && !result.ok() && "denied".equals(result.error()));
    }

    @Test
    void decodeRejectsInvalidResult() {
        String id = UUID.randomUUID().toString();
        assertTrue(
                IpcFrameCodec.decode("{\"header\":{\"type\":\"broadcast_result\",\"id\":\"" + id
                                + "\"},\"body\":{\"ok\":false}}")
                        .isEmpty(),
                "ok=false 缺 error 必须拒绝");
        assertTrue(
                IpcFrameCodec.decode("{\"header\":{\"type\":\"broadcast_result\",\"id\":\""
                                + id
                                + "\"},\"body\":{\"ok\":false,\"error\":\"\"}}")
                        .isEmpty(),
                "空 error 必须拒绝");
        assertTrue(
                IpcFrameCodec.decode("{\"header\":{\"type\":\"broadcast_result\",\"id\":\"" + id
                                + "\"},\"body\":{\"ok\":\"yes\"}}")
                        .isEmpty(),
                "ok 非布尔必须拒绝");
    }

    @Test
    void decodeSkipsGarbageAndUnknownLines() {
        assertTrue(IpcFrameCodec.decode("not json at all").isEmpty());
        assertTrue(IpcFrameCodec.decode("{\"header\":{\"type\":\"mystery\"},\"body\":{}}")
                .isEmpty());
        assertTrue(IpcFrameCodec.decode("[]").isEmpty());
        assertTrue(IpcFrameCodec.decode("{}").isEmpty());
        assertTrue(IpcFrameCodec.decode("{\"header\":{},\"body\":{}}").isEmpty());
        assertTrue(IpcFrameCodec.decode("{\"header\":{\"type\":\"ready\"}}").isEmpty(), "缺 body 必须拒绝");
        assertTrue(IpcFrameCodec.decode("{\"body\":{}}").isEmpty(), "缺 header 必须拒绝");
    }
}
