package com.kurobot.core;

import java.io.IOException;
import java.util.List;
import java.util.Map;

/**
 * 进程启动抽象（可注入）：默认经 {@link ProcessBuilder} 拉起真实 node，测试用假进程替换。
 *
 * <p>实现必须继承当前环境变量并叠加 {@code extraEnv}（与 {@link #system()} 行为一致），
 * 不重定向 stderr（stderr 逐行中继给 {@link NodeIpcListener#onStderrLine(String)}）。
 */
@FunctionalInterface
public interface ProcessFactory {
    /**
     * 拉起子进程。
     *
     * @param command 完整命令行（如 {@code [node, bundle.js]}）
     * @param extraEnv 需额外注入的环境变量（如 {@code KUROBOT_STUB_PEER}）
     * @throws IOException 拉起失败（找不到可执行文件等）
     */
    Process start(List<String> command, Map<String, String> extraEnv) throws IOException;

    /** 默认实现：ProcessBuilder + 继承当前环境变量再叠加 extraEnv。 */
    static ProcessFactory system() {
        return (command, extraEnv) -> {
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.environment().putAll(extraEnv);
            return builder.start();
        };
    }
}
