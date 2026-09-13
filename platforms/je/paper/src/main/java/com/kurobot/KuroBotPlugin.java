package com.kurobot;

import com.kurobot.core.EmbeddedRuntime;
import com.kurobot.core.KurobotVersions;
import com.kurobot.core.NodeIpc;
import com.kurobot.core.NodeSupervisor;
import com.kurobot.paper.ChatListener;
import com.kurobot.paper.ConnectionListener;
import com.kurobot.paper.KurobotCommand;
import com.kurobot.paper.NodeRequestHandler;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Path;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
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
 *       随后组装 {@link NodeSupervisor} 看护器（DEBT-2：异常退出按 1s/5s/15s 退避自动重启，
 *       10 分钟窗口累计 3 次失败放弃）并注册监听器与命令（两者均容忍无 IPC）。</li>
 *   <li>onDisable：{@code supervisor.stop("plugin disable")}——停看护（取消挂起的重启）+
 *       优雅关停 Node（:core 内部有界等待 + destroyForcibly 兜底，允许在 disable 期阻塞
 *       主线程，决策 D-08）。</li>
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
 * 上会得到另一个目录（MVP2-NOTES 取舍记录）。PID 文件 {@code plugins/kurobot/node.pid}
 * 同基（DEBT-2 进程卫生，写入/清理语义见 NodeIpc）。
 */
public final class KuroBotPlugin extends JavaPlugin {
    private static final String ENV_NODE = "KUROBOT_NODE";
    private static final String ENV_BUNDLE = "KUROBOT_BUNDLE";
    private static final String ENV_STUB_PEER = "KUROBOT_STUB_PEER";
    private static final String DEFAULT_NODE = "node";
    private static final String PID_FILE_RELATIVE = "node.pid";
    /** 开发覆盖模式下无 manifest，node 版本以 dev 标识（就绪汇总行展示用）。 */
    private static final String NODE_VERSION_DEV = "dev";
    /**
     * 相对 bundle 父目录（dist/）的 stub 位置：dist/../stub/peer.mjs → embedded/stub/peer.mjs。
     * 注意 Java 的 Path.resolve 是纯字符串拼接，必须以 getParent() 为基准，否则
     * 「index.mjs/..」会消掉文件名而不是 dist 目录（sandbox 实测踩坑）。
     */
    private static final String DEFAULT_STUB_RELATIVE = "../stub/peer.mjs";

    /** volatile：AsyncChat 事件线程 / IPC 回调线程会跨线程读取；null = 开发模式或已 disable。 */
    private volatile NodeIpc ipc;
    /** volatile：看护器与专用调度器；null = 无 IPC 模式（解压失败/未配置）或已 disable。 */
    private volatile NodeSupervisor supervisor;

