// KuroBridge Endstone 薄壳 / Node→游戏 请求处理实现。见 bridge.h 头注。

#include "bridge.h"

#include <exception>
#include <string_view>
#include <utility>

#include <endstone/command/command_sender_wrapper.h>
#include <endstone/command/console_command_sender.h>
#include <endstone/scheduler/scheduler.h>
#include <endstone/server.h>

#include "core/node_ipc.h"

namespace kurobridge {

std::string messageToPlainText(const endstone::Server& server, const endstone::Message& message) {
    if (const auto* text = std::get_if<std::string>(&message)) {
        return *text;
    }
    if (const auto* translatable = std::get_if<endstone::Translatable>(&message)) {
        return server.getLanguage().translate(*translatable);
    }
    return "";  // Message 恒为 string/Translatable 二选一，防御兜底
}

namespace {

bool extractBracketLevel(const std::string& line, std::string_view channelPrefix,
                         endstone::Logger::Level& level) {
    if (line.rfind(channelPrefix, 0) != 0) {
        return false;  // 前缀须整段匹配（行首），消息体内同形字样不得误判
    }
    const std::size_t start = channelPrefix.size();
    const std::size_t end = line.find(']', start);
    if (end == std::string::npos) {
        return false;
    }
    const std::string_view token(line.data() + start, end - start);
    if (token == "INFO") {
        level = endstone::Logger::Info;
    } else if (token == "WARN") {
        level = endstone::Logger::Warning;
    } else if (token == "SEVERE") {
        level = endstone::Logger::Critical;
    } else {
        return false;
    }
    return true;
}

}  // namespace

void relayLogLine(endstone::Logger& logger, const std::string& line) {
    endstone::Logger::Level level = endstone::Logger::Info;
    if (!extractBracketLevel(line, "[NodeIpc][", level)
        && !extractBracketLevel(line, "[NodeSupervisor][", level)) {
        if (const std::optional<std::string_view> nodeLevel = core::parseNodeLogLevel(line)) {
            if (*nodeLevel == "debug") {
                level = endstone::Logger::Debug;
            } else if (*nodeLevel == "warn") {
                level = endstone::Logger::Warning;
            } else if (*nodeLevel == "error") {
                level = endstone::Logger::Error;
            }
            // info / 未知级别片段 → 保守 Info
        }
    }
    logger.log(level, line);
}

Bridge::Bridge(endstone::Plugin& plugin) : plugin_(plugin) {}

void Bridge::onReady(long long wsPort, bool autoRestart) {
    // autoRestart 看护开关已由 core NodeRuntime 消费（setAutoRestart），此处留宿主可观测日志
    plugin_.getLogger().info("Node 子进程就绪，WS 端口 " + std::to_string(wsPort) + "（autoRestart="
                             + (autoRestart ? "true" : "false") + "）");
}

void Bridge::onBroadcast(const ipc::BroadcastRequest& request, const core::ResultResponder& respond) {
    // channel 字段 v1 忽略不报错（Java 薄壳同样不消费）；node relay 的频道路由是 Node 侧
    // 业务，未来若需按 channel 定向广播，在此对接点消费 request.channel。
    endstone::Server& server = plugin_.getServer();
    try {
        server.getScheduler().runTask(plugin_, [&server, message = request.message] {
            server.broadcastMessage(endstone::Message{message});  // Message 的 string 分支
        });
    } catch (const std::exception& e) {
        // 插件已 disable 等导致调度失败：显式回执失败，避免 Node 侧等到超时（对齐 Java）
        respond(false, "调度广播到主线程失败：" + std::string(e.what()), {});
        return;
    }
    respond(true, "", {});  // 广播调度后即回执 ok（对齐 Java 语义）
}

void Bridge::onExecuteCommand(const ipc::ExecuteCommandRequest& request,
                              const core::ResultResponder& respond) {
    // 回执时序（对齐 Java v0.3.0）：主线程任务执行完才回执（Node 等待真实执行完成）；主线程
    // 卡死超 10s 由 Node 侧既有请求超时兜底。
    try {
        plugin_.getServer().getScheduler().runTask(
            plugin_, [this, command = request.command, respond] { executeOnMainThread(command, respond); });
    } catch (const std::exception& e) {
        respond(false, "调度命令执行到主线程失败：" + std::string(e.what()), {});
    }
}

void Bridge::executeOnMainThread(const std::string& command, const core::ResultResponder& respond) {
    std::vector<std::string> output;
    endstone::Server& server = plugin_.getServer();
    // 包装 console sender：stdout/stderr 两路输出均收集（对齐 Java CollectingCommandSender
    // + VanillaFeedbackCapture 双路）；endstone 无 vanilla sender 拒绝问题，单路即可覆盖。
    endstone::CommandSenderWrapper wrapper(
        server.getCommandSender(),
        [&output, &server](const endstone::Message& message) {
            output.push_back(messageToPlainText(server, message));
        },
        [&output, &server](const endstone::Message& message) {
            output.push_back(messageToPlainText(server, message));
        });
    bool ok = false;
    try {
        ok = server.dispatchCommand(wrapper, command);
    } catch (const std::exception& e) {
        // 命令本身抛异常（插件命令 bug 等）：显式回执失败，避免 Node 侧等到超时（对齐 Java）
        respond(false, "命令执行异常：" + std::string(e.what()), {});
        return;
    }
    if (ok) {
        respond(true, "", std::move(output));
    } else {
        // endstone dispatchCommand 以返回值报执行失败（未知命令等；Java 对应 CommandException 路径）
        respond(false, "命令执行失败：" + command, {});
    }
}

void Bridge::onStderrLine(const std::string& line) { relayLogLine(plugin_.getLogger(), line); }

void Bridge::onProcessExited(const std::optional<unsigned long>& exitCode, const std::string& cause) {
    // 看护决策（重启/放弃）在 core NodeSupervisor，此处仅留宿主可观测的记录（对齐 Java）
    plugin_.getLogger().info("Node 进程退出通知：exit="
                             + (exitCode.has_value() ? std::to_string(*exitCode) : std::string("未知"))
                             + "，原因=" + cause);
}

}  // namespace kurobridge
