// kurobridge_core / IPC 帧编解码单测。
// 覆盖基线 = Java 对照物 IpcFrameCodecTest（19 用例）逐项对齐；UUID 边界向量按
// 协议实际依赖的 zod 4.4.3 z.uuid() 实际口径补强（版本位/变体位/nil/max）。

#include "test_util.h"

#include <string>
#include <variant>
#include <vector>

#include "core/ipc_frame.h"

using namespace std::string_literals;
using kurobridge::ipc::BroadcastRequest;
using kurobridge::ipc::DecodeResult;
using kurobridge::ipc::DecodedFrame;
using kurobridge::ipc::ExecuteCommandRequest;
using kurobridge::ipc::ReadyFrame;
using kurobridge::ipc::ResultFrame;
using kurobridge::JsonValue;

namespace {

// ---- 通用辅助 ----

std::string uid(const std::string& seed) {
    // 版本 4 / 变体 89ab 的合法 UUID（种子仅作辨识）
    return "7c9e6679-7425-4" + seed + "de-9e6b-a07864a99ebf";
}
const std::string kId = uid("0");

bool decodeOk(const char* line, DecodedFrame& out) {
    DecodeResult result = kurobridge::ipc::decodeFrame(line);
    if (result.ok) out = result.frame;
    return result.ok;
}

bool decodeFails(const char* line, std::string* reason = nullptr) {
    DecodeResult result = kurobridge::ipc::decodeFrame(line);
    if (!result.ok && reason != nullptr) *reason = result.error;
    return !result.ok;
}

// ---- 编码：事件帧 ----

void testEncodeEventHasNoId() {
    kurobridge::JsonValue body = JsonValue::object({{"playerName", JsonValue::string("Steve")},
                                                    {"content", JsonValue::string("你好 world")}});
    std::string encoded = kurobridge::ipc::encodeEvent("game_chat", body);
    CHECK(encoded.find('\n') == std::string::npos);  // 单行（换行由传输层加）
    CHECK(encoded.find('\r') == std::string::npos);
    JsonValue frame = kurobridge::parseJson(encoded).value;
    CHECK(frame.isObject() && frame.asObject().size() == 2);  // 顶层仅 header 与 body
    const JsonValue& header = *frame.find("header");
    CHECK_EQ(header.asObject().size(), std::size_t{1});  // header 仅 type
    CHECK_EQ(header.find("type")->asString(), "game_chat"s);
    CHECK(frame.find("id") == nullptr && header.find("id") == nullptr);
    CHECK_EQ(frame.find("body")->find("playerName")->asString(), "Steve"s);
    CHECK_EQ(frame.find("body")->find("content")->asString(), "你好 world"s);
}

void testEncodeConfigReloadEmptyBody() {
    std::string encoded = kurobridge::ipc::encodeEvent("config_reload", JsonValue::object());
    CHECK(encoded.find('\n') == std::string::npos);
    // 黄金串：无空白、键序 header 先于 body
    CHECK_EQ(encoded, R"({"header":{"type":"config_reload"},"body":{}})"s);
}

void testEncodeStatusNumbers() {
    kurobridge::JsonValue body =
        JsonValue::object({{"tps", JsonValue::number(19.5)},
                           {"onlinePlayers", JsonValue::number(3)},
                           {"uptimeSeconds", JsonValue::number(12345)}});
    std::string encoded = kurobridge::ipc::encodeEvent("status", body);
    CHECK(encoded.find('\n') == std::string::npos);
    CHECK(encoded.find("\"tps\":19.5") != std::string::npos);           // 浮点最短表示
    CHECK(encoded.find("\"onlinePlayers\":3") != std::string::npos);    // 整型无 .0
    CHECK(encoded.find("\"uptimeSeconds\":12345") != std::string::npos);
}

void testEncodeRequestCarriesUuid() {
    std::string encoded = kurobridge::ipc::encodeRequest(
        "broadcast", kId, JsonValue::object({{"channel", JsonValue::string("global")},
                                             {"message", JsonValue::string("公告内容")}}));
    CHECK(encoded.find('\n') == std::string::npos);
    JsonValue frame = kurobridge::parseJson(encoded).value;
    CHECK_EQ(frame.find("header")->find("type")->asString(), "broadcast"s);
    CHECK_EQ(frame.find("header")->find("id")->asString(), kId);
    CHECK_EQ(frame.find("body")->find("channel")->asString(), "global"s);
    CHECK_EQ(frame.find("body")->find("message")->asString(), "公告内容"s);
}

void testEncodeResultShapes() {
    using kurobridge::ipc::encodeResult;
    // ok=true：不落 error 字段
    JsonValue body = *kurobridge::parseJson(encodeResult("broadcast_result", kId, true, "", nullptr))
                          .value.find("body");
    CHECK(body.find("ok")->asBool());
    CHECK(body.find("error") == nullptr);
    CHECK(body.find("output") == nullptr);
    // ok=false：落非空 error
    body = *kurobridge::parseJson(encodeResult("execute_command_result", kId, false, "no permission",
                                               nullptr))
                .value.find("body");
    CHECK(!body.find("ok")->asBool());
    CHECK_EQ(body.find("error")->asString(), "no permission"s);
    CHECK(body.find("output") == nullptr);
    // output：null / 空列表不产生字段（协议：空输出不产生字段）
    body = *kurobridge::parseJson(
                encodeResult("execute_command_result", kId, true, "", nullptr))
                .value.find("body");
    CHECK(body.find("output") == nullptr);
    const std::vector<std::string> empty{};
    body = *kurobridge::parseJson(encodeResult("execute_command_result", kId, true, "", &empty))
                .value.find("body");
    CHECK(body.find("output") == nullptr);
    // 非空列表 → 逐行回传
    const std::vector<std::string> lines{"There are 2 of a max of 20 players online:", "Steve"};
    body = *kurobridge::parseJson(encodeResult("execute_command_result", kId, true, "", &lines))
                .value.find("body");
    const JsonValue& output = *body.find("output");
    CHECK(output.isArray() && output.asArray().size() == 2);
    CHECK_EQ(output.asArray()[1].asString(), "Steve"s);
    // 引号/反斜杠/控制字符经 JSON 转义后仍单行（\x01 后接字符串字面量拼接，
    // 防十六进制转义贪婪吞掉后续 'd'）
    const std::vector<std::string> trickyLine{"a\"b\\c\x01" "d\n"};
    std::string tricky = encodeResult("execute_command_result", kId, true, "", &trickyLine);
    CHECK(tricky.find("\\u0001") != std::string::npos);
    CHECK(tricky.find("\\n") != std::string::npos);
}

void testEncodeDecodeRoundTrip() {
    using kurobridge::ipc::decodeFrame;
    // 请求往返（中文消息）
    std::string encoded = kurobridge::ipc::encodeRequest(
        "broadcast", kId, JsonValue::object({{"channel", JsonValue::string("global")},
                                             {"message", JsonValue::string("往返")}}));
    DecodeResult decoded = decodeFrame(encoded);
    CHECK(decoded.ok);
    auto* request = std::get_if<BroadcastRequest>(&decoded.frame);
    CHECK(request != nullptr);
    if (request != nullptr) {
        CHECK_EQ(request->id, kId);
        CHECK_EQ(request->channel, "global"s);
        CHECK_EQ(request->message, "往返"s);
    }
    // 命令请求往返
    decoded = decodeFrame(kurobridge::ipc::encodeRequest(
        "execute_command", kId, JsonValue::object({{"command", JsonValue::string("say hi")}})));
    CHECK(decoded.ok);
    auto* command = std::get_if<ExecuteCommandRequest>(&decoded.frame);
    CHECK(command != nullptr);
    if (command != nullptr) CHECK_EQ(command->command, "say hi"s);
    // 结果帧往返
    const std::vector<std::string> lines{"line one"};
    decoded = decodeFrame(
        kurobridge::ipc::encodeResult("execute_command_result", kId, true, "", &lines));
    CHECK(decoded.ok);
    auto* result = std::get_if<ResultFrame>(&decoded.frame);
    CHECK(result != nullptr);
    if (result != nullptr) {
        CHECK_EQ(result->type, "execute_command_result"s);
        CHECK(result->ok && result->output.has_value() && result->output->size() == 1);
    }
}

// ---- 解码：ready ----

void testDecodeAcceptsReady() {
    DecodedFrame frame;
    CHECK(decodeOk(R"({"header":{"type":"ready"},"body":{"wsPort":49152}})", frame));
    auto* ready = std::get_if<ReadyFrame>(&frame);
    CHECK(ready != nullptr);
    if (ready != nullptr) {
        CHECK_EQ(ready->wsPort, 49152);
        CHECK(!ready->autoRestart.has_value());  // 缺省消费方按 true 处理
    }
    // autoRestart 可选布尔
    CHECK(decodeOk(R"({"header":{"type":"ready"},"body":{"wsPort":1,"autoRestart":true}})", frame));
    CHECK(std::get_if<ReadyFrame>(&frame) != nullptr
          && std::get<ReadyFrame>(frame).autoRestart.value());
    CHECK(decodeOk(R"({"header":{"type":"ready"},"body":{"wsPort":1,"autoRestart":false}})", frame));
    CHECK(std::get_if<ReadyFrame>(&frame) != nullptr
          && !std::get<ReadyFrame>(frame).autoRestart.value());
    // body 多余键宽松（z.object 非 strict strip）
    CHECK(decodeOk(R"({"header":{"type":"ready"},"body":{"wsPort":1,"junk":1}})", frame));
    // 顶层多余键宽松（外层 z.object 非 strict）——Java 同款对照用例
    CHECK(decodeOk(R"({"header":{"type":"ready"},"body":{"wsPort":1},"top":2})", frame));
    // JSON 整数值接受（zod Number.isInteger 口径；Java Jackson 会拒 1.0，本层对齐 zod）
    CHECK(decodeOk(R"({"header":{"type":"ready"},"body":{"wsPort":1.0}})", frame));
    CHECK(std::get_if<ReadyFrame>(&frame) != nullptr && std::get<ReadyFrame>(frame).wsPort == 1);
    CHECK(decodeOk(R"({"header":{"type":"ready"},"body":{"wsPort":1e2}})", frame));  // 100
    CHECK(std::get_if<ReadyFrame>(&frame) != nullptr && std::get<ReadyFrame>(frame).wsPort == 100);
}

void testDecodeRejectsInvalidReady() {
    const std::string validId = kId;
    // 事件帧携带 id 拒（header 严格）
    CHECK(decodeFails(
        (R"({"header":{"type":"ready","id":")" + validId + R"("},"body":{"wsPort":1}})").c_str()));
    // header 多余键拒
    CHECK(decodeFails(R"({"header":{"type":"ready","extra":1},"body":{"wsPort":1}})"));
    // wsPort 形状面
    CHECK(decodeFails(R"({"header":{"type":"ready"},"body":{"wsPort":0}})"));
    CHECK(decodeFails(R"({"header":{"type":"ready"},"body":{"wsPort":-1}})"));
    CHECK(decodeFails(R"({"header":{"type":"ready"},"body":{"wsPort":1.5}})"));
    CHECK(decodeFails(R"({"header":{"type":"ready"},"body":{"wsPort":"8080"}})"));
    CHECK(decodeFails(R"({"header":{"type":"ready"},"body":{"wsPort":null}})"));
    CHECK(decodeFails(R"({"header":{"type":"ready"},"body":{}})"));  // 缺 wsPort
    // autoRestart 非布尔拒整帧
    CHECK(decodeFails(R"({"header":{"type":"ready"},"body":{"wsPort":1,"autoRestart":"yes"}})"));
    // 超出 JS 安全整数上界拒（zod 理论接受，登记备查的收紧）
    CHECK(decodeFails(R"({"header":{"type":"ready"},"body":{"wsPort":1e30}})"));
}

// ---- 解码：请求帧 ----

void testDecodeAcceptsRequest() {
    DecodedFrame frame;
    std::string line = R"({"header":{"type":"execute_command","id":")" + kId
                       + R"("},"body":{"command":"say hi"}})";
    CHECK(decodeOk(line.c_str(), frame));
    auto* command = std::get_if<ExecuteCommandRequest>(&frame);
    CHECK(command != nullptr && command->command == "say hi");
    // header 多余键宽松（frameHeaderSchema 非 strict strip）——Java 同款对照用例
    line = R"({"header":{"type":"broadcast","id":")" + kId
           + R"(","junk":true},"body":{"channel":"global","message":"hi"}})";
    CHECK(decodeOk(line.c_str(), frame));
    auto* broadcast = std::get_if<BroadcastRequest>(&frame);
    CHECK(broadcast != nullptr && broadcast->message == "hi");
    // body 多余键宽松
    line = R"({"header":{"type":"broadcast","id":")" + kId
           + R"("},"body":{"channel":"global","message":"hi","extra":1}})";
    CHECK(decodeOk(line.c_str(), frame));
}

