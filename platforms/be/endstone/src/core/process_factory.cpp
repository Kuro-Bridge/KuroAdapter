// kurobridge_core / Node 子进程拉起实现（Win32）。见 process_factory.h 头注与 feasibility.md R6。

#include "core/process_factory.h"

#include <windows.h>

#include <algorithm>
#include <memory>
#include <utility>
#include <vector>

namespace kurobridge::core {
namespace {

std::wstring utf8ToWide(std::string_view utf8) {
    if (utf8.empty()) {
        return {};
    }
    const int size = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
    std::wstring wide(static_cast<std::size_t>(size), L'\0');
    if (size > 0) {
        MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), wide.data(), size);
    }
    return wide;
}

std::string wideToUtf8(std::wstring_view wide) {
    if (wide.empty()) {
        return {};
    }
    const int size = WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()),
                                         nullptr, 0, nullptr, nullptr);
    std::string utf8(static_cast<std::size_t>(size), '\0');
    if (size > 0) {
        WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), utf8.data(), size,
                            nullptr, nullptr);
    }
    return utf8;
}

// 系统错误码 → 可读文本（供 SpawnOutcome.error；取不到时退回 code=N）
std::string systemErrorMessage(unsigned long code) {
    LPWSTR buffer = nullptr;
    const DWORD size = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM
                                          | FORMAT_MESSAGE_IGNORE_INSERTS,
                                      nullptr, code, 0, reinterpret_cast<LPWSTR>(&buffer), 0, nullptr);
    std::string message;
    if (size > 0 && buffer != nullptr) {
        message = wideToUtf8(std::wstring_view(buffer, static_cast<std::size_t>(size)));
        LocalFree(buffer);
        while (!message.empty()
               && (message.back() == '\r' || message.back() == '\n' || message.back() == ' ')) {
            message.pop_back();
        }
    }
    if (message.empty()) {
        message = "code=" + std::to_string(code);
    }
    return message;
}

// 环境块：继承 GetEnvironmentStringsW + extraEnv 叠加（键大小写不敏感覆盖），并按
// Windows 约定做大小写不敏感排序后拼 `KEY=VAL\0` 序列（双 \0 结尾）。
std::vector<wchar_t> buildEnvironmentBlock(const std::map<std::string, std::string>& extraEnv) {
    std::vector<std::pair<std::wstring, std::wstring>> entries;
    wchar_t* raw = GetEnvironmentStringsW();
    if (raw != nullptr) {
        for (wchar_t* cursor = raw; *cursor != L'\0';) {
            const std::wstring entry(cursor);
            cursor += entry.size() + 1;
            // 跳过等号开头的隐藏变量（如 =C:=...，Windows cmd 内部残留）
            if (!entry.empty() && entry[0] != L'=') {
                const std::size_t eq = entry.find(L'=');
                if (eq != std::wstring::npos) {
                    entries.emplace_back(entry.substr(0, eq), entry.substr(eq + 1));
                }
            }
        }
        FreeEnvironmentStringsW(raw);
    }
    for (const auto& [key, value] : extraEnv) {
        const std::wstring keyWide = utf8ToWide(key);
        const std::wstring valueWide = utf8ToWide(value);
        bool replaced = false;
        for (auto& [existingKey, existingValue] : entries) {
            if (_wcsicmp(existingKey.c_str(), keyWide.c_str()) == 0) {
                existingValue = valueWide;
                replaced = true;
                break;
            }
        }
        if (!replaced) {
            entries.emplace_back(keyWide, valueWide);
        }
    }
    std::sort(entries.begin(), entries.end(), [](const auto& left, const auto& right) {
        return _wcsicmp(left.first.c_str(), right.first.c_str()) < 0;
    });
    std::vector<wchar_t> block;
    for (const auto& [key, value] : entries) {
        const std::wstring line = key + L"=" + value;
        block.insert(block.end(), line.begin(), line.end());
        block.push_back(L'\0');
    }
    block.push_back(L'\0');
    return block;
}

}  // namespace

// ---- ProcessHandle ----

ProcessHandle::ProcessHandle(void* handle) noexcept : handle_(handle) {}

ProcessHandle::~ProcessHandle() { close(); }

ProcessHandle::ProcessHandle(ProcessHandle&& other) noexcept : handle_(other.handle_) {
    other.handle_ = nullptr;
}

