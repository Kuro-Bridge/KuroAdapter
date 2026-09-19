// kurobridge_core / NodeSupervisor 行为测试 —— 对齐 Java NodeSupervisorTest 六用例语义。
// 假通道（ManagedIpc 假件）+ 手动延迟执行器 + 注入时钟，全同步、零真实进程、零等待。

#include "test_util.h"

#include <algorithm>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "core/node_supervisor.h"

using namespace std::string_literals;
using kurobridge::core::ManagedIpc;
using kurobridge::core::NodeIpcListener;
using kurobridge::core::NodeSupervisor;
using kurobridge::core::ResultResponder;
using kurobridge::core::StartOutcome;

namespace {

bool hasLog(const std::vector<std::string>& logs, const std::string& fragment) {
    for (const std::string& line : logs) {
        if (line.find(fragment) != std::string::npos) {
            return true;
        }
    }
    return false;
}

// 记录回调的用户 listener（直通断言面）
struct RecordingListener final : NodeIpcListener {
    std::vector<std::pair<long long, bool>> readyCalls;
    std::vector<std::pair<std::optional<unsigned long>, std::string>> exitCalls;

    void onReady(long long wsPort, bool autoRestart) override {
        readyCalls.emplace_back(wsPort, autoRestart);
    }
    void onProcessExited(const std::optional<unsigned long>& exitCode, const std::string& cause) override {
        exitCalls.emplace_back(exitCode, cause);
    }
};

// 假通道：start 返回预置结果；crash() 经观察者通知模拟 ready 后异常退出（与真实路径同缝）
struct FakeIpc final : ManagedIpc {
    NodeIpcListener* observed = nullptr;
    StartOutcome next{true, 0, ""};
    int startCalls = 0;
    std::vector<std::string> shutdownReasons;

    StartOutcome start() override {
        ++startCalls;
        return next;
    }
    void shutdown(const std::string& reason) override { shutdownReasons.push_back(reason); }
    void crash(unsigned long exitCode, const std::string& cause) {
        observed->onProcessExited(exitCode, cause);
    }
};

// 手动延迟执行器：记录退避值与任务，fireAll 手动触发（含取消后晚到的防御路径）。
// 到点触发即摘除对应退避值（对齐 Java 测试里 delays.poll 的消费语义）；取消句柄
// 摘除退避值但保留任务（模拟「取消后仍晚到」的防御路径）。
struct ManualDelays {
    std::vector<std::int64_t> delays;
    std::vector<std::pair<std::int64_t, std::function<void()>>> tasks;

    void eraseOneDelay(std::int64_t delayMs) {
        const auto it = std::find(delays.begin(), delays.end(), delayMs);
        if (it != delays.end()) {
            delays.erase(it);
        }
    }

    NodeSupervisor::DelayExecutor executor() {
        return [this](std::int64_t delayMs, std::function<void()> task) -> NodeSupervisor::CancelToken {
            delays.push_back(delayMs);
            tasks.emplace_back(delayMs, std::move(task));
            return [this, delayMs] { eraseOneDelay(delayMs); };
        };
    }
    void fireAll() {
        const std::vector<std::pair<std::int64_t, std::function<void()>>> snapshot = tasks;
        tasks.clear();
        for (const auto& [delayMs, task] : snapshot) {
            eraseOneDelay(delayMs);  // 先摘挂起退避值再执行，新调度不受影响
            task();
        }
    }
};

bool delaysAre(const ManualDelays& delays, std::int64_t expected) {
    return delays.delays.size() == 1 && delays.delays[0] == expected;
}

bool reasonIs(const FakeIpc& fake, const std::string& expected) {
    return fake.shutdownReasons.size() == 1 && fake.shutdownReasons[0] == expected;
}

// 测试基座。supervisor 须晚于被捕获成员析构（回调经观察者回写 logs/user）。
struct Harness {
    std::vector<std::string> logs;
    std::vector<FakeIpc*> created;
    ManualDelays delays;
    std::int64_t clockNow = 0;
    RecordingListener user;

