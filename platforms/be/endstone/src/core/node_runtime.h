// kurobridge_core / Node 运行时顶层组装 —— 路径解析 + 通道工厂 + 看护器组合。
// 不碰 src/main.cpp；endstone 桥接层（后续块）经本类型接入。
//
// start 流程：解析 node/bundle 路径（env KUROBRIDGE_NODE / KUROBRIDGE_BUNDLE 优先，
// 缺省 <cwd>/plugins/kurobridge/bin/node.exe + index.mjs）→ bin 缺失 → 错误返回
// （降级不崩，日志由上层决定）→ PID 残留检查 → spawn → 等 ready（30s）→ ready 成功
// 经观察者回填 autoRestart 实测值（业务配置 SSOT 在 Node 侧，本层只搬运）。

#pragma once

#include <filesystem>
#include <memory>
#include <string>

#include "core/node_ipc.h"
#include "core/node_supervisor.h"

namespace kurobridge::core {

// 解析产物（路径已保证存在且为常规文件；ok=false 时 error 为中文原因）
struct NodeRuntimeResolution {
    bool ok = false;
    std::filesystem::path nodeExecutable;
    std::filesystem::path bundlePath;
    std::string error;
};

// 解析 node/bundle 路径。env 优先（经 Win32 进程环境读取——与子进程环境块同源；CRT getenv
// 与进程环境可能脱节，故不用）；缺省 = std::filesystem 拼接 <cwd>/plugins/kurobridge/bin/。
NodeRuntimeResolution resolveNodeRuntimePaths(const std::filesystem::path& cwd);

class NodeRuntime final : public NodeIpcListener {
public:
    // cwd = BDS 根（生产由宿主传入）：bin/PID 文件的定位基准 + 子进程工作目录。
    NodeRuntime(NodeIpcListener& userListener, NodeSupervisor::LogFn log, std::filesystem::path cwd);
    ~NodeRuntime() override = default;
    NodeRuntime(const NodeRuntime&) = delete;
    NodeRuntime& operator=(const NodeRuntime&) = delete;

    // bin 缺失 → 返回 false 并经 error 出参带原因（降级不崩，日志由上层决定）；
    // 否则进入看护（首次拉起同步阻塞至 ready / 失败，见 node_ipc.h 头注的同步化取舍）。
    bool start(std::string* error = nullptr);
    void stop(const std::string& reason) { supervisor_.stop(reason); }
    NodeSupervisor& supervisor() { return supervisor_; }

    // ---- NodeIpcListener 包装面：直通 + ready 时回填 autoRestart 实测值 ----
    void onReady(long long wsPort, bool autoRestart) override;
    void onBroadcast(const ipc::BroadcastRequest& request, const ResultResponder& respond) override;
    void onExecuteCommand(const ipc::ExecuteCommandRequest& request, const ResultResponder& respond) override;
    void onStderrLine(const std::string& line) override;
    void onProcessExited(const std::optional<unsigned long>& exitCode, const std::string& cause) override;

private:
    std::unique_ptr<ManagedIpc> createIpc(NodeIpcListener& observedListener);

    NodeIpcListener& userListener_;
    NodeSupervisor::LogFn log_;
    std::filesystem::path cwd_;
    NodeSupervisor supervisor_;
    // 解析结果（start 成功后有效；工厂闭包按值消费其内容）
    std::filesystem::path resolvedNode_;
    std::filesystem::path resolvedBundle_;
};

}  // namespace kurobridge::core
