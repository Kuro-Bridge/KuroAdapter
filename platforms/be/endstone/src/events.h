// KuroBridge Endstone 薄壳 / 游戏事件桥接 —— 四类事件 → JSON-lines 出帧。
// 零业务（ADR-020）：回调内只做字段提取 → sendEvent（core 写锁串行写），与 Java 事件
// 线程直发同构；不做服务端操作、不抛异常。字段映射逐字段对齐协议 zod schema
//（@kuro-bridge/protocol 0.4.0 的 IPC 事件帧：game_chat / player_join / player_quit /
// player_death；status 由 join/quit 时机补发）。
//
// 线程约束：chat 事件官方未承诺主线程（docs/feasibility.md §2），回调内只做帧编码 +
// 锁内写；join/quit/death 与 Bukkit 同构在主线程触发，status 快照的服务端查询仅在这两处。

#pragma once

#include <chrono>
#include <string>
#include <string_view>

#include <endstone/plugin/plugin.h>

#include <endstone/event/actor/player_death_event.h>
#include <endstone/event/player/player_chat_event.h>
#include <endstone/event/player/player_join_event.h>
#include <endstone/event/player/player_quit_event.h>

#include "core/node_runtime.h"

namespace kurobridge {

class EventBridge final {
public:
    EventBridge(endstone::Plugin& plugin, core::NodeRuntime& runtime);

    // onEnable 期注册四个事件（缺省优先级 Normal、ignore_cancelled=false，
    // 对齐 Java @EventHandler 缺省：cancelled 事件仍会送达）。
    void registerAll();

private:
    void onChat(endstone::PlayerChatEvent& event);
    void onJoin(endstone::PlayerJoinEvent& event);
    void onQuit(endstone::PlayerQuitEvent& event);
    void onDeath(endstone::PlayerDeathEvent& event);

    // join/quit 共用：仅携带 playerName 的事件帧。
    void sendPlayerNameEvent(std::string_view type, const std::string& playerName);

    // 进出服后的 status 快照（在线数已变化，Node 侧按事件顺序处理即得新值）。
    void sendStatusSnapshot();

    // 当前可用通道；无实例（降级/重启间隙/已停止）为 nullptr，调用方静默跳过。
    core::NodeIpc* currentIpc();

    endstone::Plugin& plugin_;
    core::NodeRuntime& runtime_;
    // status.uptimeSeconds 时基 = 插件启用时刻（Java 用 JVM uptime，差异见 .cpp 注）。
    std::chrono::steady_clock::time_point enabledAt_;
};

}  // namespace kurobridge