void testDecodeRejectsInvalidRequest() {
    // 缺 id
    CHECK(decodeFails(R"({"header":{"type":"broadcast"},"body":{"channel":"g","message":"hi"}})"));
    // id 非 UUID
    CHECK(decodeFails(
        R"({"header":{"type":"broadcast","id":"not-a-uuid"},"body":{"channel":"g","message":"hi"}})"));
    const std::string id = kId;
    // 空 message（min(1)）
    CHECK(decodeFails((R"({"header":{"type":"broadcast","id":")" + id
                       + R"("},"body":{"channel":"g","message":""}})")
                          .c_str()));
    // message 非字符串
    CHECK(decodeFails((R"({"header":{"type":"broadcast","id":")" + id
                       + R"("},"body":{"channel":"g","message":42}})")
                          .c_str()));
    // channel 严格校验（C++ 按 zod；Java 有意不查 channel——既定差异）
    CHECK(decodeFails(
        (R"({"header":{"type":"broadcast","id":")" + id + R"("},"body":{"message":"hi"}})").c_str()));
    CHECK(decodeFails((R"({"header":{"type":"broadcast","id":")" + id
                       + R"("},"body":{"channel":"","message":"hi"}})")
                          .c_str()));
    // channel 非字符串
    CHECK(decodeFails((R"({"header":{"type":"broadcast","id":")" + id
                       + R"("},"body":{"channel":7,"message":"hi"}})")
                          .c_str()));
    // execute_command：缺 command / 空 command
    CHECK(decodeFails((R"({"header":{"type":"execute_command","id":")" + id + R"("},"body":{}})").c_str()));
    CHECK(decodeFails(
        (R"({"header":{"type":"execute_command","id":")" + id + R"("},"body":{"command":""}})").c_str()));
}

