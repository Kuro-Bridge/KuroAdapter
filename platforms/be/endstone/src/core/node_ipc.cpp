// kurobridge_core / NodeIpc 实现。语义对照物 = NodeIpc.java（逐行为对齐，日志文案逐字）。

#include "core/node_ipc.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <fstream>
#include <random>
#include <system_error>
#include <utility>

namespace kurobridge::core {
namespace {

// 坏行日志预览上限（对齐 NodeIpc.LOG_PREVIEW_LIMIT = 200）
constexpr std::size_t kLogPreviewLimit = 200;

// tearDown 内对刚强杀进程的有界回收等待（毫秒）：Java 不等待、退出码常为 null；
// C++ 持真实句柄，等待是纯增益——换取 onProcessExited 尽量带真实退出码。
constexpr unsigned long kExitReapWaitMs = 1000;

// Java String.trim 口径：去两端 ≤ U+0020 的字符
std::string trimAscii(const std::string& value) {
    std::size_t begin = 0;
    std::size_t end = value.size();
    while (begin < end && static_cast<unsigned char>(value[begin]) <= ' ') {
        ++begin;
    }
    while (end > begin && static_cast<unsigned char>(value[end - 1]) <= ' ') {
        --end;
    }
    return value.substr(begin, end - begin);
}

void appendHex(std::string& out, std::uint64_t value, int nibbles) {
    static constexpr char kHex[] = "0123456789abcdef";
    for (int shift = (nibbles - 1) * 4; shift >= 0; shift -= 4) {
        out.push_back(kHex[(value >> shift) & 0xF]);
    }
}

std::string formatUuid(std::uint64_t high, std::uint64_t low) {
    // 8-4-4-4-12 分组出串（high 承载组 1-3，low 承载组 4-5）
    std::string out;
    out.reserve(36);
    appendHex(out, high >> 32, 8);
    out.push_back('-');
    appendHex(out, (high >> 16) & 0xFFFF, 4);
    out.push_back('-');
    appendHex(out, high & 0xFFFF, 4);
    out.push_back('-');
    appendHex(out, (low >> 48) & 0xFFFF, 4);
    out.push_back('-');
    appendHex(out, low & 0xFFFFFFFFFFFFULL, 12);
    return out;
}

}  // namespace

std::optional<std::string_view> parseNodeLogLevel(std::string_view line) {
    static constexpr std::string_view kPrefix = "[KuroBridge][node][";
    if (line.size() <= kPrefix.size() || line.substr(0, kPrefix.size()) != kPrefix) {
        return std::nullopt;
    }
    for (const std::string_view level : {std::string_view{"debug"}, std::string_view{"info"},
                                         std::string_view{"warn"}, std::string_view{"error"}}) {
        std::string head;
        head.reserve(kPrefix.size() + level.size() + 1);
        head.append(kPrefix).append(level).push_back(']');
        if (line.starts_with(head)) {
            return level;
        }
    }
    return std::nullopt;
}

std::string generateUuidV4() {
    // 版本位 = a 的第 3 组首半字节（bit 12..15）置 4；变体位 = low 顶 3 位（bit 61..63）置 10x
    static std::atomic<std::uint64_t> counter{0};
    std::uint64_t a = 0;
    std::uint64_t b = 0;
    try {
        std::random_device device;
        a = (static_cast<std::uint64_t>(device()) << 32) ^ device();
        b = (static_cast<std::uint64_t>(device()) << 32) ^ device();
    } catch (...) {
        // 受限环境 random_device 可能不可用；time+counter 混合兜底
    }
    a ^= static_cast<std::uint64_t>(std::chrono::steady_clock::now().time_since_epoch().count());
    b ^= counter.fetch_add(0x9E3779B97F4A7C15ULL, std::memory_order_relaxed);
    a = (a & 0xFFFFFFFFFFFF0FFFULL) | 0x0000000000004000ULL;
    b = (b & 0x3FFFFFFFFFFFFFFFULL) | 0x8000000000000000ULL;
    return formatUuid(a, b);
}

NodeIpc::NodeIpc(std::string nodeExecutable, std::string bundlePath, NodeIpcListener& listener, LogFn log)
    : nodeExecutable_(std::move(nodeExecutable)),
      bundlePath_(std::move(bundlePath)),
      listener_(listener),
      log_(std::move(log)) {}

NodeIpc::~NodeIpc() {
    // 兜底回收（正常路径显式 shutdown；此处幂等）：关闭 stdin + 强杀幸存进程，
    // 解除读线程上可能挂着的 ReadFile，join 才不会悬挂
    if (!shutdownStarted_.exchange(true)) {
        if (channelOpen_) {
            closeStdin();
        }
        if (process_.process.valid() && processAlive(process_.process)) {
            processTerminate(process_.process);
        }
    }
    if (stdoutThread_.joinable()) {
        stdoutThread_.join();
    }
    if (stderrThread_.joinable()) {
        stderrThread_.join();
    }
}

StartOutcome NodeIpc::start() {
    if (!spawnStarted_.exchange(true)) {
        spawn();
    }
    std::unique_lock<std::mutex> lock(channelMutex_);
    const bool completed = startCv_.wait_until(lock, std::chrono::steady_clock::now()
                                                             + std::chrono::milliseconds(startTimeoutMs_),
                                               [this] { return startDone_; });
    if (!completed) {
        // TimeoutException 语义：错误串 + destroyForcibly（对齐 Java onStartTimeout；
        // 通道终结交给强杀后的 stdout EOF 路径，保证 pending/退出通知恰一次收敛）
        startDone_ = true;
        startOk_ = false;
        startError_ = "等待 ready 帧超时（" + std::to_string(startTimeoutMs_) + "ms）";
        const StartOutcome outcome{false, 0, startError_};
        lock.unlock();
        if (process_.process.valid() && processAlive(process_.process)) {
            processTerminate(process_.process);
        }
        return outcome;
    }
    return StartOutcome{startOk_, startWsPort_, startError_};
}

void NodeIpc::shutdown(const std::string& reason) {
    if (shutdownStarted_.exchange(true)) {
        return;  // CAS 幂等（对齐 Java shutdownStarted）
    }
    std::string safeReason = trimAscii(reason);  // 空白兜底（对齐 Java isBlank）
    if (safeReason.empty()) {
        safeReason = "unspecified";
    }
    if (channelOpen_) {
        // shutdown 帧无专用常量（ipc_frame.h 只登记入帧目录），字面量对齐 IpcFrameCodec.TYPE_SHUTDOWN
        writeFrame(ipc::encodeEvent("shutdown",
                                    JsonValue::object({{"reason", JsonValue::string(safeReason)}})));
        closeStdin();
    }
    waitForExitBounded();
    tearDownChannel("shutdown(" + safeReason + ")");
    deletePidFile();  // 只在优雅路径删（异常退出的残留即证据）
    logInfo("Node IPC 已关闭：" + safeReason);
}

bool NodeIpc::sendEvent(std::string_view type, const JsonValue& body) {
    if (unavailable(std::string(type) + " 事件")) {
        return false;
    }
    return writeFrame(ipc::encodeEvent(type, body));
}

RequestOutcome NodeIpc::broadcast(const std::string& message) {
    // body 形态对齐 Java encodeBroadcastRequest（仅 message 键）
    return sendRequest(ipc::kTypeBroadcast, "message", message);
}

RequestOutcome NodeIpc::executeCommand(const std::string& command) {
    return sendRequest(ipc::kTypeExecuteCommand, "command", command);
}

std::optional<unsigned long> NodeIpc::childExitCode() const {
    if (!process_.process.valid()) {
        return std::nullopt;
    }
    return processExitCode(process_.process);
}

// ---- 启动 ----

void NodeIpc::spawn() {
    if (shutdownStarted_) {
        failStart("NodeIpc 已 shutdown，无法启动");
        return;
    }
    checkPidResidue();
    SpawnRequest request;
    request.nodeExecutable = nodeExecutable_;
    request.bundlePath = bundlePath_;
    request.workingDirectory = hasWorkingDirectory_ ? &workingDirectory_ : nullptr;
    SpawnOutcome spawned = spawnProcess(request);
    if (!spawned.ok) {
        failStart("拉起 Node 进程失败：" + spawned.error);
        return;
    }
    process_ = std::move(spawned.process);
    pid_ = process_.pid;
    channelOpen_ = true;
    writePidFile();
    logInfo("Node 进程已拉起：[" + nodeExecutable_ + ", " + bundlePath_ + "]");
    stdoutThread_ = std::thread([this] { readStdoutLoop(); });
    stderrThread_ = std::thread([this] { readStderrLoop(); });
}

void NodeIpc::failStart(std::string error) {
    {
        std::lock_guard<std::mutex> lock(channelMutex_);
        if (!startDone_) {
            startDone_ = true;
            startOk_ = false;
            startError_ = std::move(error);
        }
    }
    startCv_.notify_all();
}

void NodeIpc::checkPidResidue() {
    if (!hasPidFile_) {
        return;
    }
    std::error_code ec;
    if (!std::filesystem::is_regular_file(pidFile_, ec)) {
        return;
    }
    logWarn("发现残留 PID 文件（上次可能异常退出）：" + pidFile_.string());
}

void NodeIpc::writePidFile() {
    if (!hasPidFile_) {
        return;
    }
    std::error_code ec;
    if (!pidFile_.parent_path().empty()) {
        std::filesystem::create_directories(pidFile_.parent_path(), ec);
    }
    std::ofstream file(pidFile_, std::ios::binary | std::ios::trunc);
    const bool written = file.is_open() && static_cast<bool>(file << pid_ << "\n");
    file.close();
    if (!written) {
        // 写失败仅告警，不影响启动（对齐 Java writePidFile）
        logWarn("写入 PID 文件失败（不影响运行）：" + pidFile_.string());
    }
}

void NodeIpc::deletePidFile() {
    if (!hasPidFile_) {
        return;
    }
    std::error_code ec;
    const bool removed = std::filesystem::remove(pidFile_, ec);
    if (ec || (!removed && std::filesystem::exists(pidFile_, ec))) {
        logWarn("删除 PID 文件失败：" + pidFile_.string() + "，" + ec.message());
    }
}

// ---- 读取循环（字节 ↔ 行；对齐 Java readStdoutLoop / readStderrLoop）----

void NodeIpc::readStdoutLoop() {
    std::string buffer;
    std::string chunk;
    while (pipeReadChunk(process_.stdoutRead, chunk)) {
        buffer += chunk;
        std::size_t start = 0;
        for (;;) {
            const std::size_t newline = buffer.find('\n', start);
            if (newline == std::string::npos) {
                break;
            }
            std::string line = buffer.substr(start, newline - start);
            start = newline + 1;
            if (!line.empty() && line.back() == '\r') {
                line.pop_back();  // 容忍 CRLF
            }
            const std::string trimmed = trimAscii(line);
            if (!trimmed.empty()) {  // 空白行跳过
                handleLine(trimmed);
            }
        }
        buffer.erase(0, start);
        chunk.clear();
    }
    tearDownChannel("stdout EOF");
}

void NodeIpc::readStderrLoop() {
    std::string buffer;
    std::string chunk;
    while (pipeReadChunk(process_.stderrRead, chunk)) {
        buffer += chunk;
        std::size_t start = 0;
        for (;;) {
            const std::size_t newline = buffer.find('\n', start);
            if (newline == std::string::npos) {
                break;
            }
            std::string line = buffer.substr(start, newline - start);
            start = newline + 1;
            if (!line.empty() && line.back() == '\r') {
                line.pop_back();
            }
            // 每行原样中继（级别解析 parseNodeLogLevel 留给消费方；对齐 Java 直传语义）
            safeCall("onStderrLine", [&] { listener_.onStderrLine(line); });
        }
        buffer.erase(0, start);
        chunk.clear();
    }
}

void NodeIpc::handleLine(const std::string& line) {
    const ipc::DecodeResult decoded = ipc::decodeFrame(line);
    if (!decoded.ok) {
        // 坏行 WARN + 跳过（截 200 字符预览），不崩不断（对齐 Java handleLine）
        logWarn("跳过无法解析/未知的 IPC 行：" + preview(line));
        return;
    }
    if (const auto* ready = std::get_if<ipc::ReadyFrame>(&decoded.frame)) {
        handleReady(*ready);
    } else if (const auto* broadcastRequest = std::get_if<ipc::BroadcastRequest>(&decoded.frame)) {
        const ResultResponder respond = makeResponder(std::string(ipc::kTypeBroadcastResult),
                                                      broadcastRequest->id);
        safeCall("onBroadcast", [&] { listener_.onBroadcast(*broadcastRequest, respond); });
    } else if (const auto* commandRequest = std::get_if<ipc::ExecuteCommandRequest>(&decoded.frame)) {
        const ResultResponder respond = makeResponder(std::string(ipc::kTypeExecuteCommandResult),
                                                      commandRequest->id);
        safeCall("onExecuteCommand", [&] { listener_.onExecuteCommand(*commandRequest, respond); });
    } else if (const auto* result = std::get_if<ipc::ResultFrame>(&decoded.frame)) {
        settleResult(*result);
    }
}

void NodeIpc::handleReady(const ipc::ReadyFrame& ready) {
    if (readyReceived_.exchange(true)) {
        logWarn("忽略重复的 ready 帧：wsPort=" + std::to_string(ready.wsPort));
        return;
    }
    const bool autoRestart = ready.autoRestart.value_or(true);  // null 按 true 归一（消费方口径）
    {
        std::lock_guard<std::mutex> lock(channelMutex_);
        if (!startDone_) {
            startDone_ = true;
            startOk_ = true;
            startWsPort_ = ready.wsPort;
        }
    }
    startCv_.notify_all();
    logInfo("Node ready：wsPort=" + std::to_string(ready.wsPort) + "，autoRestart="
            + (ready.autoRestart.has_value() ? (autoRestart ? "true" : "false") : "缺省(true)"));
    safeCall("onReady", [&] { listener_.onReady(ready.wsPort, autoRestart); });
}

ResultResponder NodeIpc::makeResponder(std::string resultType, std::string id) {
    auto answered = std::make_shared<std::atomic<bool>>(false);
    return [this, answered, resultType = std::move(resultType), id = std::move(id)](
               bool ok, std::string error, std::vector<std::string> output) {
        if (answered->exchange(true)) {
            logWarn(resultType + " 的 IpcResult 被重复调用，忽略后续调用");
            return;
        }
        const std::string safeError = error.empty() ? "unspecified" : error;
        writeFrame(ipc::encodeResult(resultType, id, ok, safeError, &output));
    };
}

void NodeIpc::settleResult(const ipc::ResultFrame& result) {
    {
        std::lock_guard<std::mutex> lock(channelMutex_);
        const auto it = pending_.find(result.id);
        if (it == pending_.end()) {
            logWarn("收到无在途请求的响应，忽略：type=" + result.type + " id=" + result.id);
            return;
        }
        const std::shared_ptr<PendingEntry> entry = std::move(it->second);
        pending_.erase(it);
        if (result.ok) {
            entry->outcome = RequestOutcome{true, result.output.value_or(std::vector<std::string>{}), {}};
        } else {
            entry->outcome = RequestOutcome{false, {}, result.type + " 失败：" + result.error};
        }
        entry->settled = true;
    }
    requestCv_.notify_all();
}

// ---- 请求发送 ----

RequestOutcome NodeIpc::sendRequest(std::string_view type, std::string_view field, const std::string& value) {
    const std::string typeString(type);
    if (value.empty()) {
        return RequestOutcome{false, {}, typeString + " 的 " + std::string(field) + " 不能为空"};
    }
    if (unavailable(typeString + " 请求")) {
        return RequestOutcome{false, {}, "IPC 通道不可用，无法发送 " + typeString};
    }
    const std::string id = generateUuidV4();
    auto entry = std::make_shared<PendingEntry>();
    {
        std::lock_guard<std::mutex> lock(channelMutex_);
        pending_[id] = entry;
    }
    const JsonValue body = JsonValue::object({{std::string(field), JsonValue::string(value)}});
    if (!writeFrame(ipc::encodeRequest(type, id, body))) {
        std::lock_guard<std::mutex> lock(channelMutex_);
        pending_.erase(id);
        return RequestOutcome{false, {}, "IPC 写入失败，" + typeString + " 未发出"};
    }
    std::unique_lock<std::mutex> lock(channelMutex_);
    const bool settled =
        requestCv_.wait_until(lock, std::chrono::steady_clock::now()
                                          + std::chrono::milliseconds(requestTimeoutMs_),
                              [&] { return entry->settled; });
    if (!settled) {
        // 超时即摘除在途项（对齐 Java scheduler 的过期清理）；迟到的响应落「无在途请求」WARN
        pending_.erase(id);
        return RequestOutcome{false, {}, typeString + " 响应超时（" + std::to_string(requestTimeoutMs_) + "ms）"};
    }
    return entry->outcome;
}

bool NodeIpc::unavailable(std::string_view what) {
    if (shutdownStarted_ || !channelOpen_) {
        logWarn("IPC 通道不可用，丢弃 " + std::string(what));
        return true;
    }
    return false;
}

// ---- 写入与关机 ----

bool NodeIpc::writeFrame(const std::string& json) {
    bool writeFailed = false;
    {
        // 写锁下「单行 + \n」一次写全（对齐 Java writeFrame 的 writeLock + flush 语义；
        // 单次 WriteFile 原子性优于 Java 的多段写）
        std::lock_guard<std::mutex> lock(writeMutex_);
        if (!process_.stdinWrite.valid() || !channelOpen_) {
            logWarn("IPC 通道已关闭，丢弃出帧");
            return false;
        }
        std::string line = json;
        line.push_back('\n');  // 帧尾补 LF（传输层职责，见 ipc_frame.h 头注）
        writeFailed = !pipeWriteAll(process_.stdinWrite, line);
    }
    if (writeFailed) {
        logWarn("写入 stdin 失败，IPC 通道视为断开");
        tearDownChannel("stdin 写入失败");
        return false;
    }
    return true;
}

void NodeIpc::closeStdin() {
    std::lock_guard<std::mutex> lock(writeMutex_);
    channelOpen_ = false;
    if (process_.stdinWrite.valid()) {
        process_.stdinWrite.close();  // 子进程 stdin 读端随之 EOF（Node 侧自杀信号，决策 D-08）
    }
}

void NodeIpc::waitForExitBounded() {
    if (!process_.process.valid()) {
        return;
    }
    if (processWaitForExit(process_.process, static_cast<unsigned long>(shutdownGraceMs_))) {
        return;
    }
    logInfo("Node 进程在 " + std::to_string(shutdownGraceMs_) + "ms 内未退出，destroyForcibly 兜底");
    processTerminate(process_.process);
    if (!processWaitForExit(process_.process, static_cast<unsigned long>(shutdownForceWaitMs_))) {
        logWarn("destroyForcibly 后 Node 进程仍未退出，放弃等待");
    }
}

void NodeIpc::tearDownChannel(const std::string& cause) {
    if (channelTornDown_.exchange(true)) {
        return;  // 通道终结幂等（对齐 Java channelTornDown CAS）
    }
    channelOpen_ = false;
    closeStdin();
    if (process_.process.valid() && processAlive(process_.process)) {
        // 活进程强杀（防双进程残留；对齐 Java tearDownChannel 的 destroyForcibly）
        processTerminate(process_.process);
        processWaitForExit(process_.process, kExitReapWaitMs);
    }
    const std::string exitSuffix = describeExitSuffix();
    {
        std::lock_guard<std::mutex> lock(channelMutex_);
        if (!startDone_) {
            startDone_ = true;
            startOk_ = false;
            startError_ = "Node 进程在 ready 前断开（" + cause + exitSuffix + "）";
        }
        // 全部在途请求失败完成（对齐 Java tearDownChannel 的 pending 清理）
        const std::string failure = "IPC 通道已关闭（" + cause + exitSuffix + "）";
        for (auto& [id, entry] : pending_) {
            entry->outcome = RequestOutcome{false, {}, failure};
            entry->settled = true;
        }
        pending_.clear();
    }
    startCv_.notify_all();
    requestCv_.notify_all();
    if (!shutdownStarted_) {
        // 非优雅路径才通知退出（优雅关停不通知；对齐 Java shutdownStarted 判断）
        const std::optional<unsigned long> exitCode = exitCodeOrNull();
        safeCall("onProcessExited", [&] { listener_.onProcessExited(exitCode, cause); });
    }
}

std::string NodeIpc::describeExitSuffix() const {
    if (!process_.process.valid()) {
        return "";
    }
    const std::optional<unsigned long> code = processExitCode(process_.process);
    return code.has_value() ? ("，exit=" + std::to_string(*code)) : "";
}

std::optional<unsigned long> NodeIpc::exitCodeOrNull() const {
    return childExitCode();
}

// ---- 杂项 ----

std::string NodeIpc::preview(const std::string& line) {
    return line.size() <= kLogPreviewLimit ? line : line.substr(0, kLogPreviewLimit) + "...";
}

template <typename Fn>
void NodeIpc::safeCall(const char* what, Fn&& fn) {
    try {
        fn();
    } catch (...) {
        // 回调异常吞掉记 WARN（对齐 Java notifyListener；C++ 侧无异常对象文案可拼，仅留方法名）
        logWarn(std::string(what) + " 回调抛出异常，已忽略");
    }
}

void NodeIpc::logInfo(const std::string& message) {
    log_("[NodeIpc][INFO] " + message);
}

void NodeIpc::logWarn(const std::string& message) {
    log_("[NodeIpc][WARN] " + message);
}

}  // namespace kurobridge::core
