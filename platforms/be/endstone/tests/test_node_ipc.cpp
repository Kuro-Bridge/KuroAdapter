// kurobridge_core / NodeIpc 真实 node.exe 集成测试。
// 前置：PATH 上的 node.exe（SearchPathW 定位；找不到则整面跳过并正常返回 0）。
// 被测面：spawn → ready 握手 → execute_command round-trip → 坏行容错 → stderr 中继 →
// 双关机路径 → PID 文件（写/删/残留提示）。总时长控制 <20s（ctest TIMEOUT 60 兜底）。

#include "test_util.h"

#include <windows.h>

#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <system_error>
#include <utility>
#include <vector>

#include "core/node_ipc.h"

using namespace std::string_literals;
using kurobridge::core::NodeIpc;
using kurobridge::core::NodeIpcListener;
using kurobridge::core::RequestOutcome;
using kurobridge::core::StartOutcome;

namespace {

// ---- 定位与临时目录 ----

std::optional<std::filesystem::path> locateNode() {
    wchar_t buffer[32768];
    LPWSTR filePart = nullptr;
    const DWORD size = SearchPathW(nullptr, L"node.exe", nullptr, 32768, buffer, &filePart);
    if (size == 0 || size >= 32768) {
        return std::nullopt;
    }
    return std::filesystem::path(std::wstring(buffer, size));
}

std::filesystem::path fixtureBundle() {
    return std::filesystem::path(KUROBRIDGE_TEST_FIXTURE_DIR) / "stub_node.mjs";
}

std::filesystem::path makeTempDir(const std::string& name) {
    char base[MAX_PATH] = {};
    GetTempPathA(MAX_PATH, base);
    const std::filesystem::path dir = std::filesystem::path(base) / "kurobridge_ipc_test"
                                      / (std::to_string(GetCurrentProcessId()) + "_" + name);
    std::filesystem::create_directories(dir);
    return dir;
}

std::string readFileOr(const std::filesystem::path& file, const std::string& fallback) {
    std::ifstream in(file, std::ios::binary);
    if (!in.is_open()) {
        return fallback;
    }
    return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

bool fileExists(const std::filesystem::path& file) {
    std::error_code ec;
    return std::filesystem::exists(file, ec);
}

// ---- 回调收集（读线程并发写，互斥保护）----

struct LogSink {
    mutable std::mutex mutex;
    std::vector<std::string> lines;

    void add(const std::string& line) {
        std::lock_guard<std::mutex> lock(mutex);
        lines.push_back(line);
    }
    bool contains(const std::string& fragment) const {
        std::lock_guard<std::mutex> lock(mutex);
        for (const std::string& line : lines) {
            if (line.find(fragment) != std::string::npos) {
                return true;
            }
        }
        return false;
    }
};

struct RecordingListener final : NodeIpcListener {
    mutable std::mutex mutex;
    std::condition_variable readyCv;
    std::condition_variable exitCv;
    std::condition_variable stderrCv;
    bool readySeen = false;
    long long wsPort = 0;
    bool autoRestart = false;
    std::vector<std::pair<std::optional<unsigned long>, std::string>> exitCalls;
    std::vector<std::string> stderrLines;

    void onReady(long long port, bool value) override {
        std::lock_guard<std::mutex> lock(mutex);
        readySeen = true;
        wsPort = port;
        autoRestart = value;
        readyCv.notify_all();
    }
    void onStderrLine(const std::string& line) override {
        std::lock_guard<std::mutex> lock(mutex);
        stderrLines.push_back(line);
        stderrCv.notify_all();
    }
    void onProcessExited(const std::optional<unsigned long>& exitCode, const std::string& cause) override {
        std::lock_guard<std::mutex> lock(mutex);
        exitCalls.emplace_back(exitCode, cause);
        exitCv.notify_all();
    }

    bool waitForReady(int seconds) {
        std::unique_lock<std::mutex> lock(mutex);
        return readyCv.wait_for(lock, std::chrono::seconds(seconds), [this] { return readySeen; });
    }
    bool waitForExit(int seconds) {
        std::unique_lock<std::mutex> lock(mutex);
        return exitCv.wait_for(lock, std::chrono::seconds(seconds), [this] { return !exitCalls.empty(); });
    }
    bool waitStderrContains(const std::string& fragment, int seconds) {
        std::unique_lock<std::mutex> lock(mutex);
        const bool ok = stderrCv.wait_for(lock, std::chrono::seconds(seconds), [&] {
            for (const std::string& line : stderrLines) {
                if (line.find(fragment) != std::string::npos) {
                    return true;
                }
            }
            return false;
        });
        return ok;
    }
};

// 每用例独立基座（不可拷贝/移动：NodeIpc 持 listener 引用，须原地存活）
struct Env {
    std::filesystem::path dir;
    std::filesystem::path pidFile;
    LogSink logs;
    RecordingListener listener;
    std::unique_ptr<NodeIpc> ipc;
};

void setUpEnv(Env& env, const std::filesystem::path& nodePath, const std::string& name) {
    env.dir = makeTempDir(name);
    env.pidFile = env.dir / "plugins" / "kurobridge" / "node.pid";
    env.ipc = std::make_unique<NodeIpc>(nodePath.string(), fixtureBundle().string(), env.listener,
                                        [&env](const std::string& line) { env.logs.add(line); });
    env.ipc->setPidFile(env.pidFile);
    env.ipc->setWorkingDirectory(env.dir);
}

// ---- 用例 1：spawn → ready 握手 → PID 写入 → 坏行 WARN → stderr 中继 → 优雅关停删 PID ----
void testReadyHandshakePidFileAndGracefulShutdown(const std::filesystem::path& nodePath) {
    Env env;
    setUpEnv(env, nodePath, "ready");

    const StartOutcome outcome = env.ipc->start();
    CHECK(outcome.ok);                                            // ready 握手成功
    CHECK_EQ(outcome.wsPort, 1);                                  // stub 固定 wsPort=1
    CHECK(env.listener.waitForReady(10));
    CHECK_EQ(env.listener.wsPort, 1);
    CHECK(env.listener.autoRestart);                              // stub 上报 autoRestart=true
    CHECK(env.logs.contains("[NodeIpc][INFO] Node 进程已拉起：["));
    CHECK(env.logs.contains("[NodeIpc][INFO] Node ready：wsPort=1，autoRestart=true"));
    // 坏行跳过（stub 先吐一行 not-json 再 ready），通道不断
    CHECK(env.logs.contains("[NodeIpc][WARN] 跳过无法解析/未知的 IPC 行：not-json"));
    // stderr 按行中继（行格式契约 [KuroBridge][node][info]）
    CHECK(env.listener.waitStderrContains("[KuroBridge][node][info] stub ready", 10));
    // spawn 成功写 `<pid>\n`
    CHECK_EQ(readFileOr(env.pidFile, "<missing>"), std::to_string(env.ipc->pid()) + "\n");

    env.ipc->shutdown("integration-stop");
    const std::optional<unsigned long> exitCode = env.ipc->childExitCode();
    CHECK(exitCode.has_value());
    if (exitCode.has_value()) {
        CHECK_EQ(*exitCode, 0ul);                                 // shutdown 帧 → stub 退出 0
    }
    CHECK(!fileExists(env.pidFile));                              // 优雅路径删 PID 文件
    CHECK(env.listener.exitCalls.empty());                        // 优雅关停不发 onProcessExited
    CHECK(env.logs.contains("[NodeIpc][INFO] Node IPC 已关闭：integration-stop"));
}

// ---- 用例 2：round-trip execute_command ----
void testExecuteCommandRoundTrip(const std::filesystem::path& nodePath) {
    Env env;
    setUpEnv(env, nodePath, "roundtrip");

    const StartOutcome start = env.ipc->start();
    CHECK(start.ok);
    const RequestOutcome outcome = env.ipc->executeCommand("ping");
    CHECK(outcome.ok);                                            // 请求-响应 UUID 关联成功
    CHECK_EQ(outcome.output.size(), std::size_t{1});
    if (outcome.output.size() == 1) {
        CHECK_EQ(outcome.output[0], "pong"s);
    }

    env.ipc->shutdown("done");
}

// ---- 用例 3：父进程环境继承（stub 在 execute_command 结果里回带 KUROBRIDGE_TEST_MARK）----
void testEnvironmentInheritedByChild(const std::filesystem::path& nodePath) {
    SetEnvironmentVariableA("KUROBRIDGE_TEST_MARK", "mark-42");
    Env env;
    setUpEnv(env, nodePath, "envmark");

    const StartOutcome start = env.ipc->start();
    CHECK(start.ok);
    const RequestOutcome outcome = env.ipc->executeCommand("ping");
    CHECK(outcome.ok);
    CHECK_EQ(outcome.output.size(), std::size_t{2});  // ["pong", "mark-42"]
    if (outcome.output.size() == 2) {
        CHECK_EQ(outcome.output[0], "pong"s);
        CHECK_EQ(outcome.output[1], "mark-42"s);
    }
    SetEnvironmentVariableA("KUROBRIDGE_TEST_MARK", nullptr);  // 清理（防跨用例泄漏）

    env.ipc->shutdown("done");
}

// ---- 用例 4：stdin EOF → 非优雅 onProcessExited 恰好一次（exit=0 / cause=stdout EOF）----
void testStdinEofNotifiesExitExactlyOnce(const std::filesystem::path& nodePath) {
    Env env;
    setUpEnv(env, nodePath, "eof");

    const StartOutcome start = env.ipc->start();
    CHECK(start.ok);

    env.ipc->closeStdinForTest();  // 父端关 stdin 写柄 → stub stdin EOF 自杀（退出 0）→ stdout EOF
    CHECK(env.listener.waitForExit(10));
    CHECK_EQ(env.listener.exitCalls.size(), std::size_t{1});
    if (!env.listener.exitCalls.empty()) {
        CHECK(env.listener.exitCalls[0].first.has_value());
        if (env.listener.exitCalls[0].first.has_value()) {
            CHECK_EQ(*env.listener.exitCalls[0].first, 0ul);
        }
        CHECK_EQ(env.listener.exitCalls[0].second, "stdout EOF"s);
    }
    // 异常退出不删 PID 文件（残留即「上次可能异常退出」的证据）
    CHECK(fileExists(env.pidFile));
    CHECK_EQ(readFileOr(env.pidFile, "<missing>"), std::to_string(env.ipc->pid()) + "\n");

    env.ipc->shutdown("after crash");  // 通道终结幂等：不重复通知
    CHECK_EQ(env.listener.exitCalls.size(), std::size_t{1});
    CHECK(!fileExists(env.pidFile));  // 事后优雅关停仍删 PID（对齐 Java shutdown 无条件删除）
    CHECK(env.logs.contains("[NodeIpc][INFO] Node IPC 已关闭：after crash"));
}

// ---- 用例 5：残留 PID 文件 → spawn 前 WARN 提示，新 PID 覆盖 ----
void testPidResidueHintedAndOverwritten(const std::filesystem::path& nodePath) {
    Env env;
    setUpEnv(env, nodePath, "residue");
    std::filesystem::create_directories(env.pidFile.parent_path());
    {
        std::ofstream residue(env.pidFile, std::ios::binary | std::ios::trunc);
        residue << "999\n";
    }

    const StartOutcome start = env.ipc->start();
    CHECK(start.ok);
    CHECK(env.logs.contains("[NodeIpc][WARN] 发现残留 PID 文件（上次可能异常退出）"));
    CHECK_EQ(readFileOr(env.pidFile, "<missing>"), std::to_string(env.ipc->pid()) + "\n");  // 残留被覆盖

    env.ipc->shutdown("done");
    CHECK(!fileExists(env.pidFile));
}

}  // namespace

int main() {
    const std::optional<std::filesystem::path> nodePath = locateNode();
    if (!nodePath.has_value()) {
        // node.exe 不在 PATH：集成面按口径整面跳过并正常返回（ctest 仍绿）
        std::fprintf(stderr, "[test_node_ipc] PATH 上无 node.exe，真实 node 集成面跳过\n");
        CHECK(true);
        return finish_test("test_node_ipc");
    }
    testReadyHandshakePidFileAndGracefulShutdown(*nodePath);
    testExecuteCommandRoundTrip(*nodePath);
    testEnvironmentInheritedByChild(*nodePath);
    testStdinEofNotifiesExitExactlyOnce(*nodePath);
    testPidResidueHintedAndOverwritten(*nodePath);
    return finish_test("test_node_ipc");
}
