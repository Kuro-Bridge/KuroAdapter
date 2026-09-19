// kurobridge_core / NodeRuntime 测试：路径解析（env 优先 / 缺省拼接 / 缺失降级）、
// Node stderr 级别解析（logger.ts 行格式契约）、顶层组装冒烟（真实 node 全链，PATH 无
// node.exe 则该用例跳过）。

#include "test_util.h"

#include <windows.h>

#include <atomic>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <system_error>
#include <vector>

#include "core/ipc_frame.h"
#include "core/node_ipc.h"
#include "core/node_runtime.h"

using namespace std::string_literals;
using kurobridge::core::NodeIpcListener;
using kurobridge::core::NodeRuntime;
using kurobridge::core::NodeRuntimeResolution;
using kurobridge::core::parseNodeLogLevel;
using kurobridge::core::resolveNodeRuntimePaths;

namespace {

// 环境变量 RAII 清理（进程级 env 跨用例共享，须复位）
struct EnvGuard {
    EnvGuard(const char* name, const char* value) : name_(name) {
        SetEnvironmentVariableA(name, value);
    }
    ~EnvGuard() { SetEnvironmentVariableA(name_, nullptr); }
    EnvGuard(const EnvGuard&) = delete;
    EnvGuard& operator=(const EnvGuard&) = delete;

private:
    const char* name_;
};

std::filesystem::path makeTempDir(const std::string& name) {
    char base[MAX_PATH] = {};
    GetTempPathA(MAX_PATH, base);
    const std::filesystem::path dir = std::filesystem::path(base) / "kurobridge_runtime_test"
                                      / (std::to_string(GetCurrentProcessId()) + "_" + name);
    std::filesystem::create_directories(dir);
    return dir;
}

void touchFile(const std::filesystem::path& file) {
    std::filesystem::create_directories(file.parent_path());
    std::ofstream out(file, std::ios::binary | std::ios::trunc);
    out << "";
}

// ---- 解析：缺省路径 + bin 缺失降级 ----
void testResolveDefaultsMissing() {
    const EnvGuard node("KUROBRIDGE_NODE", nullptr);
    const EnvGuard bundle("KUROBRIDGE_BUNDLE", nullptr);
    const std::filesystem::path cwd = makeTempDir("missing");

    const NodeRuntimeResolution resolution = resolveNodeRuntimePaths(cwd);
    CHECK(!resolution.ok);  // 降级：bin 缺失 → 错误返回（不抛不崩）
    CHECK(resolution.error.find("Node 可执行文件缺失") != std::string::npos);
    CHECK(resolution.error.find((cwd / "plugins" / "kurobridge" / "bin" / "node.exe").string())
          != std::string::npos);  // 缺省拼接口径
}

// ---- 解析：bundle 缺失单独报 ----
void testResolveBundleMissing() {
    const EnvGuard node("KUROBRIDGE_NODE", nullptr);
    const EnvGuard bundle("KUROBRIDGE_BUNDLE", nullptr);
    const std::filesystem::path cwd = makeTempDir("bundle_missing");
    touchFile(cwd / "plugins" / "kurobridge" / "bin" / "node.exe");

    const NodeRuntimeResolution resolution = resolveNodeRuntimePaths(cwd);
    CHECK(!resolution.ok);
    CHECK(resolution.error.find("Node bundle 缺失") != std::string::npos);
    CHECK(resolution.error.find("index.mjs") != std::string::npos);
}

// ---- 解析：bin 齐备 → 缺省路径拼接 ----
void testResolveDefaultsPresent() {
    const EnvGuard node("KUROBRIDGE_NODE", nullptr);
    const EnvGuard bundle("KUROBRIDGE_BUNDLE", nullptr);
    const std::filesystem::path cwd = makeTempDir("present");
    touchFile(cwd / "plugins" / "kurobridge" / "bin" / "node.exe");
    touchFile(cwd / "plugins" / "kurobridge" / "bin" / "index.mjs");

    const NodeRuntimeResolution resolution = resolveNodeRuntimePaths(cwd);
    CHECK(resolution.ok);
    CHECK_EQ(resolution.nodeExecutable, cwd / "plugins" / "kurobridge" / "bin" / "node.exe");
    CHECK_EQ(resolution.bundlePath, cwd / "plugins" / "kurobridge" / "bin" / "index.mjs");
}

// ---- 解析：env 优先（KUROBRIDGE_NODE / KUROBRIDGE_BUNDLE 覆盖缺省）----
void testResolveEnvPriority() {
    const std::filesystem::path cwd = makeTempDir("env_priority");
    touchFile(cwd / "plugins" / "kurobridge" / "bin" / "node.exe");
    touchFile(cwd / "plugins" / "kurobridge" / "bin" / "index.mjs");
    const std::filesystem::path otherNode = makeTempDir("env_priority") / "other-node.exe";
    const std::filesystem::path otherBundle = makeTempDir("env_priority") / "other.mjs";
    touchFile(otherNode);
    touchFile(otherBundle);
    const EnvGuard node("KUROBRIDGE_NODE", otherNode.string().c_str());
    const EnvGuard bundle("KUROBRIDGE_BUNDLE", otherBundle.string().c_str());

    const NodeRuntimeResolution resolution = resolveNodeRuntimePaths(cwd);
    CHECK(resolution.ok);
    CHECK_EQ(resolution.nodeExecutable, otherNode);
    CHECK_EQ(resolution.bundlePath, otherBundle);
}

// ---- 解析：env 空串视同未设置（走缺省）----
void testResolveEmptyEnvFallsBackToDefaults() {
    const EnvGuard node("KUROBRIDGE_NODE", "");
    const EnvGuard bundle("KUROBRIDGE_BUNDLE", nullptr);
    const std::filesystem::path cwd = makeTempDir("empty_env");

    const NodeRuntimeResolution resolution = resolveNodeRuntimePaths(cwd);
    CHECK(!resolution.ok);
    CHECK(resolution.error.find((cwd / "plugins" / "kurobridge" / "bin" / "node.exe").string())
          != std::string::npos);
}

// ---- UUID v4：形状/口径/唯一性（生成器即请求关联的根基，出帧须经 zod 口径校验）----
void testGenerateUuidV4() {
    std::set<std::string> seen;
    for (int i = 0; i < 200; ++i) {
        const std::string id = kurobridge::core::generateUuidV4();
        CHECK_EQ(id.size(), std::size_t{36});
        CHECK(id[8] == '-' && id[13] == '-' && id[18] == '-' && id[23] == '-');
        CHECK(kurobridge::ipc::isValidUuid(id));  // zod 4.4.3 z.uuid() 整体合法
        CHECK_EQ(id[14], '4');                    // 版本位 4
        CHECK(id[19] == '8' || id[19] == '9' || id[19] == 'a' || id[19] == 'b');  // 变体位 89ab
        CHECK(seen.insert(id).second);            // 进程内唯一
    }
}

// ---- Node stderr 级别解析（前缀整段匹配；未知/无前缀 → nullopt 由消费方保守缺省）----
void testParseNodeLogLevel() {
    CHECK(parseNodeLogLevel("[KuroBridge][node][info] stub ready") == std::string_view("info"));
    CHECK(parseNodeLogLevel("[KuroBridge][node][debug] x") == std::string_view("debug"));
    CHECK(parseNodeLogLevel("[KuroBridge][node][warn] x") == std::string_view("warn"));
    CHECK(parseNodeLogLevel("[KuroBridge][node][error] boot fail") == std::string_view("error"));
    CHECK(!parseNodeLogLevel("[KuroBridge][stub][info] dev artifact").has_value());
    CHECK(!parseNodeLogLevel("plain line").has_value());
    CHECK(!parseNodeLogLevel("").has_value());
    // 整段匹配（startsWith）：消息体内同形字样不得误判
    CHECK(!parseNodeLogLevel("body contains [KuroBridge][node][error] mid-line").has_value());
}

// ---- 顶层组装：bin 缺失降级不崩（无 node 依赖）----
void testRuntimeDegradesWhenBinMissing() {
    const EnvGuard node("KUROBRIDGE_NODE", nullptr);
    const EnvGuard bundle("KUROBRIDGE_BUNDLE", nullptr);
    const std::filesystem::path cwd = makeTempDir("degrade");

    struct Listener final : NodeIpcListener {
    } listener;
    NodeRuntime runtime(listener, [](const std::string&) {}, cwd);

    std::string error = "initial";
    CHECK(!runtime.start(&error));  // 降级：错误返回而非崩溃/SEVERE 自打（日志归上层）
    CHECK(error.find("Node 可执行文件缺失") != std::string::npos);
    CHECK(!runtime.start(nullptr));  // error 出参可空
}

// ---- 顶层组装：真实 node 全链冒烟（env 指向真 node + stub；PATH 无 node 则跳过）----
void testFullStackSmoke(const std::filesystem::path& nodePath, const std::filesystem::path& stubPath) {
    const std::filesystem::path cwd = makeTempDir("fullstack");
    const EnvGuard node("KUROBRIDGE_NODE", nodePath.string().c_str());
    const EnvGuard bundle("KUROBRIDGE_BUNDLE", stubPath.string().c_str());

    struct Listener final : NodeIpcListener {
        std::atomic<bool> readySeen{false};
        void onReady(long long, bool) override { readySeen.store(true); }
    } listener;

    struct Sink {
        std::mutex mutex;
        std::vector<std::string> lines;
        void add(const std::string& line) {
            std::lock_guard<std::mutex> lock(mutex);
            lines.push_back(line);
        }
        bool contains(const std::string& fragment) {
            std::lock_guard<std::mutex> lock(mutex);
            for (const std::string& line : lines) {
                if (line.find(fragment) != std::string::npos) {
                    return true;
                }
            }
            return false;
        }
    } sink;

    NodeRuntime runtime(listener, [&sink](const std::string& line) { sink.add(line); }, cwd);

    std::string error = "initial";
    const bool started = runtime.start(&error);
    if (!started) {
        // 诊断输出（ctest 失败时可见）
        std::fprintf(stderr, "[test_node_runtime] runtime.start 失败：%s\n", error.c_str());
    }
    CHECK(started);  // 解析 → PID 检查 → spawn → ready（阻塞）全链
    // ready 成功经观察者回填 autoRestart 实测值（stub 恒 true）
    // 看护器持有当前实例 + 就绪日志（NodeRuntime 观察者包装 + Supervisor 组装生效）
    CHECK(runtime.supervisor().currentIpc() != nullptr);
    CHECK(sink.contains("[NodeSupervisor][INFO] Node 进程就绪（wsPort=1），看护中"));
    CHECK(sink.contains("[NodeIpc][INFO] Node ready：wsPort=1，autoRestart=true"));

    runtime.stop("runtime test");
    CHECK(sink.contains("[NodeIpc][INFO] Node IPC 已关闭：runtime test"));
    CHECK(sink.contains("[NodeSupervisor][INFO] 看护已停止：runtime test"));
}

}  // namespace

int main() {
    testResolveDefaultsMissing();
    testResolveBundleMissing();
    testResolveDefaultsPresent();
    testResolveEnvPriority();
    testResolveEmptyEnvFallsBackToDefaults();
    testParseNodeLogLevel();
    testGenerateUuidV4();
    testRuntimeDegradesWhenBinMissing();

    // 真实 node 全链冒烟（PATH 无 node.exe 则按口径跳过该用例）
    wchar_t nodeBuffer[32768];
    LPWSTR filePart = nullptr;
    const DWORD found = SearchPathW(nullptr, L"node.exe", nullptr, 32768, nodeBuffer, &filePart);
    if (found > 0 && found < 32768) {
        const std::filesystem::path nodePath(std::wstring(nodeBuffer, found));  // 全路径（含文件名）
        testFullStackSmoke(
            nodePath, std::filesystem::path(KUROBRIDGE_TEST_FIXTURE_DIR) / "stub-node.mjs");
    } else {
        std::fprintf(stderr, "[test_node_runtime] PATH 上无 node.exe，全链冒烟跳过\n");
        CHECK(true);
    }
    return finish_test("test_node_runtime");
}
