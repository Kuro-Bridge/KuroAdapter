// KuroBridge Endstone C++ 薄壳 —— 插件入口与生命周期（ADR-020：零业务）。
//
// 生命周期（对齐 platforms/je 的 KuroBridgePlugin.java）：
//   onEnable：组装 NodeRuntime（cwd = 进程工作目录）→ start（bin 缺失 → critical 降级日志，
//   插件保持加载不抛异常不崩服；ready 超时/异常退出等软失败由看护器出 WARN/SEVERE 并按
//   退避自动重启）→ 注册四事件（容忍无 IPC，发送时机静默跳过）。v1 不注册任何自定义命令
//  （R5，docs/feasibility.md §5）。
//   onDisable：runtime 停看护 + 优雅关停（core 内部有界等待 + 强杀兜底；对齐 Java 决策
//   D-08——允许在 disable 期阻塞主线程）。
//
// cwd 契约：endstone 以服务端根为进程工作目录（BDS 启动目录），与 paper 侧「相对服务器根
// 定位 plugins/kurobridge/」同契约——core 据此解析 bin/、写 node.pid，node 子进程继承该
// cwd 定位 config.json。开发覆盖：KUROBRIDGE_NODE / KUROBRIDGE_BUNDLE 环境变量（core
// resolveNodeRuntimePaths 语义，与 Java 逐字一致）。

#include <filesystem>
#include <memory>
#include <string>

#include <endstone/plugin/plugin.h>

#include "bridge.h"
#include "core/node_runtime.h"
#include "events.h"

namespace kurobridge {

class KuroBridgePlugin : public endstone::Plugin {
public:
    void onEnable() override {
        // 成员声明序保证析构序：runtime（持 Bridge& 回调缝）先于 bridge 析构。
        bridge_ = std::make_unique<Bridge>(*this);
        runtime_ = std::make_unique<core::NodeRuntime>(
            *bridge_, [this](const std::string& line) { relayLogLine(getLogger(), line); },
            std::filesystem::current_path());
        std::string error;
        if (!runtime_->start(&error)) {
            // bin 缺失等硬失败：降级不崩服——插件保持加载、无 IPC（对齐 paper 的 SEVERE 语义；
            // start 阻塞至 ready/失败，见 core/node_ipc.h 头注的 v1 同步化收敛取舍）
            getLogger().critical("Node 运行时不可用，插件保持加载但无 IPC（降级语义）：" + error);
        }
        events_ = std::make_unique<EventBridge>(*this, *runtime_);
        events_->registerAll();
    }

    void onDisable() override {
        if (runtime_ != nullptr) {
            runtime_->stop("插件禁用");
        }
    }

private:
    std::unique_ptr<Bridge> bridge_;      // Node→游戏 请求处理（NodeIpcListener 观察缝）
    std::unique_ptr<EventBridge> events_; // 游戏事件 → Node 出帧
    std::unique_ptr<core::NodeRuntime> runtime_;  // Node 子进程拉起/看护/IPC 顶层组装
};

}  // namespace kurobridge

ENDSTONE_PLUGIN(/*name=*/"kurobridge", /*version=*/"0.1.0", /*main_class=*/kurobridge::KuroBridgePlugin)
{
    // 版本串 0.1.0 为占位：插件版本面后续线定夺，与包版本无关。
    // 不声明任何 commands/permissions（R5：v1 无自定义命令面）。
    // prefix 对齐 Java 薄壳的 [KuroBridge] logger 前缀契约（core/node 日志行都按此前缀收敛）。
    prefix = "KuroBridge";
    description = "KuroBridge BE thin shell: endstone event bridge to embedded Node child process";
}