    private volatile ScheduledExecutorService supervisorExecutor;

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
            startSupervised(bundle, envOrDefault(ENV_NODE, DEFAULT_NODE), stub, NODE_VERSION_DEV);
        }
        Bukkit.getPluginManager().registerEvents(new ChatListener(this), this);
        Bukkit.getPluginManager().registerEvents(new ConnectionListener(this), this);
        // paper-plugin.yml 不支持 commands 声明，经 Paper 提供的 CommandMap 直接注册（无需反射）
        Bukkit.getCommandMap().register("kurobot", new KurobotCommand(this));
    }

    @Override
    public void onDisable() {
        NodeSupervisor current = supervisor;
        supervisor = null;
        ScheduledExecutorService executor = supervisorExecutor;
        supervisorExecutor = null;
        if (current != null) {
            current.stop("plugin disable");
        }
        if (executor != null) {
            executor.shutdownNow();
        }
        ipc = null;
    }

    /** JAR 自含模式：解压/复用 embedded 运行时后经看护器拉起（失败 → SEVERE + 无 IPC 降级）。 */
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
        startSupervised(
                installed.bundle(),
                envOrDefault(ENV_NODE, installed.nodeExecutable().toString()),
                stub,
                installed.nodeVersion());
    }

    /**
     * 组装看护器并拉起 Node 子进程。onEnable 主线程只发起 start（spawn 在 :core 内完成，
     * 进程拉起本身非阻塞）并挂回调，等待 ready 完全异步；异常退出后由看护器按退避自动重启
     * （每次重启新建 NodeIpc，factory 内更新 volatile {@link #ipc}——监听器/命令自动指向新实例）。
     *
     * @param bundle esbuild 单文件 bundle 路径
     * @param nodeExecutable node 可执行文件路径
     * @param stub stub 协议端脚本路径（写入 KUROBOT_STUB_PEER）；null = 不注入
     * @param nodeVersion 就绪汇总行展示用（JAR 模式取 manifest，开发覆盖为 dev）
     */
    private void startSupervised(Path bundle, String nodeExecutable, String stub, String nodeVersion) {
        Path pidFile = Path.of("plugins", "kurobot")
                .resolve(PID_FILE_RELATIVE)
                .toAbsolutePath()
                .normalize();
        ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(
                Thread.ofVirtual().name("kurobot-supervisor").factory());
        NodeSupervisor.DelayScheduler delayScheduler = (delayMs, task) -> {
            ScheduledFuture<?> future = executor.schedule(task, delayMs, TimeUnit.MILLISECONDS);
            return () -> future.cancel(false);
        };
        String stubPath = stub == null || stub.isBlank() ? null : stub;
        NodeRequestHandler handler = new NodeRequestHandler(this);
        NodeSupervisor created = new NodeSupervisor(
                observed -> {
                    NodeIpc instance = new NodeIpc(
                            nodeExecutable,
                            bundle,
                            stubPath == null ? null : Path.of(stubPath),
                            observed,
                            line -> relayIpcLog(getLogger(), line));
                    instance.setPidFile(pidFile);
                    ipc = instance;
                    return instance;
                },
                handler,
                line -> relayIpcLog(getLogger(), line),
                delayScheduler,
                NodeSupervisor.Options.defaults());
        supervisor = created;
        supervisorExecutor = executor;
        this.nodeVersion = nodeVersion;
        created.start();
    }

    /** Node ready 回调（IPC 读取线程）：消费 autoRestart 看护开关 + 输出就绪与汇总日志。 */
    public void onNodeReady(int wsPort, boolean autoRestart) {
        NodeSupervisor current = supervisor;
        if (current != null) {
            current.setAutoRestart(autoRestart);
        }
        getLogger().info("Node 子进程就绪，WS 端口 " + wsPort + "（autoRestart=" + autoRestart + "）");
        // 版本来源：插件=paper-plugin.yml；node=manifest（开发覆盖为 dev）；协议=:core 硬编码副本。
        // 「[KuroBot]」前缀由插件 logger 自动附加（M2-11：手写会双前缀）
        getLogger()
                .info(() -> "就绪：插件 v" + getPluginMeta().getVersion() + " / node v" + nodeVersion + " / 协议 v"
                        + KurobotVersions.PROTOCOL_VERSION);
    }

    /** 当前 IPC 客户端；无 IPC 模式（解压失败/未配置）或已 disable 时为 null。 */
    public NodeIpc getIpc() {
        return ipc;
    }

    /** 看护器是否已进入放弃终态（KurobotCommand 报错文案用）；null 安全。 */
    public boolean isSupervisorGivenUp() {
        NodeSupervisor current = supervisor;
        return current != null && current.isGivenUp();
    }

    /** 就绪汇总行的 node 版本（JAR 模式 = manifest 值，开发覆盖 = dev）。 */
    private volatile String nodeVersion = NODE_VERSION_DEV;

    /** :core 日志行中继到插件 logger（行格式 {@code [NodeIpc][LEVEL] 消息}，按前缀分流级别）。 */
    private static void relayIpcLog(Logger logger, String line) {
        if (line.startsWith("[NodeIpc][WARN]") || line.startsWith("[NodeSupervisor][WARN]")) {
            logger.warning(line);
        } else if (line.startsWith("[NodeSupervisor][SEVERE]")) {
            logger.severe(line);
        } else {
            logger.info(line);
        }
    }

    private static String envOrDefault(String name, String defaultValue) {
        String value = System.getenv(name);
        return (value == null || value.isBlank()) ? defaultValue : value;
    }
}
