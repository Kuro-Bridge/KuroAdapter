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
    /** Node 引导完成、WS 服务端就绪（ready 事件，仅触发一次；后续重复 ready 帧被忽略）。 */
    void onReady(int wsPort);

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
}