// ---- 解码：结果帧 ----

void testDecodeAcceptsResult() {
    DecodedFrame frame;
    CHECK(decodeOk((R"({"header":{"type":"broadcast_result","id":")" + kId
                    + R"("},"body":{"ok":true}})")
                       .c_str(),
                   frame));
    auto* ok = std::get_if<ResultFrame>(&frame);
    CHECK(ok != nullptr);
    if (ok != nullptr) {
        CHECK_EQ(ok->type, "broadcast_result"s);
        CHECK(ok->ok && ok->error.empty() && !ok->output.has_value());
    }
    CHECK(decodeOk((R"({"header":{"type":"execute_command_result","id":")" + kId
                    + R"("},"body":{"ok":false,"error":"denied"}})")
                       .c_str(),
                   frame));
    auto* bad = std::get_if<ResultFrame>(&frame);
    CHECK(bad != nullptr);
    if (bad != nullptr) CHECK(!bad->ok && bad->error == "denied" && !bad->output.has_value());
    // ok=true 无 output → nullopt（NodeIpc 归一空列表是上层语义）
    CHECK(decodeOk((R"({"header":{"type":"execute_command_result","id":")" + kId
                    + R"("},"body":{"ok":true}})")
                       .c_str(),
                   frame));
    CHECK(std::get_if<ResultFrame>(&frame) != nullptr && !std::get<ResultFrame>(frame).output.has_value());
    // ok=true + output 空数组（合法）
    CHECK(decodeOk((R"({"header":{"type":"execute_command_result","id":")" + kId
                    + R"("},"body":{"ok":true,"output":[]}})")
                       .c_str(),
                   frame));
    CHECK(std::get_if<ResultFrame>(&frame) != nullptr
          && std::get<ResultFrame>(frame).output.has_value()
          && std::get<ResultFrame>(frame).output->empty());
    // ok=true + output 逐行
    CHECK(decodeOk((R"({"header":{"type":"execute_command_result","id":")" + kId
                    + R"("},"body":{"ok":true,"output":["There are 2 players:","Steve"]}})")
                       .c_str(),
                   frame));
    CHECK(std::get_if<ResultFrame>(&frame) != nullptr
          && std::get<ResultFrame>(frame).output.has_value()
          && std::get<ResultFrame>(frame).output->size() == 2);
}

