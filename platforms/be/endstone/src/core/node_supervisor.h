// kurobridge_core / Node 进程看护器 —— 对齐 NodeSupervisor.java（DEBT-2）。
//
// 状态机：running → restarting → running → …；终态两个：stopped（stop()，宿主 onDisable
// 停看护 + 优雅关停当前实例）与 given-up（滑动窗内累计失败达上限即放弃，SEVERE 提示
// 手动恢复路径）。失败的两个来源去重后等价处理：start 失败（拉起失败 / ready 前断开 /
// 超时）与 onProcessExited（ready 后异常退出）——每次尝试恰好记账一次（attemptActive CAS：
// spawnAttempt 置位、记账 CAS 归位；start 失败与退出通知只取其一）。ready 成功清连败计数、
// 不清窗口（「累计」而非「连续」）。autoRestart=false 时仅记日志不重启；stop() 后迟到的
// 重启任务由 spawnAttempt 的 stopped 检查作废。
//
// 线程模型：spawnAttempt 在调用线程（首次 start）或延迟执行器线程（重启）上运行；
// handleAttemptFailure 可能发生在读线程（onProcessExited）——共享状态以 atomic / 互斥保护。
// 延迟执行器契约（对齐 Java DelayScheduler）：生产实现不得在调用线程内同步执行 task；
// 返回取消句柄（幂等）。时钟与延迟执行器均可注入（测试同步化，对齐 NodeSupervisorTest）。
//
// 日志回调收整行（已带 `[NodeSupervisor][INFO|WARN|SEVERE] ` 前缀，前缀后一空格，与 Java
// 逐字一致——宿主据前缀分流，SEVERE 即放弃终态提示）。

#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "core/node_ipc.h"

namespace kurobridge::core {

class NodeSupervisor {
public:
    using LogFn = std::function<void(const std::string&)>;
    using CancelToken = std::function<void()>;
    // 延迟执行器：delayMs 后（别的线程）执行 task，返回取消句柄。
    using DelayExecutor = std::function<CancelToken(std::int64_t delayMs, std::function<void()> task)>;
    // 每次重启新建通道实例（参数由宿主闭包固化；listener 参数传看护器包装后的观察者，
    // 对齐 Java NodeSupervisor.NodeIpcFactory）。
    using IpcFactory = std::function<std::unique_ptr<ManagedIpc>(NodeIpcListener& observedListener)>;

    // 看护参数（defaults() 为生产缺省值；测试注入副本缩短窗口/退避，对齐 Java Options record）
    struct Options {
        bool autoRestart = true;  // 自动重启开关初值（ready 上报后可被 setAutoRestart 更新）
        std::vector<std::int64_t> backoffDelaysMs{1000, 5000, 15000};  // 退避档位（越界取末档封顶）
        std::int64_t failureWindowMs = 10 * 60 * 1000;                 // 放弃判定的滑动窗口（600s）
        int maxFailuresInWindow = 3;                                   // 窗口内累计失败达该次数即放弃
        std::function<std::int64_t()> clock = &NodeSupervisor::defaultClock;  // 毫秒时钟（可注入）
    };

    static std::int64_t defaultClock();
    static Options defaults();
    // 生产延迟执行器：独立线程 sleep 到点 → 校验取消标记 → 执行 task（分离线程，靠取消收敛；
    // 满足「不得在调用线程内同步执行」契约——测试注入的手动执行器不受此约束）。
    static DelayExecutor threadDelayExecutor();

    NodeSupervisor(IpcFactory factory, NodeIpcListener& userListener, LogFn log,
                   DelayExecutor delayExecutor, Options options);
    // 兜底 stop（幂等）：取消挂起重启 + 优雅关停当前实例（须在 userListener / 工厂闭包失效前析构）
    ~NodeSupervisor();
    NodeSupervisor(const NodeSupervisor&) = delete;
    NodeSupervisor& operator=(const NodeSupervisor&) = delete;

    // 更新自动重启开关（ready.autoRestart 上报回调；最后一次为准，对齐 Java volatile）
    void setAutoRestart(bool autoRestart) { autoRestart_.store(autoRestart); }

    // 首次拉起并进入看护。重复调用无效果（重启由看护器内部驱动）。注意 v1 收敛：首次拉起
    // 同步阻塞至 ready / 失败（对齐 Java start future 的同步化，见 node_ipc.h 头注）。
    void start() { spawnAttempt(); }

    // 停止看护（幂等）：取消挂起的重启、优雅关停当前实例；放弃终态下调用同样安全。
    void stop(const std::string& reason);

    // 当前看护中的实例；无实例（未 start / 已替换）为 nullptr。不转移所有权。
    ManagedIpc* currentIpc();

    bool isGivenUp() const { return givenUp_.load(); }

    // 退避间隔（纯函数）：第 n 次连续失败取 backoffDelaysMs[n-1]，越界取末档封顶；n < 1 按 1。
    static std::int64_t backoffDelayMs(int consecutiveFailures,
                                       const std::vector<std::int64_t>& backoffDelaysMs);

private:
    void spawnAttempt();
    void handleAttemptFailure(const std::string& cause);
    void pruneWindowLocked(std::int64_t now);  // 须持有 windowMutex_
    void logInfo(const std::string& message);
    void logWarn(const std::string& message);
    void logSevere(const std::string& message);
    static std::string describeExit(const std::optional<unsigned long>& exitCode, const std::string& cause);

    // 观察者：业务回调直通 userListener，退出通知先做看护记账再直通（对齐 Java observedListener）
    struct ObservedListener final : NodeIpcListener {
        explicit ObservedListener(NodeSupervisor* owner) : self(owner) {}
        NodeSupervisor* self = nullptr;
        void onReady(long long wsPort, bool autoRestart) override {
            self->userListener_.onReady(wsPort, autoRestart);
        }
        void onBroadcast(const ipc::BroadcastRequest& request, const ResultResponder& respond) override {
            self->userListener_.onBroadcast(request, respond);
        }
        void onExecuteCommand(const ipc::ExecuteCommandRequest& request,
                              const ResultResponder& respond) override {
            self->userListener_.onExecuteCommand(request, respond);
        }
        void onStderrLine(const std::string& line) override { self->userListener_.onStderrLine(line); }
        void onProcessExited(const std::optional<unsigned long>& exitCode,
                             const std::string& cause) override {
            self->handleAttemptFailure(describeExit(exitCode, cause));
            self->userListener_.onProcessExited(exitCode, cause);
        }
    };

    IpcFactory factory_;
    NodeIpcListener& userListener_;
    LogFn log_;
    DelayExecutor delayExecutor_;
    const Options options_;

    ObservedListener observed_{this};

    std::atomic<bool> stopped_{false};
    std::atomic<bool> givenUp_{false};
    std::atomic<bool> attemptActive_{false};
    std::atomic<int> consecutiveFailures_{0};
    std::atomic<bool> autoRestart_{false};  // 初值在构造函数体取 options.autoRestart（防移动后读）

    // 保护失败时间戳滑动窗（ArrayDeque 语义）与挂起重启取消句柄
    std::mutex windowMutex_;
    std::deque<std::int64_t> failureTimestamps_;
    CancelToken pendingRestartCancel_;

    // 保护 current 实例替换（spawnAttempt 与 currentIpc 可能跨线程）
    std::mutex currentMutex_;
    std::unique_ptr<ManagedIpc> current_;
};

}  // namespace kurobridge::core
