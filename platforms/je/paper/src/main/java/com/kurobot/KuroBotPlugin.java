package com.kurobot;

import com.kurobot.core.NodeIpc;
import com.kurobot.paper.ChatListener;
import com.kurobot.paper.ConnectionListener;
import com.kurobot.paper.KurobotCommand;
import com.kurobot.paper.NodeRequestHandler;
import java.nio.file.Path;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.logging.Level;
import java.util.logging.Logger;
import org.bukkit.Bukkit;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * KuroBot Paper 薄壳插件主类（AGENTS.md 硬约束 2：Java 侧零业务，只做 Bukkit 桥接）。
 *
 * <p>生命周期：
 * <ol>
 *   <li>onEnable：按环境变量组装 {@link NodeIpc} 并异步拉起 Node 子进程（start() 返回
 *       future，不阻塞主线程）；随后注册聊天监听器与 /kurobot 命令（两者均容忍无 IPC 的
 *       开发模式）。ready/失败日志在 future 回调（IPC 读取虚拟线程或超时调度线程）中打印，
 *       回调内只做日志与幂等清理，不触碰 Bukkit API。</li>
 *   <li>onDisable：{@code ipc.shutdown("plugin disable")}——:core 内部有界等待（默认 5s）+
 *       destroyForcibly 兜底，允许在 disable 期阻塞主线程（决策 D-08）。</li>
 * </ol>
 *
 * <p>环境变量（ADR-010，stdin/stdout JSON-lines IPC，零端口零配置）：
 * <ul>
 *   <li>{@code KUROBOT_NODE}：node 可执行文件，缺省 "node"。</li>
 *   <li>{@code KUROBOT_BUNDLE}：esbuild 单文件产物（dist/index.mjs）绝对路径；未设置时仅打
 *       告警、跳过子进程拉起（开发模式，插件保持加载但无 IPC）。</li>
 *   <li>{@code KUROBOT_STUB_PEER}：stub 协议端脚本路径；缺省从 bundle 推导
 *       {@code bundle.resolve("../stub/peer.mjs")}。</li>
 * </ul>
 */
public final class KuroBotPlugin extends JavaPlugin {
    private static final String ENV_NODE = "KUROBOT_NODE";
    private static final String ENV_BUNDLE = "KUROBOT_BUNDLE";
    private static final String ENV_STUB_PEER = "KUROBOT_STUB_PEER";
    private static final String DEFAULT_NODE = "node";
    /**
     * 相对 bundle 父目录（dist/）的 stub 位置：dist/../stub/peer.mjs → embedded/stub/peer.mjs。
     * 注意 Java 的 Path.resolve 是纯字符串拼接，必须以 getParent() 为基准，否则
     * 「index.mjs/..」会消掉文件名而不是 dist 目录（sandbox 实测踩坑）。
     */
    private static final String DEFAULT_STUB_RELATIVE = "../stub/peer.mjs";

    /** volatile：AsyncChat 事件线程 / IPC 回调线程会跨线程读取；null = 开发模式或已 disable。 */
    private volatile NodeIpc ipc;

    @Override
    public void onEnable() {
        String bundleEnv = System.getenv(ENV_BUNDLE);
        if (bundleEnv == null || bundleEnv.isBlank()) {
            getLogger().warning("未配置 KUROBOT_BUNDLE，跳过 Node 子进程拉起（开发模式，插件无 IPC）");
        } else {
            startNodeIpc(bundleEnv);
        }
        Bukkit.getPluginManager().registerEvents(new ChatListener(this), this);
        Bukkit.getPluginManager().registerEvents(new ConnectionListener(this), this);
        // paper-plugin.yml 不支持 commands 声明，经 Paper 提供的 CommandMap 直接注册（无需反射）
        Bukkit.getCommandMap().register("kurobot", new KurobotCommand(this));
    }

    @Override
    public void onDisable() {
        NodeIpc current = ipc;
        if (current == null) {
            return;
        }
        ipc = null;
        current.shutdown("plugin disable");
    }

    /**
     * 组装并拉起 Node 子进程。onEnable 主线程只发起 start（spawn 在 :core 内完成，进程拉起
     * 本身非阻塞）并挂回调，等待 ready 完全异步。
     */
    private void startNodeIpc(String bundleEnv) {
        Path bundle = Path.of(bundleEnv);
        String nodeExecutable = envOrDefault(ENV_NODE, DEFAULT_NODE);
        String stub = envOrDefault(
                ENV_STUB_PEER,
                bundle.getParent().resolve(DEFAULT_STUB_RELATIVE).normalize().toString());
        NodeIpc created = new NodeIpc(
                nodeExecutable,
                bundle,
                Path.of(stub),
                new NodeRequestHandler(this),
                line -> relayIpcLog(getLogger(), line));
        ipc = created;
        CompletableFuture<Integer> ready = created.start();
        ready.whenComplete((wsPort, error) -> {
            if (error == null) {
                getLogger().info("[KuroBot] Node 子进程就绪，WS 端口 " + wsPort);
                return;
            }
            Throwable cause = error instanceof CompletionException completion && completion.getCause() != null
                    ? completion.getCause()
                    : error;
            getLogger().log(Level.SEVERE, "[KuroBot] Node 子进程启动失败", cause);
            created.shutdown("start failed"); // 幂等：回收 scheduler 与半启动进程
        });
    }

    /** 当前 IPC 客户端；开发模式（未配置 KUROBOT_BUNDLE）或已 disable 时为 null。 */
    public NodeIpc getIpc() {
        return ipc;
    }

    /** :core 日志行中继到插件 logger（行格式 {@code [NodeIpc][LEVEL] 消息}，按前缀分流级别）。 */
    private static void relayIpcLog(Logger logger, String line) {
        if (line.startsWith("[NodeIpc][WARN]")) {
            logger.warning(line);
        } else {
            logger.info(line);
        }
    }

    private static String envOrDefault(String name, String defaultValue) {
        String value = System.getenv(name);
        return (value == null || value.isBlank()) ? defaultValue : value;
    }
}
