package com.kurobridge.fabric;

import com.kurobridge.core.EmbeddedRuntime;
import com.kurobridge.core.IpcLogLevels;
import com.kurobridge.core.KurobridgeVersions;
import com.kurobridge.core.NodeIpc;
import com.kurobridge.core.NodeSupervisor;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Path;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * KuroBridge Fabric 薄壳 mod 主类（AGENTS.md 硬约束 2：Java 侧零业务，只做平台桥接）。
 *
 * <p>生命周期（docs/design.md §2）：
 * <ol>
 *   <li>onInitialize（SERVER_STARTING 前）：注册事件监听与 /kurobridge 命令——两者均容忍
 *       无 IPC（paper 同语义）。</li>
 *   <li>SERVER_STARTING：确定 Node 运行时来源——
 *       <ul>
 *         <li>{@code KUROBRIDGE_BUNDLE} 已设 → 开发覆盖（原形态）：环境变量指定 node 与
 *             bundle，stub 缺省从 bundle 相对推导。</li>
 *         <li>未设 → JAR 自含：{@link EmbeddedRuntime} 把 JAR 内 embedded 资源解压/复用到
 *             {@code plugins/kurobridge/bin/}（幂等，sha256 对 manifest）；失败 → SEVERE +
 *             保持加载但无 IPC（降级语义），不崩服。</li>
 *       </ul>
 *       随后组装 {@link NodeSupervisor} 看护器（1s/5s/15s 退避自动重启，10 分钟窗口累计
 *       3 次失败放弃）。</li>
 *   <li>SERVER_STOPPING：{@code supervisor.stop("server stopping")}——停看护 + 优雅关停
 *       Node（:core 内部有界等待 + destroyForcibly 兜底；关停路径在服务端关停窗口允许
 *       阻塞，paper onDisable 决策 D-08 同语义）。</li>
 * </ol>
 *
 * <p>环境变量（ADR-010，stdin/stdout JSON-lines IPC，零端口零配置；语义照抄 :paper）：
 * <ul>
 *   <li>{@code KUROBRIDGE_BUNDLE}：esbuild 单文件产物绝对路径——开发覆盖开关。</li>
 *   <li>{@code KUROBRIDGE_NODE}：node 可执行文件；开发覆盖缺省 "node"，JAR 模式缺省
 *       {@code plugins/kurobridge/bin/node.exe}。</li>
 *   <li>{@code KUROBRIDGE_STUB_PEER}：stub 协议端脚本路径（测试件，不进 JAR）；设置即注入。</li>
 * </ul>
 *
 * <p>目录契约（docs/design.md §7）：bin/PID 文件钉在相对服务器根的
 * {@code plugins/kurobridge/}（cwd = 服务器根）——与 Node 侧 config.json 同基，不用
 * fabric 的 config/ 目录（Node 侧按 paper 时代契约定位，壳侧换目录即制造双权威）。
 */
public final class KuroBridgeMod implements ModInitializer {
    static final Logger LOGGER = LoggerFactory.getLogger("KuroBridge");

    private static final String MOD_ID = "kurobridge";
    private static final String ENV_NODE = "KUROBRIDGE_NODE";
    private static final String ENV_BUNDLE = "KUROBRIDGE_BUNDLE";
    private static final String ENV_STUB_PEER = "KUROBRIDGE_STUB_PEER";
    private static final String DEFAULT_NODE = "node";
    private static final String PID_FILE_RELATIVE = "node.pid";
    /** 开发覆盖模式下无 manifest，node 版本以 dev 标识（就绪汇总行展示用）。 */
    private static final String NODE_VERSION_DEV = "dev";
    /**
     * 相对 bundle 父目录（dist/）的 stub 位置：dist/../stub/peer.mjs → embedded/stub/peer.mjs。
     * Path.resolve 是纯字符串拼接，必须以 getParent() 为基准（paper 实测踩坑记录）。
     */
    private static final String DEFAULT_STUB_RELATIVE = "../stub/peer.mjs";

    /** volatile：IPC 回调线程 / 事件线程跨线程读取；null = 开发模式、降级或已停止。 */
    private volatile NodeIpc ipc;
    /** volatile：看护器与专用调度器；null = 无 IPC 模式或已停止。 */
    private volatile NodeSupervisor supervisor;

