package com.kurobridge.core;

import java.lang.reflect.Method;

/**
 * 子进程 PID 读取（Java 8 基线兼容，ADR-038）：{@link Process#pid()} 是 Java 9 API，
 * 老服（1.12.2 / 1.16.5 时代的 Java 8 JVM）上不存在——反射探测，取不到返回 -1
 * （PID 文件特性在 Java 8 宿主上降级为不写，进程管理其余路径不受影响）。
 *
 * <p>结果进程内缓存：PID 方法存在性在单次 JVM 生命周期内不变。
 */
final class PidSupport {

    private static final Method PID_METHOD = lookupPidMethod();

    private PidSupport() {}

    /** 子进程 PID；Java 8 宿主（无 Process.pid）返回 -1。 */
    static long pidOf(Process process) {
        Method method = PID_METHOD;
        if (method == null) {
            return -1L;
        }
        try {
            return (Long) method.invoke(process);
        } catch (RuntimeException | ReflectiveOperationException e) {
            return -1L;
        }
    }

    private static Method lookupPidMethod() {
        try {
            return Process.class.getMethod("pid");
        } catch (NoSuchMethodException java8Host) {
            return null;
        }
    }
}
