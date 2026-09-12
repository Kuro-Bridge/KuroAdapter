package com.kurobot.core;

/**
 * IPC 请求的结果回执。
 *
 * <p>对 Node 发来的每个请求（broadcast / execute_command），实现方必须恰好调用一次
 * {@link #ok()} 或 {@link #error(String)}；重复调用与通道关闭后的调用会被忽略（仅记告警日志）。
 *
 * <p>线程安全：可在任意线程调用（内部经写锁串行发出响应帧）。
 */
public interface IpcResult {
    /** 请求成功：发出 {@code {"ok":true}} 响应帧。 */
    void ok();

    /**
     * 请求失败：发出 {@code {"ok":false,"error":"..."}} 响应帧。
     *
     * @param error 失败原因；为空时以 "unspecified" 兜底（协议要求 error 非空）
     */
    void error(String error);
}
