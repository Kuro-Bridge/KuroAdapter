#include "core/json.h"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdlib>

namespace kurobridge {
namespace {

// 容器嵌套深度上限（数组/对象各算一层；正常协议帧深度 ≤3，此上限仅防对抗输入）
constexpr int kMaxDepth = 32;

// 码点 → UTF-8（解析 \uXXXX 用；输入码点须为合法标量值，代理对已在调用处合并）
void appendUtf8(std::string& out, std::uint32_t cp) {
    if (cp <= 0x7F) {
        out.push_back(static_cast<char>(cp));
    } else if (cp <= 0x7FF) {
        out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp <= 0xFFFF) {
        out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
}

bool isHexDigit(char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

int hexValue(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return c - 'A' + 10;
}

// 递归下降解析器。depth 为当前容器嵌套层数（顶层标量 = 0）。
struct Parser {
    std::string_view text;
    std::size_t pos = 0;
    JsonParseResult* result = nullptr;

    bool fail(std::string message) {
        if (!result->ok) return false;  // 首错优先，后续不覆盖
        result->ok = false;
        result->error = std::move(message);
        result->offset = pos;
        return false;
    }

    void skipWhitespace() {
        while (pos < text.size()) {
            char c = text[pos];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                ++pos;
            } else {
                break;
            }
        }
    }

    char peek() const { return pos < text.size() ? text[pos] : '\0'; }

    bool consume(char expected) {
        if (peek() == expected) {
            ++pos;
            return true;
        }
        return false;
    }

    JsonValue parseValue(int depth) {
        skipWhitespace();
        switch (peek()) {
            case '{':
                return parseObject(depth);
            case '[':
                return parseArray(depth);
            case '"': {
                std::string parsed;
                if (!parseStringInto(parsed)) return JsonValue();
                return JsonValue::string(std::move(parsed));
            }
            case 't':
                return parseLiteral("true", JsonValue::boolean(true));
            case 'f':
                return parseLiteral("false", JsonValue::boolean(false));
            case 'n':
                return parseLiteral("null", JsonValue::nullValue());
            default:
                if (peek() == '-' || (peek() >= '0' && peek() <= '9')) return parseNumber();
                fail("非法的值起始字符");
                return JsonValue();
        }
    }

    JsonValue parseLiteral(std::string_view literal, JsonValue value) {
        if (text.substr(pos, literal.size()) == literal) {
            pos += literal.size();
            return value;
        }
        fail("非法的字面量");
        return JsonValue();
    }

    JsonValue parseObject(int depth) {
        if (depth + 1 > kMaxDepth) {
            fail("对象嵌套深度超过上限 32");
            return JsonValue();
        }
        ++pos;  // '{'
        JsonValue obj = JsonValue::object();
        skipWhitespace();
        if (consume('}')) return obj;
        while (true) {
            skipWhitespace();
            if (peek() != '"') {
                fail("对象键须为字符串");
                return JsonValue();
            }
            std::string key;
            if (!parseStringInto(key)) return JsonValue();
            skipWhitespace();
            if (!consume(':')) {
                fail("对象键后缺少冒号");
                return JsonValue();
            }
            JsonValue value = parseValue(depth + 1);
            if (!result->ok) return JsonValue();
            // 重复键末者胜且保留首次出现位置（对齐 JS JSON.parse 的属性赋值语义）
            auto it = std::find_if(obj.object_.begin(), obj.object_.end(),
                                   [&key](const JsonValue::Member& m) { return m.first == key; });
            if (it != obj.object_.end()) {
                it->second = std::move(value);
            } else {
                obj.object_.emplace_back(std::move(key), std::move(value));
            }
            skipWhitespace();
            if (consume(',')) continue;
            if (consume('}')) return obj;
            fail("对象成员后缺少逗号或右花括号");
            return JsonValue();
        }
    }

    JsonValue parseArray(int depth) {
        if (depth + 1 > kMaxDepth) {
            fail("数组嵌套深度超过上限 32");
            return JsonValue();
        }
        ++pos;  // '['
        JsonValue arr = JsonValue::array(std::vector<JsonValue>());
        skipWhitespace();
        if (consume(']')) return arr;
        while (true) {
            JsonValue value = parseValue(depth + 1);
            if (!result->ok) return JsonValue();
            arr.array_.push_back(std::move(value));
            skipWhitespace();
            if (consume(',')) continue;
            if (consume(']')) return arr;
            fail("数组元素后缺少逗号或右中括号");
            return JsonValue();
        }
    }

    // 解析字符串字面量（含开闭引号）到 out；失败时返回 false 并已置错误。
    // 原始字节（UTF-8）直通，转义序列按 JSON 规范展开。
    bool parseStringInto(std::string& out) {
        ++pos;  // 开引号
        out.clear();
        while (pos < text.size()) {
            char c = text[pos];
            if (c == '"') {
                ++pos;
                return true;
            }
            if (c == '\\') {
                ++pos;
                if (pos >= text.size()) break;
                char esc = text[pos++];
                switch (esc) {
                    case '"': out.push_back('"'); break;
                    case '\\': out.push_back('\\'); break;
                    case '/': out.push_back('/'); break;
                    case 'b': out.push_back('\b'); break;
                    case 'f': out.push_back('\f'); break;
                    case 'n': out.push_back('\n'); break;
                    case 'r': out.push_back('\r'); break;
                    case 't': out.push_back('\t'); break;
                    case 'u': {
                        std::uint32_t cp = 0;
                        if (!readHex4(cp)) return false;
                        if (cp >= 0xD800 && cp <= 0xDBFF) {
                            // 高代理：必须紧跟 \uDC00-\uDFFF 组成代理对（合并为增补码点）
                            if (pos + 1 >= text.size() || text[pos] != '\\' || text[pos + 1] != 'u') {
                                fail("孤立的高代理对");
                                return false;
                            }
                            pos += 2;
                            std::uint32_t low = 0;
                            if (!readHex4(low)) return false;
                            if (low < 0xDC00 || low > 0xDFFF) {
                                fail("代理对低半区非法");
                                return false;
                            }
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                        } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                            fail("孤立的低代理对");
                            return false;
                        }
                        appendUtf8(out, cp);
                        break;
                    }
                    default:
                        fail("非法的转义字符");
                        return false;
                }
                continue;
            }
            if (static_cast<unsigned char>(c) < 0x20) {
                fail("字符串中出现未转义的控制字符");
                return false;
            }
            out.push_back(c);  // 非 ASCII 字节原样直通（UTF-8 直出口径）
            ++pos;
        }
        fail("字符串未闭合");
        return false;
    }

    bool readHex4(std::uint32_t& out) {
        if (pos + 4 > text.size()) {
            fail("\\u 转义不足 4 位十六进制");
            return false;
        }
        std::uint32_t value = 0;
        for (int i = 0; i < 4; ++i) {
            char c = text[pos + static_cast<std::size_t>(i)];
            if (!isHexDigit(c)) {
                fail("\\u 转义含非十六进制字符");
                return false;
            }
            value = (value << 4) | static_cast<std::uint32_t>(hexValue(c));
        }
        pos += 4;
        out = value;
        return true;
    }

    // 严格 JSON 数字文法：-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?
    // （拒绝前导零/尾随点/孤立正负号——对齐 JSON.parse）
    JsonValue parseNumber() {
        const std::size_t start = pos;
        consume('-');
        if (peek() == '0') {
            ++pos;
        } else if (peek() >= '1' && peek() <= '9') {
            while (peek() >= '0' && peek() <= '9') ++pos;
        } else {
            fail("数字整数部分非法");
            return JsonValue();
        }
        if (peek() == '.') {
            ++pos;
            if (!(peek() >= '0' && peek() <= '9')) {
                fail("小数点后缺少数位");
                return JsonValue();
            }
            while (peek() >= '0' && peek() <= '9') ++pos;
        }
        if (peek() == 'e' || peek() == 'E') {
            ++pos;
            if (peek() == '+' || peek() == '-') ++pos;
            if (!(peek() >= '0' && peek() <= '9')) {
                fail("指数部分缺少数位");
                return JsonValue();
            }
            while (peek() >= '0' && peek() <= '9') ++pos;
        }
        // strtod 需 NUL 终止缓冲（token 为纯 ASCII 数字文法，可安全窄化）；
        // 本进程不 setlocale，恒为 C locale，小数点行为确定。
        std::string token(text.substr(start, pos - start));
        char* end = nullptr;
        double value = std::strtod(token.c_str(), &end);
        if (end != token.c_str() + token.size()) {
            fail("数字解析失败");
            return JsonValue();
        }
        // 溢出得 ±Infinity：对齐 JSON.parse（"1e999" → Infinity，不报错），上游 zod 会拒
        return JsonValue::number(value);
    }
};

void serializeString(const std::string& value, std::string& out) {
    constexpr char kHex[] = "0123456789abcdef";
    out.push_back('"');
    for (char raw : value) {
        unsigned char c = static_cast<unsigned char>(raw);
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\t': out += "\\t"; break;
            case '\n': out += "\\n"; break;
            case '\f': out += "\\f"; break;
            case '\r': out += "\\r"; break;
            default:
                if (c < 0x20) {
                    out += "\\u00";
                    out.push_back(kHex[c >> 4]);
                    out.push_back(kHex[c & 0x0F]);
                } else {
                    out.push_back(raw);  // UTF-8 原样直出（非 ASCII 不转义）
                }
        }
    }
    out.push_back('"');
}

// 整型（Number.isInteger 口径）且落在 int64 值域内时按整数书写（无 ".0"，对齐
// JSON.stringify）；其余用 std::to_chars 最短往返表示（general）。
void serializeNumber(double value, std::string& out) {
    char buf[64];
    constexpr double kInt64MinAsDouble = -9223372036854775808.0;      // -2^63（含）
    constexpr double kInt64MaxBoundAsDouble = 9223372036854775808.0;  // 2^63（开区间上界）
    if (value >= kInt64MinAsDouble && value < kInt64MaxBoundAsDouble && value == std::trunc(value)) {
        // 含 ±0：-0.0 按整数 0 书写（对齐 JSON.stringify(-0) → "0"）
        auto res = std::to_chars(buf, buf + sizeof(buf), static_cast<long long>(value));
        out.append(buf, res.ptr);
        return;
    }
    auto res = std::to_chars(buf, buf + sizeof(buf), value);
    out.append(buf, res.ptr);
}

void serializeValue(const JsonValue& value, std::string& out) {
    switch (value.type()) {
        case JsonValue::Type::Null:
            out += "null";
            break;
        case JsonValue::Type::Bool:
            out += value.asBool() ? "true" : "false";
            break;
        case JsonValue::Type::Number:
            if (std::isfinite(value.asNumber())) {
                serializeNumber(value.asNumber(), out);
            } else {
                out += "null";  // 对齐 JSON.stringify：非有限数序列化为 null
            }
            break;
        case JsonValue::Type::String:
            serializeString(value.asString(), out);
            break;
        case JsonValue::Type::Array: {
            out.push_back('[');
            bool first = true;
            for (const JsonValue& item : value.asArray()) {
                if (!first) out.push_back(',');
                first = false;
                serializeValue(item, out);
            }
            out.push_back(']');
            break;
        }
        case JsonValue::Type::Object: {
            out.push_back('{');
            bool first = true;
            for (const JsonValue::Member& member : value.asObject()) {
                if (!first) out.push_back(',');
                first = false;
                serializeString(member.first, out);
                out.push_back(':');
                serializeValue(member.second, out);
            }
            out.push_back('}');
            break;
        }
    }
}

}  // namespace