ProcessHandle& ProcessHandle::operator=(ProcessHandle&& other) noexcept {
    if (this != &other) {
        close();
        handle_ = other.handle_;
        other.handle_ = nullptr;
    }
    return *this;
}

void ProcessHandle::close() {
    if (handle_ != nullptr) {
        CloseHandle(handle_);
        handle_ = nullptr;
    }
}

void ProcessHandle::reset(void* handle) {
    close();
    handle_ = handle;
}

// ---- 进程/管道薄包装 ----

bool processAlive(const ProcessHandle& process) {
    if (!process.valid()) {
        return false;
    }
    return WaitForSingleObject(process.get(), 0) == WAIT_TIMEOUT;
}

std::optional<unsigned long> processExitCode(const ProcessHandle& process) {
    if (!process.valid()) {
        return std::nullopt;
    }
    DWORD code = 0;
    if (GetExitCodeProcess(process.get(), &code) == 0 || code == STILL_ACTIVE) {
        return std::nullopt;
    }
    return static_cast<unsigned long>(code);
}

bool processWaitForExit(const ProcessHandle& process, unsigned long timeoutMs) {
    if (!process.valid()) {
        return true;
    }
    return WaitForSingleObject(process.get(), static_cast<DWORD>(timeoutMs)) == WAIT_OBJECT_0;
}

void processTerminate(const ProcessHandle& process) {
    if (process.valid()) {
        TerminateProcess(process.get(), 1);
    }
}

bool pipeWriteAll(const ProcessHandle& handle, std::string_view bytes) {
    const char* data = bytes.data();
    std::size_t remaining = bytes.size();
    while (remaining > 0) {
        const DWORD chunk = static_cast<DWORD>(std::min<std::size_t>(remaining, 64 * 1024));
        DWORD written = 0;
        if (WriteFile(handle.get(), data, chunk, &written, nullptr) == 0 || written == 0) {
            return false;
        }
        data += written;
        remaining -= written;
    }
    return true;
}

bool pipeReadChunk(const ProcessHandle& handle, std::string& out) {
    char buffer[4096];
    DWORD read = 0;
    if (ReadFile(handle.get(), buffer, sizeof(buffer), &read, nullptr) == 0) {
        // ERROR_BROKEN_PIPE = 对端关闭（正常 EOF 路径）；其余错误同样按流终结收敛
        return false;
    }
    if (read == 0) {
        return false;
    }
    out.append(buffer, read);
    return true;
}

// ---- spawn ----

