#include "core/ipc_frame.h"

#include <utility>

namespace kurobridge::ipc {
namespace {

// wsPort 上界：JS 安全整数 2^53-1。zod z.number() 理论上接受任意大的整数值
//（Number.isInteger(1e30) 为真），实际端口域 1-65535，超出安全整数即视为非法帧
//（差异不可达，登记备查）。
constexpr double kSafeIntegerMax = 9007199254740991.0;  // 2^53-1

bool isHexDigit(char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

DecodeResult makeFailure(std::string reason) {
    DecodeResult result;
    result.ok = false;
    result.error = std::move(reason);
    return result;
}

// 请求/响应帧的 id：必填、字符串、过 zod uuid 口径（对齐 frameHeaderSchema.extend
// 的 id: z.uuid()）。
std::optional<std::string> headerId(const JsonValue& header) {
    const JsonValue* id = header.find("id");
    if (id == nullptr || !id->isString()) return std::nullopt;
    if (!isValidUuid(id->asString())) return std::nullopt;
    return id->asString();
}

DecodeResult decodeReady(const JsonValue& header, const JsonValue& body) {
    // 事件帧 header 严格（对齐 eventFrameSchema 的 z.strictObject({type: literal})）：
    // 携带 id 或任何多余键即拒帧；唯一键不是 type 时下面 type 查找已拒。
    if (header.asObject().size() != 1) {
        return makeFailure("ready 的 header 非严格单键（事件帧禁止携带 id 或多余键）");
    }
    const JsonValue* port = body.find("wsPort");
    if (port == nullptr || !port->isNumber() || !port->isInteger()) {
        return makeFailure("ready 的 wsPort 缺失或非 JSON 整数值");
    }
    const double value = port->asNumber();
    if (!(value > 0) || value > kSafeIntegerMax) {
        return makeFailure("ready 的 wsPort 须为正整数");
    }
    ReadyFrame frame;
    frame.wsPort = static_cast<long long>(value);
    const JsonValue* autoRestart = body.find("autoRestart");
    if (autoRestart != nullptr) {
        if (!autoRestart->isBool()) return makeFailure("ready 的 autoRestart 须为布尔");
        frame.autoRestart = autoRestart->asBool();
    }
    DecodeResult result;
    result.ok = true;
    result.frame = frame;
    return result;
}

// 请求帧 body：字段均为 min(1) 的非空字符串（对齐 z.string().min(1)）；
// broadcast 传 {"channel","message"}（channel 严格校验是本层对 Java 的既定差异，
// 见文件头），execute_command 传 {"command"}。body 其余键宽松（非 strict strip）。
DecodeResult decodeStringRequest(std::string_view type, const JsonValue& header,
                                 const JsonValue& body,
                                 std::initializer_list<std::string_view> fields) {
    std::optional<std::string> id = headerId(header);
    if (!id) return makeFailure(std::string(type) + " 的 id 缺失或非合法 UUID");
    for (std::string_view field : fields) {
        const JsonValue* value = body.find(field);
        if (value == nullptr || !value->isString() || value->asString().empty()) {
            return makeFailure(std::string(type) + " 的 " + std::string(field)
                               + " 须为非空字符串（zod min(1)）");
        }
    }
    DecodeResult result;
    result.ok = true;
    if (type == kTypeBroadcast) {
        BroadcastRequest frame;
        frame.id = std::move(*id);
        frame.channel = body.find("channel")->asString();
        frame.message = body.find("message")->asString();
        result.frame = std::move(frame);
    } else {
        ExecuteCommandRequest frame;
        frame.id = std::move(*id);
        frame.command = body.find("command")->asString();
        result.frame = std::move(frame);
    }
    return result;
}

// 结果帧 body union（对齐 resultBodySchema / commandResultBodySchema 的分支序：
// ok=true 分支在前；两分支均非 strict，未知键 strip 而非拒帧）：
//   - ok 缺失/非布尔 → 两分支皆不匹配 → 拒帧；
//   - ok=false：error 必填非空字符串；该分支不解析 output（携带即 strip）；
//   - ok=true：仅 execute_command_result 分支有可选 output（须为 string[]，空数组
//     合法）；broadcast_result 的第一分支无 output 字段 → 携带一律忽略。
DecodeResult decodeResult(std::string_view type, const JsonValue& header, const JsonValue& body) {
    std::optional<std::string> id = headerId(header);
    if (!id) return makeFailure(std::string(type) + " 的 id 缺失或非合法 UUID");
    const JsonValue* okNode = body.find("ok");
    if (okNode == nullptr || !okNode->isBool()) {
        return makeFailure(std::string(type) + " 的 ok 缺失或非布尔");
    }
    ResultFrame frame;
    frame.type = std::string(type);
    frame.id = std::move(*id);
    frame.ok = okNode->asBool();
    if (!frame.ok) {
        const JsonValue* error = body.find("error");
        if (error == nullptr || !error->isString() || error->asString().empty()) {
            return makeFailure(std::string(type) + " ok=false 时须携带非空 error");
        }
        frame.error = error->asString();
    } else if (type == kTypeExecuteCommandResult) {
        const JsonValue* output = body.find("output");
        if (output != nullptr) {
            if (!output->isArray()) {
                return makeFailure("execute_command_result 的 output 须为字符串数组");
            }
            std::vector<std::string> lines;
            lines.reserve(output->asArray().size());
            for (const JsonValue& item : output->asArray()) {
                if (!item.isString()) {
                    return makeFailure("execute_command_result 的 output 元素须为字符串");
                }
                lines.push_back(item.asString());
            }
            frame.output = std::move(lines);
        }
    }
    DecodeResult result;
    result.ok = true;
    result.frame = std::move(frame);
    return result;
}

JsonValue makeHeader(std::string_view type, std::string_view id, bool withId) {
    JsonValue header = JsonValue::object();
    header.addMember("type", JsonValue::string(std::string(type)));
    if (withId) header.addMember("id", JsonValue::string(std::string(id)));
    return header;
}

std::string encodeFrame(std::string_view type, std::string_view id, bool withId, const JsonValue& body) {
    JsonValue frame = JsonValue::object();
    frame.addMember("header", makeHeader(type, id, withId));
    frame.addMember("body", body);
    return serializeJson(frame);  // 无空白、无换行（serializeJson 不产换行，单行口径）
}

}  // namespace

bool isValidUuid(std::string_view value) {
    // zod 4.4.3 regexes.js 的 uuid 正则（无版本参数分支）的等价实现：
    //   ^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}
    //    |00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$
    static const std::string_view kNil = "00000000-0000-0000-0000-000000000000";
    static const std::string_view kMax = "ffffffff-ffff-ffff-ffff-ffffffffffff";  // 仅小写（正则字面量口径）
    if (value == kNil || value == kMax) return true;
    if (value.size() != 36) return false;
    for (std::size_t i = 0; i < 36; ++i) {
        const bool hyphenPosition = (i == 8 || i == 13 || i == 18 || i == 23);
        if (hyphenPosition) {
            if (value[i] != '-') return false;
        } else if (!isHexDigit(value[i])) {
            return false;
        }
    }
    const char version = value[14];  // 第 3 组首字符：版本位限 1-8
    if (version < '1' || version > '8') return false;
    switch (value[19]) {  // 第 4 组首字符：变体位限 89ab（大小写不敏感）
        case '8':
        case '9':
        case 'a':
        case 'A':
        case 'b':
        case 'B':
            return true;
        default:
            return false;
    }
}

DecodeResult decodeFrame(std::string_view line) {
    JsonParseResult parsed = parseJson(line);
    if (!parsed.ok) return makeFailure("JSON 解析失败: " + parsed.error);
    const JsonValue& root = parsed.value;
    if (!root.isObject()) return makeFailure("顶层非对象");
    const JsonValue* header = root.find("header");
    if (header == nullptr) return makeFailure("缺 header");
    if (!header->isObject()) return makeFailure("header 非对象");
    const JsonValue* body = root.find("body");
    if (body == nullptr) return makeFailure("缺 body");
    if (!body->isObject()) return makeFailure("body 非对象");
    const JsonValue* typeNode = header->find("type");
    if (typeNode == nullptr || !typeNode->isString()) return makeFailure("type 缺失或非字符串");
    const std::string& type = typeNode->asString();
    if (type == kTypeReady) return decodeReady(*header, *body);
    if (type == kTypeBroadcast) return decodeStringRequest(type, *header, *body, {"channel", "message"});
    if (type == kTypeExecuteCommand) return decodeStringRequest(type, *header, *body, {"command"});
    if (type == kTypeBroadcastResult || type == kTypeExecuteCommandResult) {
        return decodeResult(type, *header, *body);
    }
    return makeFailure("未知 type: " + type);
}

std::string encodeEvent(std::string_view type, const JsonValue& body) {
    return encodeFrame(type, "", false, body);
}

std::string encodeRequest(std::string_view type, std::string_view id, const JsonValue& body) {
    return encodeFrame(type, id, true, body);
}

std::string encodeResult(std::string_view type, std::string_view id, bool ok,
                         std::string_view error, const std::vector<std::string>* output) {
    JsonValue body = JsonValue::object();
    body.addMember("ok", JsonValue::boolean(ok));
    if (!ok) {
        body.addMember("error", JsonValue::string(std::string(error)));
    } else if (output != nullptr && !output->empty()) {
        // 空输出不产生字段（对齐 commandResultBodySchema 的 optional）
        std::vector<JsonValue> items;
        items.reserve(output->size());
        for (const std::string& line : *output) {
            items.push_back(JsonValue::string(line));
        }
        body.addMember("output", JsonValue::array(std::move(items)));
    }
    return encodeRequest(type, id, body);
}

}  // namespace kurobridge::ipc
