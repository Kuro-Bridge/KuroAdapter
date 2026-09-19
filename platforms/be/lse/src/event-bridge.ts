/**
 * 事件桥接：mc.listen 四事件 → IPC 方言事件帧（裁决册 §4.3）；shim 请求
 * （broadcast / execute_command）→ mc.runcmd / runcmdEx 即时回执。
 * 通道未就绪或已停用时事件与请求静默丢弃（对齐 JE ipc==null 语义）；
 * uninstall 只翻标志、不反注册监听（处理器内自判，LSE 无可靠反注册点）。
 */
import type { CommandResultBody } from "@kuro-bridge/protocol";
import {
    encodeBroadcastResult,
    encodeExecuteCommandResult,
    encodeGameChat,
    encodePlayerDeath,
    encodePlayerJoin,
    encodePlayerQuit,
    type HostInbound,
} from "./frames.js";
import type { GameChannel } from "./game-channel.js";
import {
    listenChat,
    listenJoin,
    listenLeft,
    listenPlayerDie,
    runCommand,
    runCommandEx,
} from "./lse-env.js";

/** runcmdEx 输出按行拆分（编码/合流/截断语义待真机，裁决册 §6.3；仅去收尾空行） */
function splitOutputLines(output: string): string[] {
    if (output === "") {
        return [];
    }
    const lines = output
        .split("\n")
        .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    while (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
    }
    return lines;
}

export class EventBridge {
    private active = false;

    install(channel: GameChannel): void {
        if (this.active) {
            return;
        }
        this.active = true;
        const ready = (): boolean => this.active && channel.isOpen;
        listenChat((player, message) => {
            if (!ready()) {
                return;
            }
            channel.send(encodeGameChat(player.realName, message));
        });
        listenJoin((player) => {
            if (!ready()) {
                return;
            }
            channel.send(encodePlayerJoin(player.realName));
        });
        listenLeft((player) => {
            if (!ready()) {
                return;
            }
            channel.send(encodePlayerQuit(player.realName));
        });
        listenPlayerDie((player) => {
            if (!ready()) {
                return;
            }
            channel.send(encodePlayerDeath(player.realName));
        });
        channel.onFrame((frame) => {
            if (!ready()) {
                return;
            }
            this.handleRequest(channel, frame);
        });
    }

    /** 通道断开/看护放弃时停用（事件静默丢弃，不反注册） */
    uninstall(): void {
        this.active = false;
    }

    private handleRequest(channel: GameChannel, frame: HostInbound): void {
        if (frame.type === "broadcast") {
            // 立即回执对齐 JE：say 的呈现与 runcmd 布尔结果都不阻塞回执（裁决册 §4.3）
            runCommand(`say ${frame.body.message}`);
            channel.send(encodeBroadcastResult(frame.id));
            return;
        }
        if (frame.type === "execute_command") {
            channel.send(encodeExecuteCommandResult(frame.id, this.execute(frame.body.command)));
            return;
        }
        // ready 等其他帧在握手层已消费
    }

    /** 执行完回执（对齐 JE v0.3.0）：成功带输出行，异常/失败转 error 体 */
    private execute(command: string): CommandResultBody {
        try {
            const result = runCommandEx(command);
            const output = splitOutputLines(result.output);
            if (!result.success) {
                return { ok: false, error: output.length > 0 ? output.join("\n") : "命令执行失败" };
            }
            return output.length > 0 ? { ok: true, output } : { ok: true };
        } catch (error: unknown) {
            return { ok: false, error: String(error) };
        }
    }
}
