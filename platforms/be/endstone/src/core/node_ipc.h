// kurobridge_core / Node 子进程 stdin/stdout JSON-lines IPC 通道 —— 对齐 NodeIpc.java。
// 帧编解码复用 core/ipc_frame（本层职责 = 「字节 ↔ 行」与「行 ↔ 帧」之间的传输面）。
//
// 回调线程语义（契约，对齐 Java 虚拟线程模型）：NodeIpcListener 的全部回调
// （onReady / onBroadcast / onExecuteCommand / onStderrLine / onProcessExited）与 log 回调
// 一律在 NodeIpc 内部的读线程（stdout / stderr 各一）上执行；ResultResponder 可能被回调
// 实现留存后跨线程调用（须自身可拷贝、线程安全）。回调/日志实现不得抛异常：NodeIpc 以
// try/catch(...) 兜底记 WARN（对齐 Java notifyListener）；回调内不得反向调用本实例的
// 阻塞 API，更不得在本实例读线程回调内析构本实例（析构会 join 读线程）。
//
// 阻塞面（对齐 Java CompletableFuture 的同步化收敛，v1 取舍）：start() 阻塞至
// ready / 失败 / 超时（默认 30s）；broadcast / executeCommand 阻塞至响应 / 10s 超时 /
// 通道断开。双关机路径与 PID 文件语义与 Java 逐条对齐，见各方法头注。

#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "core/ipc_frame.h"
#include "core/process_factory.h"

namespace kurobridge::core {

// Node stderr 行的级别解析（bridge/embedded/src/logger.ts 行格式契约：
// `[KuroBridge][node][debug|info|warn|error] message`；前缀须整段匹配——行首 startsWith，
// 消息体内出现同形字样不得误判，对齐 IpcLogLevels 的防御口径）。
// 匹配返回级别片段（debug/info/warn/error）；其余（未知前缀/无前缀/空行）→ nullopt，
// 消费方按保守缺省处理不丢行（Java 侧映射 INFO 的口径）。
std::optional<std::string_view> parseNodeLogLevel(std::string_view line);

// UUID v4 生成器（对齐 Java UUID.randomUUID 的出帧面）：小写带连字符；版本位 4、
// 变体位 89ab（zod 4.4.3 z.uuid() 口径，见 ipc_frame.h isValidUuid 注）。熵源 =
// std::random_device 混合 steady_clock 与调用计数——防部分 MinGW 家族 random_device
// 退化为确定性序列时仍保持进程内唯一。
std::string generateUuidV4();

// Node → C++ 请求的应答器（Java IpcResult 同位）。CAS 保证恰好一次应答；error 空白兜底
// "unspecified"（对齐 NodeIpc.respond）。可拷贝（内部 shared 状态），可在回调返回后调用。
using ResultResponder = std::function<void(bool ok, std::string error, std::vector<std::string> output)>;

// 请求-响应结果（Java CompletableFuture + IpcException 消息的同步形态）：ok=false 时
// error 为中文原因（文案对齐 Java 异常 message）。
struct RequestOutcome {
    bool ok = false;
    std::vector<std::string> output;  // ok=true 有效；未携带 output 归一空列表（对齐 Java）
    std::string error;
};

// start() 结果（Java start future 的同步形态）：ok=false 时 error 为中文原因
//（拉起失败 / ready 前断开 / 等待 ready 超时——Java 的 IpcException / TimeoutException 两族）。
struct StartOutcome {
    bool ok = false;
    long long wsPort = 0;
    std::string error;
};

// NodeIpc 回调观察者（Java NodeIpcListener 同位）。缺省空实现；全部在读线程上执行（见文件头）。
struct NodeIpcListener {
    virtual ~NodeIpcListener() = default;
    virtual void onReady(long long wsPort, bool autoRestart) {}
    virtual void onBroadcast(const ipc::BroadcastRequest& request, const ResultResponder& respond) {}
    virtual void onExecuteCommand(const ipc::ExecuteCommandRequest& request, const ResultResponder& respond) {}
    virtual void onStderrLine(const std::string& line) {}
    // 仅非优雅路径（stdout EOF / stdin 写失败 / ready 前强杀）恰好一次；优雅关停不通知
    //（对齐 NodeIpc.tearDownChannel）。exitCode 可能为空（进程刚被强杀未回收时）。
    virtual void onProcessExited(const std::optional<unsigned long>& exitCode, const std::string& cause) {}
};

// 看护器视角的一次性通道实例（NodeIpc 一次性设计，start 只能成功一次；重启 = 新建实例，
// 对齐 Java NodeSupervisor.NodeIpcFactory 的重建模型）。
struct ManagedIpc {
    virtual ~ManagedIpc() = default;
    virtual StartOutcome start() = 0;
    virtual void shutdown(const std::string& reason) = 0;
};

class NodeIpc final : public ManagedIpc {
public:
    // 日志回调：收整行（已带 `[NodeIpc][INFO] ` / `[NodeIpc][WARN] ` 前缀，前缀后一空格，
    // 与 Java 逐字一致——宿主据前缀分流）。在读线程或调用线程上执行。
    using LogFn = std::function<void(const std::string&)>;

    // nodeExecutable / bundlePath 须非空白（生产经 NodeRuntime 解析保证存在性）。
    NodeIpc(std::string nodeExecutable, std::string bundlePath, NodeIpcListener& listener, LogFn log);
    // 兜底回收：若从未 shutdown 则补发关停路径（关 stdin + 强杀幸存进程），随后 join 读线程。
    ~NodeIpc() override;
    NodeIpc(const NodeIpc&) = delete;
    NodeIpc& operator=(const NodeIpc&) = delete;