void testDecodeRejectsInvalidResult() {
    const std::string id = kId;
    // ok=false 缺 error
    CHECK(decodeFails(
        (R"({"header":{"type":"broadcast_result","id":")" + id + R"("},"body":{"ok":false}})").c_str()));
    // 空 error（min(1)）
    CHECK(decodeFails((R"({"header":{"type":"broadcast_result","id":")" + id
                       + R"("},"body":{"ok":false,"error":""}})")
                          .c_str()));
    // ok 非布尔 / 缺 ok
    CHECK(decodeFails((R"({"header":{"type":"broadcast_result","id":")" + id
                       + R"("},"body":{"ok":"yes"}})")
                          .c_str()));
    CHECK(decodeFails(
        (R"({"header":{"type":"broadcast_result","id":")" + id + R"("},"body":{}})").c_str()));
    // output 形状非法：整帧拒（仅 execute_command_result 的 ok 分支）
    CHECK(decodeFails((R"({"header":{"type":"execute_command_result","id":")" + id
                       + R"("},"body":{"ok":true,"output":"lines"}})")
                          .c_str()));
    CHECK(decodeFails((R"({"header":{"type":"execute_command_result","id":")" + id
                       + R"("},"body":{"ok":true,"output":[42]}})")
                          .c_str()));
    CHECK(decodeFails((R"({"header":{"type":"execute_command_result","id":")" + id
                       + R"("},"body":{"ok":true,"output":["a",null]}})")
                          .c_str()));
    // id 缺失
    CHECK(decodeFails(R"({"header":{"type":"broadcast_result"},"body":{"ok":true}})"));
}

