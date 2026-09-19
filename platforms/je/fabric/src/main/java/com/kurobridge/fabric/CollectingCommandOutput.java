package com.kurobridge.fabric;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.server.command.CommandOutput;
import net.minecraft.text.Text;

/**
 * 收集型 CommandOutput：execute_command 的输出收集器——把命令的全部反馈文本行收进缓冲，
 * 执行完经 {@link #collectedLines()} 回传 execute_command_result 的 output。
 *
 * <p><b>控制台语义</b>（对齐 paper 的 CollectingCommandSender）：挂在
 * {@code server.getCommandSource()}（level 4，恒过权限）经 withOutput 改道输出——
 * shouldReceiveFeedback / shouldTrackOutput / shouldBroadcastConsoleToOps 恒 true，
 * 与真实控制台一致；所有消息只进本地缓冲，不落服务端控制台。瞬态对象，生命周期 =
 * 单次命令执行（主线程任务内使用，无并发）。
 */
final class CollectingCommandOutput implements CommandOutput {
    private final List<String> lines = new ArrayList<>();

    /** 已收集的输出行（快照；空输出 → 空列表，IpcResult.ok 对空列表不产生 output 字段）。 */
    List<String> collectedLines() {
        return List.copyOf(lines);
    }

    @Override
    public void sendMessage(Text message) {
        lines.add(message.getString());
    }

    @Override
    public boolean shouldReceiveFeedback() {
        return true; // 控制台语义：收全部反馈
    }

    @Override
    public boolean shouldTrackOutput() {
        return true; // 控制台语义：审计类输出同样进缓冲
    }

    @Override
    public boolean shouldBroadcastConsoleToOps() {
        return true; // 控制台语义：/say 等按 console 行为广播给 op，与 paper 等价
    }
}