    // 拉起 node bundle 并阻塞等 ready 帧（重复调用等价于继续等待既定结果，对齐 Java
    // 「重复 start 返回同一 future」）。start 前：PID 残留检查 → spawn → 写 PID 文件。
    // ready 前进程退出 → ok=false（「Node 进程在 ready 前断开（…）」）；等满 30s →
    // ok=false（「等待 ready 帧超时（…ms）」）+ destroyForcibly。
    StartOutcome start() override;

    // 优雅关停（幂等，CAS）：写 shutdown 帧 → 关 stdin → 有界等退出 5s → TerminateProcess
    // 再等 2s → 通道终结 → 删 PID 文件（只在优雅路径删）。不发 onProcessExited。
    void shutdown(const std::string& reason) override;

    // 出帧：事件（事件帧 header 仅 type、无 id）。通道可用且写出成功返回 true；通道不可用
    // 记 WARN 丢弃返回 false（对齐 Java 各 sendXxx 的不可用分支；字段级校验归上层桥接面）。
    bool sendEvent(std::string_view type, const JsonValue& body);

    // 请求-响应（阻塞至响应 / 10s 超时 / 通道断开）。broadcast 的 body 形态对齐 Java
    // encodeBroadcastRequest（仅 message 键）。
    RequestOutcome broadcast(const std::string& message);
    RequestOutcome executeCommand(const std::string& command);

    // ---- 测试/运维钩子（对齐 Java 包内 setter；须在 start()/请求前设置）----
    void setStartTimeoutMs(std::int64_t ms) { startTimeoutMs_ = ms; }
    void setRequestTimeoutMs(std::int64_t ms) { requestTimeoutMs_ = ms; }
    void setShutdownGraceMs(std::int64_t ms) { shutdownGraceMs_ = ms; }
    void setShutdownForceWaitMs(std::int64_t ms) { shutdownForceWaitMs_ = ms; }
    // 子进程工作目录；不设 = 继承（生产由调用方传 BDS 根）。
    void setWorkingDirectory(std::filesystem::path directory) {
        workingDirectory_ = std::move(directory);
        hasWorkingDirectory_ = true;
    }
    // PID 文件（DEBT-2 进程卫生）：spawn 成功写 `<pid>\n`（父目录不存在则建；失败仅 WARN），
    // 优雅关停删除、异常退出保留（残留即「上次可能异常退出」的证据）。不设 = 不启用。
    void setPidFile(std::filesystem::path file) {
        pidFile_ = std::move(file);
        hasPidFile_ = true;
    }
    // 仅测试用：直接关闭父端 stdin 写柄（触发 Node 侧 stdin EOF 自杀 → stdout EOF 终结路径）。
    void closeStdinForTest() { closeStdin(); }

    unsigned long pid() const { return pid_; }
    std::optional<unsigned long> childExitCode() const;

private:
    struct PendingEntry {
        bool settled = false;
        RequestOutcome outcome;
    };

    void spawn();
    void failStart(std::string error);
    void readStdoutLoop();
    void readStderrLoop();
    void handleLine(const std::string& line);
    void handleReady(const ipc::ReadyFrame& ready);
    ResultResponder makeResponder(std::string resultType, std::string id);
    void settleResult(const ipc::ResultFrame& result);
    RequestOutcome sendRequest(std::string_view type, std::string_view field, const std::string& value);
    bool unavailable(std::string_view what);
    bool writeFrame(const std::string& json);
    void closeStdin();
    void waitForExitBounded();
    void tearDownChannel(const std::string& cause);
    std::string describeExitSuffix() const;
    std::optional<unsigned long> exitCodeOrNull() const;
    void checkPidResidue();
    void writePidFile();
    void deletePidFile();
    template <typename Fn>
    void safeCall(const char* what, Fn&& fn);
    void logInfo(const std::string& message);
    void logWarn(const std::string& message);
    static std::string preview(const std::string& line);

    const std::string nodeExecutable_;
    const std::string bundlePath_;
    NodeIpcListener& listener_;
    LogFn log_;

    // stdin 写串行 + stdinWrite 句柄生命周期（对齐 Java writeLock）
    std::mutex writeMutex_;
    // start 结果 / pending 请求状态（对齐 Java startFuture + ConcurrentMap 的复合面）
    std::mutex channelMutex_;
    std::condition_variable startCv_;
    std::condition_variable requestCv_;

    std::atomic<bool> spawnStarted_{false};
    std::atomic<bool> shutdownStarted_{false};
    std::atomic<bool> channelOpen_{false};
    std::atomic<bool> channelTornDown_{false};
    std::atomic<bool> readyReceived_{false};

    // channelMutex_ 保护
    bool startDone_ = false;
    bool startOk_ = false;
    long long startWsPort_ = 0;
    std::string startError_;
    std::map<std::string, std::shared_ptr<PendingEntry>> pending_;

    SpawnedProcess process_;
    unsigned long pid_ = 0;

    // 超时口径（对齐 Java volatile setter：30s start / 10s 请求 / 5s 优雅等退 / 2s 强杀等退）
    std::int64_t startTimeoutMs_ = 30000;
    std::int64_t requestTimeoutMs_ = 10000;
    std::int64_t shutdownGraceMs_ = 5000;
    std::int64_t shutdownForceWaitMs_ = 2000;
    bool hasWorkingDirectory_ = false;
    std::filesystem::path workingDirectory_;
    bool hasPidFile_ = false;
    std::filesystem::path pidFile_;

    // 读线程最后声明（析构时先于其余成员销毁；析构函数体先 join）
    std::thread stdoutThread_;
    std::thread stderrThread_;
};

}  // namespace kurobridge::core