void testDecodeResultUnionStripSemantics() {
    // broadcast_result 携带 output 一律忽略（resultBodySchema 非 strict strip）
    DecodedFrame frame;
    CHECK(decodeOk((R"({"header":{"type":"broadcast_result","id":")" + kId
                    + R"("},"body":{"ok":true,"output":["x"]}})")
                       .c_str(),
                   frame));
    auto* result = std::get_if<ResultFrame>(&frame);
    CHECK(result != nullptr);
    if (result != nullptr) CHECK(result->ok && !result->output.has_value());
    // !ok 分支不解析 output（zod false 分支对未知键 strip 而非拒帧）
    CHECK(decodeOk((R"({"header":{"type":"execute_command_result","id":")" + kId
                    + R"("},"body":{"ok":false,"error":"x","output":["ignored"]}})")
                       .c_str(),
                   frame));
    result = std::get_if<ResultFrame>(&frame);
    CHECK(result != nullptr);
    if (result != nullptr) CHECK(!result->ok && !result->output.has_value());
    // ok=true 分支不存在的 error 字段同样 strip（resultBodySchema 第一分支仅 ok）
    CHECK(decodeOk((R"({"header":{"type":"broadcast_result","id":")" + kId
                    + R"("},"body":{"ok":true,"error":"ignored"}})")
                       .c_str(),
                   frame));
    CHECK(std::get_if<ResultFrame>(&frame) != nullptr && std::get<ResultFrame>(frame).ok);
}

