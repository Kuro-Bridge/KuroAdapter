package com.kurobot;

import com.kurobot.core.EmbeddedRuntime;
import com.kurobot.core.NodeIpc;
import com.kurobot.paper.ChatListener;
import com.kurobot.paper.ConnectionListener;
import com.kurobot.paper.KurobotCommand;
import com.kurobot.paper.NodeRequestHandler;
import java.io.IOException;
import java.io.InputStream;
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
 *   <li>onEnable：确定 Node 运行时来源（MVP 阶段二）——
 *       <ul>
 *         <li>{@code KUROBOT_BUNDLE} 已设 → 开发覆盖（原形态）：环境变量指定 node 与 bundle，
 *             stub 缺省从 bundle 相对推导。</li>
 *         <li>未设 → JAR 自含：{@link EmbeddedRuntime} 把 JAR 内 embedded 资源解压/复用到
 *             {@code plugins/kurobot/bin/}（幂等，sha256 对 manifest），node 用解压出的
 *             node.exe。解压在 onEnable 同步执行（STARTUP 期，首启约 1-2s，换取加载顺序天然
 *             正确）；失败 → SEVERE + 插件保持加载但无 IPC（开发模式降级语义），不崩服。</li>
 *       </ul>
 *       随后异步拉起 Node 子进程（start() 返回 future，不阻塞主线程）并注册监听器与命令
 *       （两者均容忍无 IPC）。</li>
 *   <li>onDisable：{@code ipc.shutdown("plugin disable")}——:core 内部有界等待（默认 5s）+
 *       destroyForcibly 兜底，允许在 disable 期阻塞主线程（决策 D-08）。</li>
 * </ol>
 *
 * <p>环境变量（ADR-010，stdin/stdout JSON-lines IPC，零端口零配置）：
 * <ul>
 *   <li>{@code KUROBOT_BUNDLE}：esbuild 单文件产物绝对路径——开发覆盖开关；设置后完全走
 *       环境变量形态，不触碰 JAR 解压。</li>
 *   <li>{@code KUROBOT_NODE}：node 可执行文件；开发覆盖缺省 "node"，JAR 模式缺省
 *       {@code plugins/kurobot/bin/node.exe}。</li>
 *   <li>{@code KUROBOT_STUB_PEER}：stub 协议端脚本路径（测试件，不进 JAR）；设置即注入。
 *       未设置时：开发覆盖从 bundle 相对推导缺省值，JAR 模式无 stub（外部协议端形态）。</li>
 * </ul>
 *
 * <p>bin 目录推导：相对服务器根的 {@code plugins/kurobot/bin/}（小写 kurobot，与 Node 侧
 * 配置目录 {@code plugins/kurobot/config.json} 同基，均以 cwd=服务器根 为基准）。不用
 * {@code getDataFolder()}——paper-plugin.yml 的 name 是 {@code KuroBot}，大小写敏感文件系统
 * 上会得到另一个目录（MVP2-NOTES 取舍记录）。
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
            startFromJar();
        } else {
            Path bundle = Path.of(bundleEnv);
            String stub = envOrDefault(
                    ENV_STUB_PEER,
                    bundle.getParent()
                            .resolve(DEFAULT_STUB_RELATIVE)
                            .normalize()
                            .toString());
            startNodeIpc(bundle, envOrDefault(ENV_NODE, DEFAULT_NODE), stub);
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

    /** JAR 自含模式：解压/复用 embedded 运行时后拉起（失败 → SEVERE + 无 IPC 降级）。 */
    private void startFromJar() {
        Path binDir = Path.of("plugins", "kurobot", "bin").toAbsolutePath().normalize();
        EmbeddedRuntime.ResourceSource source = name -> {
            InputStream stream = getClass().getClassLoader().getResourceAsStream("embedded/" + name);
            if (stream == null) {
                throw new IOException("JAR 内缺少资源：embedded/" + name);
            }
            return stream;
        };
        EmbeddedRuntime.Installed installed;
        try {
            installed = EmbeddedRuntime.install(
                    binDir, source, message -> getLogger().info(message));
        } catch (IOException | RuntimeException e) {
            getLogger().log(Level.SEVERE, "embedded 运行时安装失败，插件保持加载但无 IPC（降级语义）", e);
            return;
        }
        String stub = System.getenv(ENV_STUB_PEER);
        if (stub == null || stub.isBlank()) {
            getLogger().info("JAR 解压模式未设置 KUROBOT_STUB_PEER，不拉起 stub（外部协议端形态）");
        }
        startNodeIpc(
                installed.bundle(),
                envOrDefault(ENV_NODE, installed.nodeExecutable().toString()),
                stub);
    }

    /**
     * 组装并拉起 Node 子进程。onEnable 主线程只发起 start（spawn 在 :core 内完成，进程拉起
     * 本身非阻塞）并挂回调，等待 ready 完全异步。
     *
     * @param bundle esbuild 单文件 bundle 路径
     * @param nodeExecutable node 可执行文件路径
     * @param stub stub 协议端脚本路径（写入 KUROBOT_STUB_PEER）；null = 不注入
     */
    private void startNodeIpc(Path bundle, String nodeExecutable, String stub) {
        NodeIpc created = new NodeIpc(
                nodeExecutable,
                bundle,
                stub == null || stub.isBlank() ? null : Path.of(stub),
                new NodeRequestHandler(this),
                line -> relayIpcLog(getLogger(), line));
        ipc = created;
        CompletableFuture<Integer> ready = created.start();
        ready.whenComplete((wsPort, error) -> {
            if (error == null) {
                getLogger().info("Node 子进程就绪，WS 端口 " + wsPort);
                return;
            }
            Throwable cause = error instanceof CompletionException completion && completion.getCause() != null
                    ? completion.getCause()
                    : error;
            getLogger().log(Level.SEVERE, "Node 子进程启动失败", cause);
            created.shutdown("start failed"); // 幂等：回收 scheduler 与半启动进程
        });
    }

    /** 当前 IPC 客户端；无 IPC 模式（解压失败/未配置）或已 disable 时为 null。 */
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
