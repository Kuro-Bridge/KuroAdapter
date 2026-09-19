// kurobridge_core / Node 子进程拉起（Win32）——对齐 Java ProcessFactory.system() 语义：
// 命令行恰两参数（node 可执行 + bundle，各拼引号）、环境继承父进程、可选工作目录、
// stdin/stdout/stderr 三条匿名管道对接（不重定向到文件）。
//
// Windows 专项（feasibility.md R6）：STARTUPINFOEXW + PROC_THREAD_ATTRIBUTE_HANDLE_LIST
// 把可继承句柄精确限定到三个子端管柄——防孙进程经句柄继承泄漏父端柄挂住 stdout EOF
// 语义（endstone 侧插件 dll 会被影子拷贝 + LoadLibrary，继承面收窄同时降低 dll 文件锁风险）。
//
// 头文件面保持 portable（句柄以 void* 携带，不引 windows.h）；Win32 细节收敛在本 .cpp。

#pragma once

#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <string_view>

namespace kurobridge::core {

// RAII Win32 句柄（void* 承载；无效 = nullptr）。析构 CloseHandle；仅移动。
class ProcessHandle {
public:
    ProcessHandle() = default;
    explicit ProcessHandle(void* handle) noexcept;
    ~ProcessHandle();
    ProcessHandle(ProcessHandle&& other) noexcept;
    ProcessHandle& operator=(ProcessHandle&& other) noexcept;
    ProcessHandle(const ProcessHandle&) = delete;
    ProcessHandle& operator=(const ProcessHandle&) = delete;

    void* get() const { return handle_; }
    bool valid() const { return handle_ != nullptr; }
    void close();
    void reset(void* handle);  // 关旧持新（旧柄无效时等同赋值）

private:
    void* handle_ = nullptr;
};

// spawn 请求（路径均 UTF-8）。workingDirectory 空指针 = 继承父进程 cwd（Java null 语义；
// 生产形态：调用方传 BDS 根，Node 侧据此定位 plugins/kurobridge/config.json）。
struct SpawnRequest {
    std::string nodeExecutable;
    std::string bundlePath;
    std::map<std::string, std::string> extraEnv;  // 继承再叠加（对齐 ProcessFactory.system()；v1 仅继承，叠加面留作扩展）
    const std::filesystem::path* workingDirectory = nullptr;
};

// spawn 产物：父端持有的三管端 + 进程句柄。三个子端柄已在父进程内关闭（继承随 CreateProcess 完成）。
struct SpawnedProcess {
    ProcessHandle stdinWrite;   // 父 → 子 stdin
    ProcessHandle stdoutRead;   // 子 stdout → 父
    ProcessHandle stderrRead;   // 子 stderr → 父
    ProcessHandle process;
    unsigned long pid = 0;
};

struct SpawnOutcome {
    bool ok = false;
    SpawnedProcess process;
    std::string error;  // ok=false 的中文原因
};

// 拉起子进程（CREATE_NO_WINDOW）。永不抛异常，Win32 失败折进 SpawnOutcome.error。
SpawnOutcome spawnProcess(const SpawnRequest& request);

// ---- 进程/管道薄包装（供 NodeIpc 消费；全部非阻塞/有界，不抛异常）----

bool processAlive(const ProcessHandle& process);
// 进程已退出取退出码；仍在运行（含 STILL_ACTIVE）→ nullopt
std::optional<unsigned long> processExitCode(const ProcessHandle& process);
// 有界等退出；true = 已退出并回收
bool processWaitForExit(const ProcessHandle& process, unsigned long timeoutMs);
// TerminateProcess 强杀（best effort，结果不抛不报——后续经 waitForExit/exitCode 观察）
void processTerminate(const ProcessHandle& process);

// 全量写（WriteFile 循环到写完；任何失败折 false）
bool pipeWriteAll(const ProcessHandle& handle, std::string_view bytes);
// 读一块（ReadFile 阻塞至有数据或流终结）；false = EOF/断管/句柄失效。out 追加本次新字节。
bool pipeReadChunk(const ProcessHandle& handle, std::string& out);

}  // namespace kurobridge::core
