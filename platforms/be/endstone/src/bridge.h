// KuroBridge Endstone 薄壳 / Node→游戏 请求处理 + 日志中继工具。
//
// Bridge 实现 core 的 NodeIpcListener 观察缝（NodeRuntime 组装时挂入）。线程契约：全部
// 回调在 NodeIpc 的读线程上被调用（core/node_ipc.h 头注），不在主线程——endstone API
// 操作一律经 Scheduler::runTask 调度回主线程（入队即返回）；broadcast 调度成功即回执，
// execute_command 主线程任务内执行完才回执（对齐 Java NodeRequestHandler 的 v0.3.0 时序）。
// 回执（ResultResponder）可跨线程调用、恰好一次；通道已关闭时由 core 忽略。
//
// 实例替换窗口说明：Node 看护器重启时以新实例整体替换 currentIpc（unique_ptr 赋值即回收
// 旧实例）。本类不在回调外留存通道指针——每帧发送/回执前现取现用，把窗口压到单次调用内
//（旧实例析构与在途发送并发的残余风险属 core 一次性实例设计的已知取舍，真机线观察）。
//
// 零业务：转发规则、权限语义等决策都在 Node 侧 bridge/core（AGENTS.md 硬约束 2）。

#pragma once

#include <optional>
#include <string>
#include <vector>

#include <endstone/message.h>
#include <endstone/plugin/plugin.h>

#include "core/node_ipc.h"

namespace kurobridge {

// Message → 纯文本：string 分支原样；Translatable 分支经 Server::getLanguage().translate
//（endstone 官方翻译序列化路径，命令输出/死亡消息的 Message 取文本口径）。
std::string messageToPlainText(const endstone::Server& server, const endstone::Message& message);

// core 日志回调与 Node stderr 行中继到 endstone logger（行原样、级别按前缀分流）：
//   core 回调行 [NodeIpc][INFO|WARN|SEVERE] / [NodeSupervisor][INFO|WARN|SEVERE]
//   node stderr 行 [KuroBridge][node][debug|info|warn|error]（core parseNodeLogLevel 口径）
// 其余行保守按 Info（对齐 Java IpcLogLevels 缺省 INFO）；Java SEVERE ≈ endstone Critical。
void relayLogLine(endstone::Logger& logger, const std::string& line);

class Bridge final : public core::NodeIpcListener {
public:
    explicit Bridge(endstone::Plugin& plugin);

    void onReady(long long wsPort, bool autoRestart) override;
    void onBroadcast(const ipc::BroadcastRequest& request, const core::ResultResponder& respond) override;
    void onExecuteCommand(const ipc::ExecuteCommandRequest& request,
                          const core::ResultResponder& respond) override;
    void onStderrLine(const std::string& line) override;
    void onProcessExited(const std::optional<unsigned long>& exitCode, const std::string& cause) override;

private:
    // execute_command 的主线程任务体（runTask 回调内调用）：收集型 sender 执行 + 执行完回执。
    void executeOnMainThread(const std::string& command, const core::ResultResponder& respond);

    endstone::Plugin& plugin_;
};

}  // namespace kurobridge