// ---- 解码：垃圾行 / 未知 type（告警跳过面）----

void testDecodeSkipsGarbageAndUnknownLines() {
    std::string reason;
    CHECK(decodeFails("not json at all", &reason));
    CHECK(decodeFails(""));
    CHECK(decodeFails("[]"));
    CHECK(decodeFails("{}"));
    CHECK(decodeFails("\"text\""));
    CHECK(decodeFails("42"));
    CHECK(decodeFails("null"));
    // 未知 type
    CHECK(decodeFails(R"({"header":{"type":"mystery"},"body":{}})", &reason));
    CHECK(reason.find("未知") != std::string::npos);
    // 出站事件帧对 C++ 解码侧同样属未知（C++ 只收 ready/请求/结果）
    CHECK(decodeFails(R"({"header":{"type":"game_chat"},"body":{"playerName":"a","content":"b"}})"));
    // 结构面
    CHECK(decodeFails(R"({"header":{},"body":{}})"));                       // 空 header
    CHECK(decodeFails(R"({"header":{"type":"ready"}})"));                   // 缺 body
    CHECK(decodeFails(R"({"body":{}})"));                                   // 缺 header
    CHECK(decodeFails(R"({"header":[],"body":{}})"));                       // header 非对象
    CHECK(decodeFails(R"({"header":{"type":"ready"},"body":[]})"));         // body 非对象
    CHECK(decodeFails(R"({"header":{"body":1},"body":{}})"));               // type 缺失
    CHECK(decodeFails(R"({"header":{"type":42},"body":{}})"));              // type 非字符串
}

// ---- UUID 口径（zod 4.4.3 z.uuid()）----