    private volatile ScheduledExecutorService supervisorExecutor;
    /** TPS 自测器（SERVER_STOPPING 置 null，逐 tick 喂样见 onInitialize 的 tick 注册）。 */
    private volatile TickRateSampler tickSampler;
    /** 就绪汇总行的 node 版本（JAR 模式 = manifest 值，开发覆盖 = dev）。 */
    private volatile String nodeVersion = NODE_VERSION_DEV;

    @Override
    public void onInitialize() {
        // 生命周期与逐 tick 采样（tickSampler 在 SERVER_STARTING 才就位，注册时容忍 null）
        ServerLifecycleEvents.SERVER_STARTING.register(this::onServerStarting);
        ServerLifecycleEvents.SERVER_STOPPING.register(this::onServerStopping);
        ServerTickEvents.END_SERVER_TICK.register(server -> {
            TickRateSampler sampler = tickSampler;
            if (sampler != null) {
                sampler.onTickEnd(System.nanoTime());
            }
        });
        // 事件桥接与命令注册（均容忍无 IPC；线程契约见各 Bridge 类注释）
        ServerMessageEvents.CHAT_MESSAGE.register(
                (message, sender, params) -> ChatBridge.onChatMessage(this, message, sender));
        ServerPlayConnectionEvents.JOIN.register(
                (handler, packetSender, server) -> ConnectionBridge.onJoin(this, handler, server));
        ServerPlayConnectionEvents.DISCONNECT.register(
                (handler, server) -> ConnectionBridge.onDisconnect(this, handler, server));
        ServerLivingEntityEvents.AFTER_DEATH.register((entity, damageSource) -> DeathBridge.onDeath(this, entity));
        CommandRegistrationCallback.EVENT.register(
                (dispatcher, registryAccess, environment) -> KurobridgeCommand.register(dispatcher, this));
    }

    /** SERVER_STARTING（主线程）：TPS 采样器就位 → 运行时来源判定 → 组装看护器拉起 Node。 */
    private void onServerStarting(MinecraftServer server) {
        tickSampler = new TickRateSampler();
        String bundleEnv = System.getenv(ENV_BUNDLE);
        if (bundleEnv == null || bundleEnv.isBlank()) {
            startFromJar(server);
        } else {
            Path bundle = Path.of(bundleEnv);
            String stub = envOrDefault(
                    ENV_STUB_PEER,
                    bundle.getParent()
                            .resolve(DEFAULT_STUB_RELATIVE)
                            .normalize()
                            .toString());
            startSupervised(server, bundle, envOrDefault(ENV_NODE, DEFAULT_NODE), stub, NODE_VERSION_DEV);
        }
    }

    /** SERVER_STOPPING（主线程）：停看护 + 优雅关停 Node（:core 内有界等待+强杀兜底）。 */
    private void onServerStopping(MinecraftServer server) {
        NodeSupervisor current = supervisor;
        supervisor = null;
        ScheduledExecutorService executor = supervisorExecutor;
        supervisorExecutor = null;
        tickSampler = null;
        if (current != null) {
            current.stop("server stopping");
        }
        if (executor != null) {
            executor.shutdownNow();
        }
        ipc = null;
    }

    /** JAR 自含模式：解压/复用 embedded 运行时后经看护器拉起（失败 → SEVERE + 无 IPC 降级）。 */
    private void startFromJar(MinecraftServer server) {
        Path binDir = Path.of("plugins", "kurobridge", "bin").toAbsolutePath().normalize();
        EmbeddedRuntime.ResourceSource source = name -> {
            InputStream stream = getClass().getClassLoader().getResourceAsStream("embedded/" + name);
            if (stream == null) {
                throw new IOException("JAR 内缺少资源：embedded/" + name);
            }
            return stream;
        };
        EmbeddedRuntime.Installed installed;
        try {
            installed = EmbeddedRuntime.install(binDir, source, LOGGER::info);
        } catch (IOException | RuntimeException e) {
            LOGGER.error("embedded 运行时安装失败，mod 保持加载但无 IPC（降级语义）", e);
            return;
        }
        String stub = System.getenv(ENV_STUB_PEER);
        if (stub == null || stub.isBlank()) {
            LOGGER.info("JAR 解压模式未设置 KUROBRIDGE_STUB_PEER，不拉起 stub（外部协议端形态）");
        }
        startSupervised(
                server,
                installed.bundle(),
                envOrDefault(ENV_NODE, installed.nodeExecutable().toString()),
                stub,
                installed.nodeVersion());
    }

