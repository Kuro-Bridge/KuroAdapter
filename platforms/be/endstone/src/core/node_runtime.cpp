// kurobridge_core / NodeRuntime 实现。见 node_runtime.h 头注。

#include "core/node_runtime.h"

#include <windows.h>

#include <utility>

namespace kurobridge::core {
namespace {

// 读取进程环境变量（UTF-16 → std::filesystem::path 原生宽形）；未设置/空 → 空 path
std::filesystem::path environmentPath(const wchar_t* name) {
    wchar_t buffer[32768];
    const DWORD size = GetEnvironmentVariableW(name, buffer, 32768);
    if (size == 0 || size > 32768) {
        return {};
    }
    return std::filesystem::path(std::wstring(buffer, size));
}

}  // namespace

NodeRuntimeResolution resolveNodeRuntimePaths(const std::filesystem::path& cwd) {
    NodeRuntimeResolution result;
    std::filesystem::path node = environmentPath(L"KUROBRIDGE_NODE");
    if (node.empty()) {
        node = cwd / "plugins" / "kurobridge" / "bin" / "node.exe";
    }
    std::filesystem::path bundle = environmentPath(L"KUROBRIDGE_BUNDLE");
    if (bundle.empty()) {
        bundle = cwd / "plugins" / "kurobridge" / "bin" / "index.mjs";
    }
    std::error_code ec;
    if (!std::filesystem::is_regular_file(node, ec)) {
        result.error = "Node 可执行文件缺失：" + node.string();
        return result;
    }
    if (!std::filesystem::is_regular_file(bundle, ec)) {
        result.error = "Node bundle 缺失：" + bundle.string();
        return result;
    }
    result.ok = true;
    result.nodeExecutable = std::move(node);
    result.bundlePath = std::move(bundle);
    return result;
}

NodeRuntime::NodeRuntime(NodeIpcListener& userListener, NodeSupervisor::LogFn log,
                         std::filesystem::path cwd)
    : userListener_(userListener),
      log_(std::move(log)),
      cwd_(std::move(cwd)),
      // userListener 传 this：ready 回调先回填 autoRestart 实测值再直通（观察者包装见头注）
      supervisor_([this](NodeIpcListener& observedListener) { return createIpc(observedListener); },
                  *this, log_, NodeSupervisor::threadDelayExecutor(), NodeSupervisor::defaults()) {}

bool NodeRuntime::start(std::string* error) {
    const NodeRuntimeResolution resolution = resolveNodeRuntimePaths(cwd_);
    if (!resolution.ok) {
        if (error != nullptr) {
            *error = resolution.error;
        }
        return false;  // 降级不崩：调用方决定日志（生产 SEVERE + 插件保持加载，feasibility R3）
    }
    resolvedNode_ = resolution.nodeExecutable;
    resolvedBundle_ = resolution.bundlePath;
    supervisor_.start();
    return true;
}

void NodeRuntime::onReady(long long wsPort, bool autoRestart) {
    supervisor_.setAutoRestart(autoRestart);  // 成功通知 autoRestart 实测值（Node 侧 SSOT 搬运）
    userListener_.onReady(wsPort, autoRestart);
}

void NodeRuntime::onBroadcast(const ipc::BroadcastRequest& request, const ResultResponder& respond) {
    userListener_.onBroadcast(request, respond);
}

void NodeRuntime::onExecuteCommand(const ipc::ExecuteCommandRequest& request,
                                   const ResultResponder& respond) {
    userListener_.onExecuteCommand(request, respond);
}

void NodeRuntime::onStderrLine(const std::string& line) {
    userListener_.onStderrLine(line);
}

void NodeRuntime::onProcessExited(const std::optional<unsigned long>& exitCode, const std::string& cause) {
    userListener_.onProcessExited(exitCode, cause);
}

std::unique_ptr<ManagedIpc> NodeRuntime::createIpc(NodeIpcListener& observedListener) {
    auto ipc = std::make_unique<NodeIpc>(resolvedNode_.string(), resolvedBundle_.string(),
                                         observedListener, log_);
    ipc->setPidFile(cwd_ / "plugins" / "kurobridge" / "node.pid");  // DEBT-2 进程卫生，BDS 根相对
    ipc->setWorkingDirectory(cwd_);  // Node 侧据此定位 plugins/kurobridge/config.json
    return ipc;
}

}  // namespace kurobridge::core
