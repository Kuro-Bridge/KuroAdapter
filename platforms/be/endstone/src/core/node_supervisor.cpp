// kurobridge_core / NodeSupervisor 实现。语义对照物 = NodeSupervisor.java（含其 6 个测试基线）。

#include "core/node_supervisor.h"

#include <algorithm>
#include <utility>

namespace kurobridge::core {

std::int64_t NodeSupervisor::defaultClock() {
    // System.currentTimeMillis 等价（毫秒墙钟；仅用于滑窗记账的相对时效）
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

NodeSupervisor::Options NodeSupervisor::defaults() {
    return Options{};
}

NodeSupervisor::DelayExecutor NodeSupervisor::threadDelayExecutor() {
    return [](std::int64_t delayMs, std::function<void()> task) -> CancelToken {
        auto cancelled = std::make_shared<std::atomic<bool>>(false);
        std::thread([cancelled, delayMs, task = std::move(task)] {
            std::this_thread::sleep_for(std::chrono::milliseconds(delayMs));
            if (!cancelled->load()) {
                task();
            }
        }).detach();
        return [cancelled] { cancelled->store(true); };
    };
}

NodeSupervisor::NodeSupervisor(IpcFactory factory, NodeIpcListener& userListener, LogFn log,
                               DelayExecutor delayExecutor, Options options)
    : factory_(std::move(factory)),
      userListener_(userListener),
      log_(std::move(log)),
      delayExecutor_(std::move(delayExecutor)),
      options_(std::move(options)) {
    autoRestart_.store(options_.autoRestart);
}

NodeSupervisor::~NodeSupervisor() {
    stop("NodeSupervisor 析构");
}

void NodeSupervisor::stop(const std::string& reason) {
    stopped_.store(true);
    CancelToken cancel;
    {
        std::lock_guard<std::mutex> lock(windowMutex_);
        cancel = pendingRestartCancel_;
        pendingRestartCancel_ = nullptr;
    }
    if (cancel) {
        cancel();
    }
    if (ManagedIpc* current = currentIpc(); current != nullptr) {
        current->shutdown(reason);
    }
    logInfo("看护已停止：" + reason);
}

ManagedIpc* NodeSupervisor::currentIpc() {
    std::lock_guard<std::mutex> lock(currentMutex_);
    return current_.get();
}

std::int64_t NodeSupervisor::backoffDelayMs(int consecutiveFailures,
                                            const std::vector<std::int64_t>& backoffDelaysMs) {
    if (backoffDelaysMs.empty()) {
        return 0;  // 档位表契约非空；防御兜底
    }
    const int index = std::max(0, std::min(consecutiveFailures - 1,
                                           static_cast<int>(backoffDelaysMs.size()) - 1));
    return backoffDelaysMs[static_cast<std::size_t>(index)];
}

void NodeSupervisor::spawnAttempt() {
    if (stopped_.load() || givenUp_.load()) {
        return;  // 终态检查：stop 后迟到的重启任务在此作废（对齐 Java spawnAttempt 首行）
    }
    attemptActive_.store(true);
    std::unique_ptr<ManagedIpc> created = factory_(observed_);
    ManagedIpc* ipc = nullptr;
    {
        std::lock_guard<std::mutex> lock(currentMutex_);
        current_ = std::move(created);  // 替换即回收旧实例（NodeIpc 一次性设计）
        ipc = current_.get();
    }
    const StartOutcome outcome = ipc->start();
    if (outcome.ok) {
        consecutiveFailures_.store(0);  // ready 成功清连败计数（不清窗口）
        logInfo("Node 进程就绪（wsPort=" + std::to_string(outcome.wsPort) + "），看护中");
        return;
    }
    handleAttemptFailure("启动失败（" + outcome.error + "）");
}

void NodeSupervisor::handleAttemptFailure(const std::string& cause) {
    if (stopped_.load() || givenUp_.load()) {
        return;
    }
    bool expected = true;
    if (!attemptActive_.compare_exchange_strong(expected, false)) {
        return;  // 同一次尝试的失败已记账（start 失败与退出通知只取其一）
    }
    const int consecutive = consecutiveFailures_.fetch_add(1) + 1;
    const std::int64_t now = options_.clock();
    int windowCount = 0;
    {
        std::lock_guard<std::mutex> lock(windowMutex_);
        pruneWindowLocked(now);
        failureTimestamps_.push_back(now);
        windowCount = static_cast<int>(failureTimestamps_.size());
    }
    if (windowCount >= options_.maxFailuresInWindow) {
        givenUp_.store(true);
        // 文案对齐 Java（windowMs/1000 的整数除法口径在内）
        logSevere("放弃自动重启：" + std::to_string(options_.failureWindowMs / 1000) + "s 窗口内累计失败 "
                  + std::to_string(windowCount) + " 次（上限 " + std::to_string(options_.maxFailuresInWindow)
                  + "）——" + cause);
        logSevere("手动恢复路径：修复问题后重启服务器，或 /reload confirm 重载插件");
        return;
    }
    if (!autoRestart_.load()) {
        logWarn("Node 进程退出且 autoRestart=false，不重启：" + cause);
        return;
    }
    const std::int64_t delay = backoffDelayMs(consecutive, options_.backoffDelaysMs);
    logWarn("Node 进程异常退出（" + cause + "），" + std::to_string(delay) + "ms 后自动重启（连续第 "
            + std::to_string(consecutive) + " 次 / 窗口内第 " + std::to_string(windowCount) + " 次）");
    const CancelToken cancel = delayExecutor_(delay, [this] { spawnAttempt(); });
    {
        std::lock_guard<std::mutex> lock(windowMutex_);
        pendingRestartCancel_ = cancel;
    }
}

void NodeSupervisor::pruneWindowLocked(std::int64_t now) {
    // 滑出窗口的旧失败时间戳出队（ArrayDeque prune 语义：peekFirst < now - window 即删）
    const std::int64_t windowStart = now - options_.failureWindowMs;
    while (!failureTimestamps_.empty() && failureTimestamps_.front() < windowStart) {
        failureTimestamps_.pop_front();
    }
}

std::string NodeSupervisor::describeExit(const std::optional<unsigned long>& exitCode,
                                         const std::string& cause) {
    return "进程退出（exit=" + (exitCode.has_value() ? std::to_string(*exitCode) : "未知") + "，" + cause
           + "）";
}

void NodeSupervisor::logInfo(const std::string& message) {
    log_("[NodeSupervisor][INFO] " + message);
}

void NodeSupervisor::logWarn(const std::string& message) {
    log_("[NodeSupervisor][WARN] " + message);
}

void NodeSupervisor::logSevere(const std::string& message) {
    log_("[NodeSupervisor][SEVERE] " + message);
}

}  // namespace kurobridge::core