    /**
     * 组装看护器并拉起 Node 子进程。调用线程只发起 start（spawn 在 :core 内完成，非阻塞），
     * 等待 ready 完全异步；异常退出后由看护器按退避自动重启（每次重启新建 NodeIpc，
     * factory 内更新 volatile {@link #ipc}——监听器/命令自动指向新实例）。
     *
     * @param server 主线程调度用（SERVER_STARTING 传入，恒非 null）
     * @param bundle esbuild 单文件 bundle 路径
     * @param nodeExecutable node 可执行文件路径
     * @param stub stub 协议端脚本路径（写入 KUROBRIDGE_STUB_PEER）；null = 不注入
     * @param version 就绪汇总行展示用 node 版本
     */
    private void startSupervised(
            MinecraftServer server, Path bundle, String nodeExecutable, String stub, String version) {
        Path pidFile = Path.of("plugins", "kurobridge")
                .resolve(PID_FILE_RELATIVE)
                .toAbsolutePath()
                .normalize();
        ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(
                Thread.ofVirtual().name("kurobridge-supervisor").factory());
        NodeSupervisor.DelayScheduler delayScheduler = (delayMs, task) -> {
            ScheduledFuture<?> future = executor.schedule(task, delayMs, TimeUnit.MILLISECONDS);
            return () -> future.cancel(false);
        };
        String stubPath = stub == null || stub.isBlank() ? null : stub;
        FabricRequestHandler handler = new FabricRequestHandler(this, server);
        NodeSupervisor created = new NodeSupervisor(
                observed -> {
                    NodeIpc instance = new NodeIpc(
                            nodeExecutable,
                            bundle,
                            stubPath == null ? null : Path.of(stubPath),
                            observed,
                            KuroBridgeMod::relayIpcLog);
                    instance.setPidFile(pidFile);
                    ipc = instance;
                    return instance;
                },
                handler,
                KuroBridgeMod::relayIpcLog,
                delayScheduler,
                NodeSupervisor.Options.defaults());
        supervisor = created;
        supervisorExecutor = executor;
        nodeVersion = version;
        created.start();
    }

    /** Node ready 回调（IPC 读取线程）：消费 autoRestart 看护开关 + 输出就绪与汇总日志。 */
    public void onNodeReady(int wsPort, boolean autoRestart) {
        NodeSupervisor current = supervisor;
        if (current != null) {
            current.setAutoRestart(autoRestart);
        }
        LOGGER.info("Node 子进程就绪，WS 端口 {}（autoRestart={}）", wsPort, autoRestart);
        // 版本来源：mod=fabric.mod.json；node=manifest（开发覆盖为 dev）；协议=:core 硬编码副本
        String modVersion = FabricLoader.getInstance()
                .getModContainer(MOD_ID)
                .map(container -> container.getMetadata().getVersion().getFriendlyString())
                .orElse("?");
        LOGGER.info("就绪：mod v{} / node v{} / 协议 v{}", modVersion, nodeVersion, KurobridgeVersions.PROTOCOL_VERSION);
    }

    /** 当前 IPC 客户端；无 IPC 模式（解压失败/未配置）或已停止时为 null。 */
    public NodeIpc getIpc() {
        return ipc;
    }

    /** 看护器是否已进入放弃终态（/kurobridge 报错文案用）；null 安全。 */
    public boolean isSupervisorGivenUp() {
        NodeSupervisor current = supervisor;
        return current != null && current.isGivenUp();
    }

    /** TPS 自测器；SERVER_STOPPING 后为 null（采样注册处容忍）。 */
    TickRateSampler tickSampler() {
        return tickSampler;
    }

    /** :core 日志行中继到 slf4j（IpcLogLevels 单一解析点定级，ADR-034；JUL→slf4j 机械映射）。 */
    static void relayIpcLog(String line) {
        Level level = IpcLogLevels.parse(line);
        if (level == Level.SEVERE) {
            LOGGER.error(line);
        } else if (level == Level.WARNING) {
            LOGGER.warn(line);
        } else if (level == Level.FINE) {
            LOGGER.debug(line);
        } else {
            LOGGER.info(line);
        }
    }

    private static String envOrDefault(String name, String defaultValue) {
        String value = System.getenv(name);
        return (value == null || value.isBlank()) ? defaultValue : value;
    }
}
