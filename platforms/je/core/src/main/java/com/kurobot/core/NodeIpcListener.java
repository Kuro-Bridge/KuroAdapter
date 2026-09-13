package com.kurobot.core;

/**
 * Node 侧请求与 stderr 的回调。
 *
 * <p><b>线程契约：全部方法在 IPC 读取线程（虚拟线程）上被调用</b>，实现方需自行调度回
 * 服务端主线程后再执行任何 Bukkit API / 命令操作。
 *
 * <p>回调抛出的 RuntimeException 会被 {@link NodeIpc} 捕获并记告警，不会中断 IPC 读取循环。
 */
public interface NodeIpcListener {
    /**
     * Node 引导完成、WS 服务端就绪（ready 事件，仅触发一次；后续重复 ready 帧被忽略）。
     *
     * @param autoRestart 宿主自动重启开关（ready.autoRestart，v0.2.1；Node 未上报时按缺省
     *     true 归一化——:core 已做归一，实现方收到的恒为非 null 语义）
     */
    void onReady(int wsPort, boolean autoRestart);

    /**
     * Node 请求游戏内广播（broadcast 请求）。
     *
     * @param message 广播内容（非空）
     * @param result 结果回执，恰好调用一次 ok()/error(...)
     */
    void onBroadcast(String message, IpcResult result);

    /**
     * Node 请求执行服务器命令（execute_command 请求）。
     *
     * @param command 命令行（非空）
     * @param result 结果回执，恰好调用一次 ok()/error(...)
     */
    void onExecuteCommand(String command, IpcResult result);

    /** 子进程 stderr 的每一行原样中继（Node 侧日志通道）。 */
    void onStderrLine(String line);

    /**
     * 进程退出通知（DEBT-2 看护器输入）：通道拆除且非优雅关停时触发恰好一次
     * （{@link NodeIpc#shutdown(String)} 正常关机路径不触发）。
     *
     * @param exitCode 进程退出码；进程尚未退出（如 stdin 写失败后已被 destroyForcibly）
     *     或退出码不可取时为 null——调用方不得假设非空
     * @param cause 通道拆除原因（"stdout EOF" / "stdin 写入失败" / ready 前断开等）
     */
    void onProcessExited(Integer exitCode, String cause);
}
