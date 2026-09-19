// KuroBridge Endstone 薄壳 / 游戏事件桥接实现。见 events.h 头注。

#include "events.h"

#include <string>
#include <utility>

#include "bridge.h"
#include "core/ipc_frame.h"
#include "core/json.h"

namespace kurobridge {

EventBridge::EventBridge(endstone::Plugin& plugin, core::NodeRuntime& runtime)
    : plugin_(plugin), runtime_(runtime), enabledAt_(std::chrono::steady_clock::now()) {}

void EventBridge::registerAll() {
    plugin_.registerEvent(&EventBridge::onChat, *this);
    plugin_.registerEvent(&EventBridge::onJoin, *this);
    plugin_.registerEvent(&EventBridge::onQuit, *this);
    plugin_.registerEvent(&EventBridge::onDeath, *this);
}

void EventBridge::onChat(endstone::PlayerChatEvent& event) {
    core::NodeIpc* ipc = currentIpc();
    if (ipc == nullptr) {
        return;  // 无 IPC（降级/重启间隙/已停止）：静默跳过（对齐 Java ipc==null）
    }
    const JsonValue body = JsonValue::object({
        {"playerName", JsonValue::string(event.getPlayer().getName())},
        // content = getMessage() 原文直出；v1 无权限门（Java kurobridge.relay 是 paper
        // 特有、fabric 已登记缺失，C++ 同样不做——缺口登记见 docs/design.md）。
        {"content", JsonValue::string(event.getMessage())},
    });
    // 事件 type 字面量对齐协议 zod（ipc_frame.h 只登记入帧目录，出帧事件不设常量）
    ipc->sendEvent("game_chat", body);
}

void EventBridge::onJoin(endstone::PlayerJoinEvent& event) {
    sendPlayerNameEvent("player_join", event.getPlayer().getName());
    sendStatusSnapshot();
}

void EventBridge::onQuit(endstone::PlayerQuitEvent& event) {
    sendPlayerNameEvent("player_quit", event.getPlayer().getName());
    sendStatusSnapshot();
}

void EventBridge::onDeath(endstone::PlayerDeathEvent& event) {
    core::NodeIpc* ipc = currentIpc();
    if (ipc == nullptr) {
        return;
    }
    // getDeathMessage() 为 std::optional<Message>：nullopt（/kill 等无死亡消息）→ 空串
    // 兜底（协议允许 message 为空串，与 playerName min(1) 不同，对齐 Java DeathListener）。
    std::string message;
    if (event.getDeathMessage().has_value()) {
        message = messageToPlainText(plugin_.getServer(), *event.getDeathMessage());
    }
    // 协议字段名即 player（非 playerName，死亡帧命名与 join/quit 不一致已按 SSOT 照办）
    ipc->sendEvent("player_death", JsonValue::object({
                                       {"player", JsonValue::string(event.getPlayer().getName())},
                                       {"message", JsonValue::string(std::move(message))},
                                   }));
}

void EventBridge::sendPlayerNameEvent(std::string_view type, const std::string& playerName) {
    core::NodeIpc* ipc = currentIpc();
    if (ipc == nullptr) {
        return;
    }
    ipc->sendEvent(type, JsonValue::object({{"playerName", JsonValue::string(playerName)}}));
}

void EventBridge::sendStatusSnapshot() {
    core::NodeIpc* ipc = currentIpc();
    if (ipc == nullptr) {
        return;
    }
    // tps 固定 0.0：R2 简化登记（docs/feasibility.md §5——v1 无已证实的 TPS 查询口径，
    // 诚实降级，schema 允许 nonneg），onlinePlayers 真值。
    const int onlinePlayers = static_cast<int>(plugin_.getServer().getOnlinePlayers().size());
    // uptimeSeconds：Java 用 JVM uptime；C++ 用插件启用起的进程内 steady_clock 计时
    //（不依赖进程启动时刻、不受墙钟调整影响；语义差异 = 自插件启用起算，注释登记）。
    const long long uptimeSeconds =
        std::chrono::duration_cast<std::chrono::seconds>(std::chrono::steady_clock::now() - enabledAt_)
            .count();
    ipc->sendEvent("status", JsonValue::object({
                                 {"tps", JsonValue::number(0.0)},
                                 {"onlinePlayers", JsonValue::number(static_cast<double>(onlinePlayers))},
                                 {"uptimeSeconds", JsonValue::number(static_cast<double>(uptimeSeconds))},
                             }));
}

core::NodeIpc* EventBridge::currentIpc() {
    // core 对接缝隙：看护缝暴露的 ManagedIpc 接口不含 sendEvent（事件发送是 NodeIpc 的
    // 具体能力），NodeRuntime 工厂只创建 NodeIpc 实例 → dynamic_cast 收窄，失败即无 IPC。
    // 指针仅限当次发送内使用（实例替换窗口见 bridge.h 头注）。
    return dynamic_cast<core::NodeIpc*>(runtime_.supervisor().currentIpc());
}

}  // namespace kurobridge