SpawnOutcome spawnProcess(const SpawnRequest& request) {
    SpawnOutcome outcome;
    // 命令行恰两参数、各拼引号（对齐 Java List.of(nodeExecutable, bundlePath) 的 ProcessBuilder 展开）
    const std::wstring commandLine =
        L"\"" + utf8ToWide(request.nodeExecutable) + L"\" \"" + utf8ToWide(request.bundlePath) + L"\"";
    if (commandLine.size() <= 4) {
        outcome.error = "命令行非法：node 与 bundle 路径均不能为空";
        return outcome;
    }

    SECURITY_ATTRIBUTES inherit{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE stdinRead = nullptr;
    HANDLE stdinWrite = nullptr;
    HANDLE stdoutRead = nullptr;
    HANDLE stdoutWrite = nullptr;
    HANDLE stderrRead = nullptr;
    HANDLE stderrWrite = nullptr;
    auto closeParentEnds = [&] {
        for (HANDLE handle : {stdinWrite, stdoutRead, stderrRead}) {
            if (handle != nullptr) {
                CloseHandle(handle);
            }
        }
    };
    // 失败收敛：关全部六柄、折错误串进 outcome（调用方随函数级 return 走 NRVO，免拷贝）
    auto failWith = [&outcome](const std::string& what,
                               std::initializer_list<HANDLE> handles) {
        outcome.error = what;
        for (HANDLE handle : handles) {
            if (handle != nullptr) {
                CloseHandle(handle);
            }
        }
    };

    // 三条匿名管道：子端（stdin 读 / stdout 写 / stderr 写）可继承
    if (CreatePipe(&stdinRead, &stdinWrite, &inherit, 0) == 0
            || CreatePipe(&stdoutRead, &stdoutWrite, &inherit, 0) == 0
            || CreatePipe(&stderrRead, &stderrWrite, &inherit, 0) == 0) {
        failWith("CreatePipe 失败：" + systemErrorMessage(GetLastError()),
                 {stdinRead, stdinWrite, stdoutRead, stdoutWrite, stderrRead, stderrWrite});
        return outcome;
    }
    // 父端三柄去继承（继承面只剩 HANDLE_LIST 里的三个子端柄）
    SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0);

    // HANDLE_LIST 精确限定（feasibility.md R6）：防孙进程经全量句柄继承泄漏父端柄，
    // 挂住「子进程退出即管道 EOF」的语义
    HANDLE inheritList[3] = {stdinRead, stdoutWrite, stderrWrite};
    STARTUPINFOEXW startupInfo{};
    startupInfo.StartupInfo.cb = sizeof(startupInfo);
    // STARTF_USESTDHANDLES：显式把三个子端柄绑定为子进程 stdio。缺省时子进程沿用父进程
    // 的句柄「值」——首次 spawn 恰逢句柄值相同才偶然成立，属不可依赖的运气行为
    startupInfo.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startupInfo.StartupInfo.hStdInput = stdinRead;
    startupInfo.StartupInfo.hStdOutput = stdoutWrite;
    startupInfo.StartupInfo.hStdError = stderrWrite;
    SIZE_T attributeSize = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeSize);  // 仅取所需缓冲区大小
    const std::unique_ptr<unsigned char[]> attributeBuffer(new unsigned char[attributeSize]);
    startupInfo.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeBuffer.get());
    if (InitializeProcThreadAttributeList(startupInfo.lpAttributeList, 1, 0, &attributeSize) == 0
            || UpdateProcThreadAttribute(startupInfo.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                         inheritList, sizeof(inheritList), nullptr, nullptr)
                   == 0) {
        DeleteProcThreadAttributeList(startupInfo.lpAttributeList);
        failWith("初始化句柄继承限定（PROC_THREAD_ATTRIBUTE_HANDLE_LIST）失败："
                     + systemErrorMessage(GetLastError()),
                 {stdinRead, stdinWrite, stdoutRead, stdoutWrite, stderrRead, stderrWrite});
        return outcome;
    }

    PROCESS_INFORMATION processInfo{};
    std::vector<wchar_t> environmentBlock = buildEnvironmentBlock(request.extraEnv);
    const std::wstring workingDirectory =
        request.workingDirectory != nullptr ? request.workingDirectory->wstring() : std::wstring();
    std::vector<wchar_t> mutableCommandLine(commandLine.begin(), commandLine.end());
    mutableCommandLine.push_back(L'\0');  // CreateProcessW 可能就地改写命令行，须可变缓冲
    const BOOL created = CreateProcessW(nullptr, mutableCommandLine.data(), nullptr, nullptr, TRUE,
                                        // CREATE_UNICODE_ENVIRONMENT：环境块为 UTF-16（缺失即
                                        // 按 ANSI 解析 → ERROR_INVALID_PARAMETER）
                                        CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT
                                            | EXTENDED_STARTUPINFO_PRESENT,
                                        environmentBlock.empty() ? LPVOID(nullptr)
                                                                 : static_cast<LPVOID>(environmentBlock.data()),
                                        workingDirectory.empty() ? nullptr : workingDirectory.c_str(),
                                        &startupInfo.StartupInfo, &processInfo);
    DeleteProcThreadAttributeList(startupInfo.lpAttributeList);
    // 子端柄随继承完成，父进程即刻关闭（多持一个写柄会挂住子进程的 EOF 判定）
    CloseHandle(stdinRead);
    CloseHandle(stdoutWrite);
    CloseHandle(stderrWrite);
    stdinRead = nullptr;
    stdoutWrite = nullptr;
    stderrWrite = nullptr;
    if (created == 0) {
        const unsigned long code = GetLastError();
        closeParentEnds();
        if (processInfo.hProcess != nullptr) {
            CloseHandle(processInfo.hProcess);
        }
        if (processInfo.hThread != nullptr) {
            CloseHandle(processInfo.hThread);
        }
        outcome.error =
            "CreateProcessW 失败（code=" + std::to_string(code) + "）：" + systemErrorMessage(code);
        return outcome;
    }
    CloseHandle(processInfo.hThread);
    outcome.ok = true;
    outcome.process.stdinWrite.reset(stdinWrite);
    outcome.process.stdoutRead.reset(stdoutRead);
    outcome.process.stderrRead.reset(stderrRead);
    outcome.process.process.reset(processInfo.hProcess);
    outcome.process.pid = static_cast<unsigned long>(processInfo.dwProcessId);
    return outcome;
}

}  // namespace kurobridge::core
