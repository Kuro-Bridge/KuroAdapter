package com.kurobridge.fabric;

import com.kurobridge.core.NodeIpc;
import net.minecraft.network.message.SignedMessage;
import net.minecraft.server.network.ServerPlayerEntity;

/**
 * 游戏聊天事件桥接：ServerMessageEvents.CHAT_MESSAGE → 纯文本 → 上报 Node。
 *
 * <p>与 paper 的差异（docs/design.md §3）：fabric 原生无权限节点系统，kurobridge.relay
 * 权限门无法等价实现——v1 全员转发（对齐 paper 权限 default: true 的缺省行为），negate
 * 静音能力缺失，接管计划 = fabric-permission-api。另：CHAT_MESSAGE 亦覆盖玩家执行命令
 * 产生的聊天消息（/me 等），paper 的 AsyncChatEvent 不含——轻微超集，Node 侧按普通聊天
 * 处理，登记不收敛。
 *
 * <p>线程契约：CHAT_MESSAGE 在服务端主线程触发，直接调用 {@link NodeIpc#sendGameChat}
 * 即可（:core 写锁串行，不阻塞主线程）。
 */
final class ChatBridge {

    private ChatBridge() {}

    static void onChatMessage(KuroBridgeMod mod, SignedMessage message, ServerPlayerEntity sender) {
        NodeIpc ipc = mod.getIpc();
        if (ipc == null) {
            return; // 开发模式（未配置 KUROBRIDGE_BUNDLE）/降级：无 IPC，静默跳过
        }
        ipc.sendGameChat(sender.getGameProfile().getName(), message.getContent().getString());
    }
}
