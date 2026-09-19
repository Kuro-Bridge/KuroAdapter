// kurobridge_core / JSON 单测 —— 口径基线：JS JSON.parse / JSON.stringify
//（协议 SSOT @kuro-bridge/protocol 侧即 Node 原生 JSON）。

#include "test_util.h"

#include <cmath>
#include <limits>
#include <string>

#include "core/json.h"

using kurobridge::JsonParseResult;
using kurobridge::JsonValue;
using kurobridge::parseJson;
using kurobridge::serializeJson;

namespace {

void testParseScalars() {
    CHECK(parseJson("null").ok);
    CHECK(parseJson("true").ok && parseJson("true").value.asBool());
    CHECK(parseJson("false").ok && !parseJson("false").value.asBool());
    CHECK(parseJson("42").ok && parseJson("42").value.asNumber() == 42.0);
    CHECK(parseJson("-2.5").ok && parseJson("-2.5").value.asNumber() == -2.5);
    CHECK(parseJson("  [1, 2]  ").ok);  // 前后空白容忍
    CHECK_EQ(parseJson("1e2").value.asNumber(), 100.0);
    CHECK_EQ(parseJson("-1.5e-3").value.asNumber(), -0.0015);
}

void testParseStringEscapes() {
    JsonParseResult r = parseJson(R"("a\"b\\c\/d\be\ff\ng\rh\ti")");
    CHECK(r.ok);
    CHECK_EQ(r.value.asString(), std::string("a\"b\\c/d\be\ff\ng\rh\ti"));
    // \uXXXX 基本面 → UTF-8（中文）
    r = parseJson(R"("\u4f60\u597d")");
    CHECK(r.ok);
    CHECK_EQ(r.value.asString(), std::string("你好"));
    // 代理对 → 增补码点（😀 = U+1F600 = F0 9F 98 80）
    r = parseJson(R"("\uD83D\uDE00")");
    CHECK(r.ok);
    CHECK_EQ(r.value.asString(), std::string("\xF0\x9F\x98\x80"));
    // 小写十六进制同样接受
    r = parseJson(R"("\ud83d\ude00")");
    CHECK(r.ok);
    CHECK_EQ(r.value.asString(), std::string("\xF0\x9F\x98\x80"));
    // 孤立代理对拒绝（比 JSON.parse 严格：产出须为合法 UTF-8）
    CHECK(!parseJson(R"("\uD83D")").ok);
    CHECK(!parseJson(R"("\uDE00")").ok);
    CHECK(!parseJson(R"("\uD83D\u0041")").ok);  // 高代理后非低代理
    // 字符串内裸控制字符拒绝
    CHECK(!parseJson("\"a\x01b\"").ok);
    CHECK(!parseJson("\"a\nb\"").ok);
    // UTF-8 原文直通
    r = parseJson("\"中文😀\"");
    CHECK(r.ok);
    CHECK_EQ(r.value.asString(), std::string("中文\xF0\x9F\x98\x80"));
}

void testParseContainers() {
    JsonParseResult r = parseJson(R"({"a":1,"b":[true,null,"x"]})");
    CHECK(r.ok);
    CHECK(r.value.isObject());
    CHECK_EQ(r.value.asObject().size(), std::size_t{2});
    CHECK_EQ(r.value.find("a")->asNumber(), 1.0);
    const JsonValue* b = r.value.find("b");
    CHECK(b != nullptr && b->isArray() && b->asArray().size() == 3);
    CHECK(b->asArray()[0].isBool() && b->asArray()[1].isNull() && b->asArray()[2].asString() == "x");
    CHECK(r.value.find("missing") == nullptr);
    // 空容器
    r = parseJson("{}");
    CHECK(r.ok && r.value.isObject() && r.value.asObject().empty());
    r = parseJson("[]");
    CHECK(r.ok && r.value.isArray() && r.value.asArray().empty());
}

void testDuplicateKeyLastWinsKeepsPosition() {
    // 重复键末者胜且保留首次出现位置（对齐 JS JSON.parse 属性赋值语义）
    JsonParseResult r = parseJson(R"({"a":1,"b":2,"a":3,"c":4})");
    CHECK(r.ok);
    CHECK_EQ(r.value.asObject().size(), std::size_t{3});
    CHECK_EQ(r.value.asObject()[0].first, std::string("a"));  // 位置不变
    CHECK_EQ(r.value.asObject()[0].second.asNumber(), 3.0);   // 值取末者
    CHECK_EQ(r.value.asObject()[1].first, std::string("b"));
    CHECK_EQ(r.value.asObject()[2].first, std::string("c"));
    CHECK_EQ(serializeJson(r.value), std::string(R"({"a":3,"b":2,"c":4})"));
}

void testDepthLimit() {
    // 32 层容器嵌套可过，33 层拒（防对抗输入爆栈）
    std::string ok(32, '[');
    ok.append(32, ']');
    CHECK(parseJson(ok).ok);
    std::string tooDeep(33, '[');
    tooDeep.append(33, ']');
    JsonParseResult r = parseJson(tooDeep);
    CHECK(!r.ok);
    CHECK_EQ(r.error, std::string("数组嵌套深度超过上限 32"));
    // 对象与数组混合计数
    std::string mixed;
    for (int i = 0; i < 32; ++i) mixed += "{\"a\":";
    mixed += "1";
    for (int i = 0; i < 32; ++i) mixed += "}";
    CHECK(parseJson(mixed).ok);
    mixed = "";
    for (int i = 0; i < 33; ++i) mixed += "{\"a\":";
    mixed += "1";
    for (int i = 0; i < 33; ++i) mixed += "}";
    CHECK(!parseJson(mixed).ok);
}

void testMalformedInputs() {
    CHECK(!parseJson("").ok);
    CHECK(!parseJson("   ").ok);
    CHECK(!parseJson("tru").ok);
    CHECK(!parseJson("truex").ok);          // 字面量后残留
    CHECK(!parseJson("{").ok);
    CHECK(!parseJson("[1,]").ok);           // 尾逗号
    CHECK(!parseJson(R"({"a":})").ok);
    CHECK(!parseJson(R"({"a" 1})").ok);     // 缺冒号
    CHECK(!parseJson(R"({"a":1,"})").ok);   // 键未闭合
    CHECK(!parseJson("01").ok);             // 前导零（JSON 文法拒绝）
    CHECK(!parseJson("+1").ok);
    CHECK(!parseJson(".5").ok);
    CHECK(!parseJson("1.").ok);             // 尾随点
    CHECK(!parseJson("1e").ok);
    CHECK(!parseJson("--1").ok);
    CHECK(!parseJson("{}extra").ok);        // 结束后多余内容
    CHECK(!parseJson("\"unclosed").ok);
    CHECK(!parseJson(R"("\q")").ok);        // 非法转义
}

void testNumberOverflowMatchesJsonParse() {
    // "1e999" 按 JSON.parse 得 Infinity（不报错），上游 zod 会拒
    JsonParseResult r = parseJson("1e999");
    CHECK(r.ok);
    CHECK(std::isinf(r.value.asNumber()));
    CHECK(!r.value.isInteger());
}

void testIsIntegerSemantics() {
    // Number.isInteger 口径：1.0 / 2e2 为整数（zod z.number().int() 据此接受）
    CHECK(parseJson("1.0").value.isInteger());
    CHECK(parseJson("2e2").value.isInteger());
    CHECK(parseJson("-0.0").value.isInteger());
    CHECK(!parseJson("1.5").value.isInteger());
    CHECK(!parseJson("null").value.isInteger());
    CHECK(!parseJson("\"1\"").value.isInteger());
}

void testSerializeGolden() {
    // 整型无 .0；-0.0 → "0"（对齐 JSON.stringify(-0)）
    CHECK_EQ(serializeJson(JsonValue::number(2.0)), std::string("2"));
    CHECK_EQ(serializeJson(JsonValue::number(-0.0)), std::string("0"));
    CHECK_EQ(serializeJson(JsonValue::number(0.0)), std::string("0"));
    CHECK_EQ(serializeJson(JsonValue::number(19.5)), std::string("19.5"));
    CHECK_EQ(serializeJson(JsonValue::number(-0.0015)), std::string("-0.0015"));
    CHECK_EQ(serializeJson(JsonValue::number(-7.0)), std::string("-7"));
    // 非有限数 → null（对齐 JSON.stringify）
    CHECK_EQ(serializeJson(JsonValue::number(std::numeric_limits<double>::infinity())),
             std::string("null"));
    // 字符串转义：控制字符 \u00xx 小写十六进制；引号反斜杠；\b \t \n \f \r 短形式；
    // UTF-8 原样直出（不转义中文/emoji）
    CHECK_EQ(serializeJson(JsonValue::string("a\x01\x1f\b\n\f\r\t\"\\z")),
             std::string("\"a\\u0001\\u001f\\b\\n\\f\\r\\t\\\"\\\\z\""));
    CHECK_EQ(serializeJson(JsonValue::string("你好😀")),
             std::string("\"你好\xF0\x9F\x98\x80\""));
    // 容器：无空白、插入序
    JsonValue frame = JsonValue::object();
    frame.addMember("type", JsonValue::string("config_reload"));
    frame.addMember("body", JsonValue::object());
    CHECK_EQ(serializeJson(frame), std::string(R"({"type":"config_reload","body":{}})"));
    JsonValue arr = JsonValue::array({JsonValue::number(1.0), JsonValue::boolean(false),
                                      JsonValue::nullValue(), JsonValue::string("s")});
    CHECK_EQ(serializeJson(arr), std::string("[1,false,null,\"s\"]"));
    // 非有限往返：Infinity 序列化为 null 后可再解析
    JsonValue inf = JsonValue::number(std::numeric_limits<double>::infinity());
    JsonParseResult back = parseJson(serializeJson(inf));
    CHECK(back.ok && back.value.isNull());
}

void testRoundTripRichObject() {
    // 混合中文/emoji/转义面（\" \\ 控制字符）与数值类型的往返稳定性
    JsonParseResult first = parseJson(
        "{\"type\":\"game_chat\",\"body\":{\"playerName\":\"Steve 你好\","
        "\"content\":\"引号\\\" 反斜杠\\\\ \\u0001ctl\",\"emoji\":\"😀\","
        "\"n\":19.5,\"i\":42,\"neg\":-3,\"arr\":[\"a\",\"b\"]}}");
    CHECK(first.ok);
    std::string once = serializeJson(first.value);
    JsonParseResult second = parseJson(once);
    CHECK(second.ok);
    // 二次往返稳定（序列化不动点）
    CHECK_EQ(serializeJson(second.value), once);
    CHECK_EQ(second.value.find("type")->asString(), std::string("game_chat"));
    const JsonValue& body = *second.value.find("body");
    CHECK_EQ(body.find("playerName")->asString(), std::string("Steve 你好"));
    CHECK_EQ(body.find("content")->asString(), std::string("引号\" 反斜杠\\ \x01""ctl"));
    CHECK_EQ(body.find("emoji")->asString(), std::string("\xF0\x9F\x98\x80"));
    CHECK_EQ(serializeJson(*body.find("n")), std::string("19.5"));
    CHECK_EQ(serializeJson(*body.find("i")), std::string("42"));
    CHECK_EQ(serializeJson(*body.find("neg")), std::string("-3"));
}

void testProgrammaticConstruction() {
    JsonValue v = JsonValue::object();
    CHECK(v.isObject() && v.asObject().empty());
    v.addMember("k", JsonValue::string("v"));
    CHECK_EQ(v.asObject().size(), std::size_t{1});
    CHECK(v.find("k") != nullptr);
    // 缺省构造 = null
    JsonValue nil;
    CHECK(nil.isNull());
}

}  // namespace

int main() {
    testParseScalars();
    testParseStringEscapes();
    testParseContainers();
    testDuplicateKeyLastWinsKeepsPosition();
    testDepthLimit();
    testMalformedInputs();
    testNumberOverflowMatchesJsonParse();
    testIsIntegerSemantics();
    testSerializeGolden();
    testRoundTripRichObject();
    testProgrammaticConstruction();
    return finish_test("test_json");
}
