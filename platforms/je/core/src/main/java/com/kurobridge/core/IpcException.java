package com.kurobridge.core;

/** IPC 通道 / IPC 请求失败的类型化异常：future 异常完成时的载体，不静默吞错。 */
public class IpcException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    public IpcException(String message) {
        super(message);
    }

    public IpcException(String message, Throwable cause) {
        super(message, cause);
    }
}