JsonValue JsonValue::boolean(bool value) {
    JsonValue v;
    v.type_ = Type::Bool;
    v.bool_ = value;
    return v;
}

JsonValue JsonValue::number(double value) {
    JsonValue v;
    v.type_ = Type::Number;
    v.number_ = value;
    return v;
}

JsonValue JsonValue::string(std::string value) {
    JsonValue v;
    v.type_ = Type::String;
    v.string_ = std::move(value);
    return v;
}

JsonValue JsonValue::array(std::vector<JsonValue> items) {
    JsonValue v;
    v.type_ = Type::Array;
    v.array_ = std::move(items);
    return v;
}

JsonValue JsonValue::object(Members members) {
    JsonValue v;
    v.type_ = Type::Object;
    v.object_ = std::move(members);
    return v;
}

JsonValue JsonValue::object() { return object(Members()); }

bool JsonValue::isInteger() const {
    // JS Number.isInteger：有限且 floor(x) == x（1.0、2e2 均为整数）
    return isNumber() && std::isfinite(number_) && number_ == std::floor(number_);
}

const JsonValue* JsonValue::find(std::string_view key) const {
    if (type_ != Type::Object) return nullptr;
    for (const Member& member : object_) {
        if (member.first == key) return &member.second;
    }
    return nullptr;
}

void JsonValue::addMember(std::string key, JsonValue value) {
    type_ = Type::Object;
    object_.emplace_back(std::move(key), std::move(value));
}

JsonParseResult parseJson(std::string_view text) {
    JsonParseResult result;
    result.ok = true;
    Parser parser{text, 0, &result};
    result.value = parser.parseValue(0);
    if (result.ok) {
        parser.skipWhitespace();
        if (parser.pos != text.size()) parser.fail("JSON 文本结束后仍有多余内容");
    }
    if (!result.ok) result.value = JsonValue();
    return result;
}

std::string serializeJson(const JsonValue& value) {
    std::string out;
    serializeValue(value, out);
    return out;
}

}  // namespace kurobridge