void testIsValidUuidZodSemantics() {
    using kurobridge::ipc::isValidUuid;
    // 合法：版本 4 / 变体 89ab；十六进制大小写不敏感
    CHECK(isValidUuid("7c9e6679-7425-40de-9e6b-a07864a99ebf"));
    CHECK(isValidUuid("7C9E6679-7425-40DE-9E6B-A07864A99EBF"));
    CHECK(isValidUuid("550e8400-e29b-41d4-a716-446655440000"));
    CHECK(isValidUuid("550e8400-e29b-11d4-b716-446655440000"));  // 版本 1 亦可
    CHECK(isValidUuid("550e8400-e29b-81d4-8716-446655440000"));  // 版本 8 亦可
    // 特例：nil 与 max（全 f 仅小写）放行
    CHECK(isValidUuid("00000000-0000-0000-0000-000000000000"));
    CHECK(isValidUuid("ffffffff-ffff-ffff-ffff-ffffffffffff"));
    // 版本位非法（0/9/f 均拒）——zod 校验版本位，Java UUID.fromString 不查（既定差异）
    CHECK(!isValidUuid("550e8400-e29b-01d4-a716-446655440000"));
    CHECK(!isValidUuid("550e8400-e29b-91d4-a716-446655440000"));
    CHECK(!isValidUuid("550e8400-e29b-f1d4-a716-446655440000"));
    // 变体位非法（0-7 / c-f 拒）
    CHECK(!isValidUuid("550e8400-e29b-41d4-0716-446655440000"));
    CHECK(!isValidUuid("550e8400-e29b-41d4-c716-446655440000"));
    CHECK(!isValidUuid("550e8400-e29b-41d4-f716-446655440000"));
    // 大写 max 拒（正则特例仅小写 f）
    CHECK(!isValidUuid("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"));
    // 形状面
    CHECK(!isValidUuid(""));
    CHECK(!isValidUuid("550e8400e29b41d4a716446655440000"));       // 缺连字符
    CHECK(!isValidUuid("550e8400-e29b-41d4-a716-44665544000"));    // 少一位
    CHECK(!isValidUuid("550e8400-e29b-41d4-a716-4466554400000"));  // 多一位
    CHECK(!isValidUuid("550e8400_e29b_41d4_a716_446655440000"));   // 错分隔符
    CHECK(!isValidUuid("g50e8400-e29b-41d4-a716-446655440000"));   // 非十六进制
    CHECK(!isValidUuid("{550e8400-e29b-41d4-a716-446655440000}"));  // 花括号包裹
}

void testUuidEnforcedInFrames() {
    // 版本位非法的 UUID 使请求帧整帧拒绝（zod 口径落到帧上）
    CHECK(decodeFails(
        R"({"header":{"type":"broadcast","id":"550e8400-e29b-01d4-a716-446655440000"},"body":{"channel":"g","message":"hi"}})"));
    CHECK(decodeFails(
        R"({"header":{"type":"broadcast_result","id":"550e8400-e29b-41d4-c716-446655440000"},"body":{"ok":true}})"));
    // nil UUID 放行
    DecodedFrame frame;
    CHECK(decodeOk(
        R"({"header":{"type":"broadcast","id":"00000000-0000-0000-0000-000000000000"},"body":{"channel":"g","message":"hi"}})",
        frame));
    CHECK(std::get_if<BroadcastRequest>(&frame) != nullptr);
}

// ---- 帧内容面：转义与重复键 ----

void testFrameStringEscapesAndDupKeys() {
    // emoji 代理对入帧 → 解码得 UTF-8 字节
    DecodedFrame frame;
    CHECK(decodeOk(R"({"header":{"type":"ready"},"body":{"wsPort":1,"note":"😀"}})", frame));
    // 重复键末者胜（对齐 JSON.parse）
    CHECK(decodeOk(R"({"header":{"type":"ready","type":"ready"},"body":{"wsPort":1,"wsPort":2}})",
                   frame));
    CHECK(std::get_if<ReadyFrame>(&frame) != nullptr && std::get<ReadyFrame>(frame).wsPort == 2);
    // header 出现重复键视为携带多余键（严格单键校验按成员数判定）
    CHECK(decodeFails(R"({"header":{"type":"ready","junk":1},"body":{"wsPort":1}})"));
}

}  // namespace

int main() {
    testEncodeEventHasNoId();
    testEncodeConfigReloadEmptyBody();
    testEncodeStatusNumbers();
    testEncodeRequestCarriesUuid();
    testEncodeResultShapes();
    testEncodeDecodeRoundTrip();
    testDecodeAcceptsReady();
    testDecodeRejectsInvalidReady();
    testDecodeAcceptsRequest();
    testDecodeRejectsInvalidRequest();
    testDecodeAcceptsResult();
    testDecodeRejectsInvalidResult();
    testDecodeResultUnionStripSemantics();
    testDecodeSkipsGarbageAndUnknownLines();
    testIsValidUuidZodSemantics();
    testUuidEnforcedInFrames();
    testFrameStringEscapesAndDupKeys();
    return finish_test("test_ipc_frame");
}
