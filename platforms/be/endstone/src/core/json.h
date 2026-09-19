// kurobridge_core / JSON —— 按协议面定制的最小 JSON 实现（feasibility.md R4）
//
// 口径来源：对齐 JS `JSON.parse` / `JSON.stringify`（协议 SSOT 侧即 Node 的原生
// JSON），不做通用 JSON 库。协议帧为扁平对象 + string[]，正常深度 ≤3；解析递归
// 深度上限 32（超限报错，防对抗输入爆栈）。
//
// 本文件属 portable 层：零 endstone 依赖、纯 std C++20。

#pragma once

#include <cstddef>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace kurobridge {

// JSON 值。对象成员保序（vector<pair>，插入序 = JS 对象字符串键的枚举序；协议键名
// 固定非数字，JS「数字型键先行」的边角不在协议面内，不模拟）。
// 内部最小值类型：字段公开供同实现的解析/序列化直接读写，外部按 type()/as*() 消费。
struct JsonValue {
    enum class Type { Null, Bool, Number, String, Array, Object };

    using Member = std::pair<std::string, JsonValue>;
    using Members = std::vector<Member>;

    // 判别标签与载荷（type_ 决定哪个载荷有效）
    Type type_ = Type::Null;
    bool bool_ = false;
    double number_ = 0.0;
    std::string string_;
    std::vector<JsonValue> array_;
    Members object_;

    // 缺省构造 = null
    JsonValue() = default;

    static JsonValue nullValue() { return JsonValue(); }
    static JsonValue boolean(bool value);
    static JsonValue number(double value);
    static JsonValue string(std::string value);
    static JsonValue array(std::vector<JsonValue> items);
    static JsonValue object(Members members);
    static JsonValue object();

    Type type() const { return type_; }
    bool isNull() const { return type_ == Type::Null; }
    bool isBool() const { return type_ == Type::Bool; }
    bool isNumber() const { return type_ == Type::Number; }
    bool isString() const { return type_ == Type::String; }
    bool isArray() const { return type_ == Type::Array; }
    bool isObject() const { return type_ == Type::Object; }

    // 以下访问器仅在对应 is*() 为真时有效（不校验，调用方先用 is*() 分支）
    bool asBool() const { return bool_; }
    double asNumber() const { return number_; }
    const std::string& asString() const { return string_; }
    const std::vector<JsonValue>& asArray() const { return array_; }
    const Members& asObject() const { return object_; }

    // JS Number.isInteger 口径：有限且无小数部分——"1.0" 解析出的 1.0 亦为整数
    // （zod z.number().int() 即此语义，如 ready.wsPort 需接受）
    bool isInteger() const;

    // 对象成员查找：本值非对象或键不存在返回 nullptr
    const JsonValue* find(std::string_view key) const;

    // 追加对象成员（保持插入序；不去重——解析路径已保证末者胜，此处供构造用）
    void addMember(std::string key, JsonValue value);
};

// 解析结果：ok=false 时 error 为中文描述、offset 为出错处字节偏移（供日志定位）。
struct JsonParseResult {
    bool ok = false;
    JsonValue value{};
    std::string error;
    std::size_t offset = 0;
};

// 解析一段 JSON 文本。文本前后允许空白；文本结束后仍有多余内容视为错误。
// 数字溢出（如 1e999）按 JSON.parse 口径得到 ±Infinity 而非报错（上游 zod 会拒）。
// 递归深度上限 32 层（容器嵌套）；孤立代理对（\uD800 无配对）视为错误
// （比 JSON.parse 严格：本层产出必须是合法 UTF-8，无法表达孤立代理）。
JsonParseResult parseJson(std::string_view text);

// 序列化，对齐 JSON.stringify：无空白、对象按插入序、控制字符转义
//（\b \t \n \f \r 与 \u00xx 小写十六进制）、UTF-8 非 ASCII 原样直出、
// 整型不带 ".0"、非整型 double 用最短往返表示（std::to_chars）。
// 与 JS 的已知偏差：非常规量级下 to_chars 的书写形式可能不同（如 1e-7 会写成
// "1e-07"、指数形式补零）；仅书写差异，数值可无损往返，协议面数值不触及。
// 非有限数（±Infinity/NaN）序列化为 null（对齐 JSON.stringify）。
std::string serializeJson(const JsonValue& value);

}  // namespace kurobridge
