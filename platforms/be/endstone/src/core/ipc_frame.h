// kurobridge_core / IPC 帧编解码 —— 协议 SSOT（npm 包 @kuro-bridge/protocol 0.4.0 的
// zod schema）的 C++ 硬编码副本，行为对照物为 Java `platforms/je/core/.../IpcFrameCodec.java`。
//
// 线格式（JSON-lines）：单行 `{"header":{"type","id"?},"body":{...}}`。
// 换行约定（传输层职责，本层编解码 API 不含换行符）：写出由传输层在帧尾补 '\n'
// （LF）；读取由传输层按行切分、容忍行尾 '\r'（CRLF）、空白行跳过。
//
// 与 Java 的两处既定差异（feasibility.md §5 裁决，均以 zod 为权威）：
//   1. broadcast 请求的 channel 按 zod 严格校验 min(1)（Java decodeRequest 有意
//      只查 message 不查 channel，IpcFrameCodec.java 的已知宽容副本）；
//   2. ready.wsPort 按 JS Number.isInteger 口径接受 JSON 整数值（"1.0"、"1e2"），
//      Java 的 Jackson isIntegralNumber 会拒 1.0——本层对齐 zod。
//
// 本文件属 portable 层：零 endstone 依赖、纯 std C++20。

#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include "core/json.h"

namespace kurobridge::ipc {

// ---- 帧类型（SSOT 的 IPC 帧目录）----
// C++（endstone 薄壳，Java 同位）入帧：ready / broadcast / execute_command；
// 出帧：四类游戏事件 + status / shutdown / config_reload（encodeEvent 按需构造，
// 不逐一设 API）与两种 *_result（encodeResult）。
inline constexpr std::string_view kTypeReady = "ready";
inline constexpr std::string_view kTypeBroadcast = "broadcast";
inline constexpr std::string_view kTypeExecuteCommand = "execute_command";
inline constexpr std::string_view kTypeBroadcastResult = "broadcast_result";
inline constexpr std::string_view kTypeExecuteCommandResult = "execute_command_result";

// ---- 解码结果载荷 ----

// ready 事件（Node 就绪）。wsPort：z.number().int().positive()；autoRestart 可选，
// 缺省消费方按 true 处理（null 按 true 的口径在调用方）。
struct ReadyFrame {
    long long wsPort = 0;
    std::optional<bool> autoRestart;
};

struct BroadcastRequest {
    std::string id;
    std::string channel;  // zod min(1)，本层严格校验（见文件头差异说明 1）
    std::string message;  // zod min(1)
};

struct ExecuteCommandRequest {
    std::string id;
    std::string command;  // zod min(1)
};

// broadcast_result / execute_command_result。output 仅 execute_command_result 的
// ok 分支解析（zod union 分支序：ok=true 在前）；broadcast_result 携带 output 一律
// 忽略（resultBodySchema 非 strict 的 strip 语义）；ok=false 分支不解析 output。
struct ResultFrame {
    std::string type;  // kTypeBroadcastResult | kTypeExecuteCommandResult
    std::string id;
    bool ok = false;
    std::string error;  // ok=false 时有效
    std::optional<std::vector<std::string>> output;  // nullopt = 未携带/被忽略
};

using DecodedFrame = std::variant<ReadyFrame, BroadcastRequest, ExecuteCommandRequest, ResultFrame>;

// 解码结果：ok=false 时 error 为中文拒帧原因（调用方 WARN + 跳过，不崩溃不断通道）。
struct DecodeResult {
    bool ok = false;
    DecodedFrame frame{};
    std::string error;
};

// UUID 校验，口径 = 协议实际依赖的 zod 4.4.3 `z.uuid()`（无版本参数）：
// 8-4-4-4-12 十六进制（大小写不敏感）；版本位（第 3 组首字符）限 1-8；变体位
//（第 4 组首字符）限 89ab；特例整体放行 nil（全 0）与 max（全 f，仅小写）。
// 注意这比 Java UUID.fromString 严格（Java 不查版本/变体位且接受大写 max）。
bool isValidUuid(std::string_view value);

// 解码一行 stdout。任何非法/未知输入返回 ok=false，绝不抛异常（对齐 Java decode）。
// 顶层多余键宽松（z.object strip）；入帧 body 多余键宽松；事件帧 header 严格
//（zod strictObject：仅 type 一个键，携带 id 或多余键即拒帧）；请求/响应帧 header
// 其余键宽松（frameHeaderSchema 非 strict）。
DecodeResult decodeFrame(std::string_view line);

// ---- 编码（全部单行、不含换行符；换行由传输层补）----

// 事件帧：header 仅 type，结构上不可能携带 id（对齐 eventFrameSchema 的 strictObject）。
std::string encodeEvent(std::string_view type, const JsonValue& body);

// 请求帧：header 携带 type + id（id 由调用方保证为合法 UUID，对齐 Java 编码侧不复查）。
std::string encodeRequest(std::string_view type, std::string_view id, const JsonValue& body);

// 结果帧（供测试/未来用）：ok=false 落 error；ok=true 且 output 非空才落 output
//（null/空输出不产生字段——对齐 commandResultBodySchema 的 optional 与
// JSON.stringify 的 undefined 键省略语义）。
std::string encodeResult(std::string_view type, std::string_view id, bool ok,
                         std::string_view error, const std::vector<std::string>* output);

}  // namespace kurobridge::ipc