    NodeSupervisor::IpcFactory factory() {
        return [this](NodeIpcListener& observed) -> std::unique_ptr<ManagedIpc> {
            auto fake = std::make_unique<FakeIpc>();
            fake->observed = &observed;
            fake->next = StartOutcome{true, 49000 + static_cast<long long>(created.size()) + 1, ""};
            created.push_back(fake.get());
            return fake;
        };
    }
    NodeSupervisor::Options options(bool autoRestart, std::int64_t windowMs, int maxFailures) {
        NodeSupervisor::Options option;
        option.autoRestart = autoRestart;
        option.backoffDelaysMs = {10, 20, 30};
        option.failureWindowMs = windowMs;
        option.maxFailuresInWindow = maxFailures;
        option.clock = [this] { return clockNow; };
        return option;
    }
    // make_unique 原地构造（NodeSupervisor 不可移动：观察者回指自身）
    std::unique_ptr<NodeSupervisor> makeSupervisor(bool autoRestart, std::int64_t windowMs,
                                                   int maxFailures) {
        return std::make_unique<NodeSupervisor>(
            factory(), user, [this](const std::string& line) { logs.push_back(line); },
            delays.executor(), options(autoRestart, windowMs, maxFailures));
    }
};

// ---- 用例 1（对齐 crashTriggersBackoffRestartAndRecoveryResetsCounter）----
// crash → 退避重启 → 恢复（ready 成功）清连败计数
void testCrashTriggersBackoffRestartAndRecoveryResetsCounter() {
    Harness harness;
    const std::unique_ptr<NodeSupervisor> supervisor = harness.makeSupervisor(true, 60000, 3);

    supervisor->start();
    CHECK_EQ(harness.created.size(), std::size_t{1});
    CHECK_EQ(harness.created[0]->startCalls, 1);
    CHECK(hasLog(harness.logs, "Node 进程就绪（wsPort=49001），看护中"));

    harness.created[0]->crash(137, "stdout EOF");
    CHECK_EQ(harness.user.exitCalls.size(), std::size_t{1});  // 退出通知直通用户 listener
    CHECK(hasLog(harness.logs,
                 "Node 进程异常退出（进程退出（exit=137，stdout EOF）），10ms 后自动重启"
                 "（连续第 1 次 / 窗口内第 1 次）"));
    CHECK(delaysAre(harness.delays, 10));  // 第 1 次连续失败 → 退避 10ms

    harness.delays.fireAll();
    CHECK_EQ(harness.created.size(), std::size_t{2});  // 退避到点拉起新实例
    CHECK_EQ(harness.created[1]->startCalls, 1);
    CHECK(hasLog(harness.logs, "Node 进程就绪（wsPort=49002），看护中"));

    harness.created[1]->crash(2, "stdout EOF");
    CHECK(delaysAre(harness.delays, 10));  // 成功后计数归零 → 再次退避 10ms
}

// ---- 用例 2（对齐 threeFailuresInWindowGivesUpWithSevere）----
// 600s 窗内累计 3 次失败 → 放弃终态 + SEVERE（含手动恢复路径文案）
void testThreeFailuresInWindowGivesUpWithSevere() {
    Harness harness;
    const std::unique_ptr<NodeSupervisor> supervisor = harness.makeSupervisor(true, 60000, 3);

    supervisor->start();
    for (int round = 0; round < 3; ++round) {
        FakeIpc* fake = harness.created.back();
        fake->crash(1, "stdout EOF");
        if (round < 2) {
            harness.delays.fireAll();
        }
    }

    CHECK(supervisor->isGivenUp());
    CHECK(hasLog(harness.logs, "[NodeSupervisor][SEVERE] 放弃自动重启"));
    CHECK(hasLog(harness.logs, "60s 窗口内累计失败 3 次（上限 3）"));
    CHECK(hasLog(harness.logs, "手动恢复路径：修复问题后重启服务器，或 /reload confirm 重载插件"));
    // 放弃后不再调度重启
    CHECK(harness.delays.delays.empty());
    CHECK(harness.delays.tasks.empty());
    const std::size_t callsBefore = harness.created.size();
    harness.delays.fireAll();  // 残留晚到任务 → spawnAttempt 的 givenUp 检查兜底
    CHECK_EQ(harness.created.size(), callsBefore);  // 放弃后不再拉起新实例
}

// ---- 用例 3（对齐 failuresOutsideWindowDoNotAccumulate）----
// 窗外失败不累计：时钟滑出窗口后旧失败出队，不放弃、仍按退避调度
void testFailuresOutsideWindowDoNotAccumulate() {
    Harness harness;  // clockNow = 0
    const std::unique_ptr<NodeSupervisor> supervisor = harness.makeSupervisor(true, 1000, 3);

    supervisor->start();
    for (int round = 0; round < 2; ++round) {
        harness.created.back()->crash(1, "stdout EOF");
        harness.delays.fireAll();
    }

    harness.clockNow = 10000;  // 时钟滑出窗口后第 3 次失败：旧失败出窗
    harness.created.back()->crash(1, "stdout EOF");

    CHECK(!supervisor->isGivenUp());  // 窗口外的失败不累计
    CHECK(delaysAre(harness.delays, 10));  // 滑窗后仍按退避调度重启（连败计数已被成功清零）
}

// ---- 用例 4（对齐 autoRestartFalseSkipsRestart）----
// autoRestart=false 不重启（不调度、不放弃）
void testAutoRestartFalseSkipsRestart() {
    Harness harness;
    const std::unique_ptr<NodeSupervisor> supervisor = harness.makeSupervisor(false, 60000, 3);

    supervisor->start();
    harness.created[0]->crash(5, "stdout EOF");

    CHECK(hasLog(harness.logs, "[NodeSupervisor][WARN] Node 进程退出且 autoRestart=false，不重启"));
    CHECK(harness.delays.delays.empty());  // 不调度重启
    CHECK(!supervisor->isGivenUp());
}

// ---- 用例 5（对齐 stopPreventsLateRestartTaskFromSpawning）----
// stop 后迟到的重启任务作废
void testStopPreventsLateRestartTaskFromSpawning() {
    Harness harness;
    const std::unique_ptr<NodeSupervisor> supervisor = harness.makeSupervisor(true, 60000, 3);

    supervisor->start();
    harness.created[0]->crash(1, "stdout EOF");
    CHECK(delaysAre(harness.delays, 10));

    supervisor->stop("plugin disable");
    CHECK(hasLog(harness.logs, "[NodeSupervisor][INFO] 看护已停止：plugin disable"));
    CHECK(reasonIs(*harness.created[0], "plugin disable"));  // 优雅关停当前实例
    CHECK(harness.delays.delays.empty());  // 取消句柄已摘除退避值
    const std::size_t callsBefore = harness.created.size();
    harness.delays.fireAll();  // 模拟取消后仍晚到的任务：spawnAttempt 的 stopped 检查兜底
    CHECK_EQ(harness.created.size(), callsBefore);  // 停止看护后不得再拉起实例
}

// ---- 用例 6（对齐 backoffDelayMsCoversTiersAndCap）----
// 退避档位与封顶（纯函数直断）
void testBackoffDelayMsCoversTiersAndCap() {
    const std::vector<std::int64_t> tiers{1000, 5000, 15000};
    CHECK_EQ(NodeSupervisor::backoffDelayMs(1, tiers), std::int64_t{1000});
    CHECK_EQ(NodeSupervisor::backoffDelayMs(2, tiers), std::int64_t{5000});
    CHECK_EQ(NodeSupervisor::backoffDelayMs(3, tiers), std::int64_t{15000});
    CHECK_EQ(NodeSupervisor::backoffDelayMs(9, tiers), std::int64_t{15000});  // 越界取末档封顶
    CHECK_EQ(NodeSupervisor::backoffDelayMs(0, tiers), std::int64_t{1000});   // 非法输入按首档兜底
}

}  // namespace

int main() {
    testCrashTriggersBackoffRestartAndRecoveryResetsCounter();
    testThreeFailuresInWindowGivesUpWithSevere();
    testFailuresOutsideWindowDoNotAccumulate();
    testAutoRestartFalseSkipsRestart();
    testStopPreventsLateRestartTaskFromSpawning();
    testBackoffDelayMsCoversTiersAndCap();
    return finish_test("test_supervisor");
}
