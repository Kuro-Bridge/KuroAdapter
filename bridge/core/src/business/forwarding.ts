/**
 * 转发规则（纯逻辑，MVP 阶段一）：绑定频道 ⇄ 游戏事件的双向过滤。
 *
 * - 平台 → 游戏：只放行绑定频道（未绑定 → 丢弃，调用方打 debug 日志说明原因）。
 * - 游戏 → 平台：广播到**全部**绑定频道（逐频道一帧；未来按频道/事件类型的
 *   差异化规则在这个模块扩展，Relay 不感知细节）。
 */
import type { PlatformChatBody } from "@kurobot/protocol";

/**
 * 平台消息的转发决策：绑定频道 → 原样放行；未绑定 → null（丢弃）。
 */
export function platformChatTarget(
    channels: readonly string[],
    chat: PlatformChatBody,
): PlatformChatBody | null {
    return channels.includes(chat.channel) ? chat : null;
}

/**
 * 游戏事件（chat/join/leave）的 fan-out 目标频道列表。
 */
export function gameEventChannels(channels: readonly string[]): readonly string[] {
    return channels;
}
