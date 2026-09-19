package com.kurobridge.fabric;

import com.kurobridge.core.NodeIpc;
import net.minecraft.entity.LivingEntity;
import net.minecraft.server.network.ServerPlayerEntity;

/**
 * 玩家死亡事件桥接：ServerLivingEntityEvents.AFTER_DEATH → 死亡消息 plain 化 → 上报 Node。
 *
 * <p>事件覆盖所有 living entity，{@code instanceof ServerPlayerEntity} 过滤后只上报玩家
 * （paper 的 PlayerDeathEvent 天然只有玩家）。死亡消息取
 * {@code getDamageTracker().getDeathMessage()}——与 vanilla 侧广播的死亡消息同源；fabric
 * 侧恒非 null（paper 的 deathMessage 可为 null 以空串兜底的口径由协议保留，这里天然满足
 * 「message 允许空串」）。文案为 vanilla 原生措辞，与 Bukkit 文案不同（预期内差异）。
 *
 * <p>线程契约：AFTER_DEATH 在服务端主线程触发，直接调用 {@link NodeIpc} 发送即可。
 */
final class DeathBridge {

    private DeathBridge() {}

    static void onDeath(KuroBridgeMod mod, LivingEntity entity) {
        if (!(entity instanceof ServerPlayerEntity player)) {
            return; // 只上报玩家死亡
        }
        NodeIpc ipc = mod.getIpc();
        if (ipc == null) {
            return; // 开发模式/降级：无 IPC，静默跳过
        }
        ipc.sendPlayerDeath(
                player.getGameProfile().getName(),
                player.getDamageTracker().getDeathMessage().getString());
    }
}
