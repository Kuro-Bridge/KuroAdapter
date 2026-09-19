# :fabric 包级设计册（2026-09-19，fabric 首次实现）

Fabric mod 形态薄壳：与 :paper 同构的「MC 服务器 ↔ Node 子进程」桥接。业务在 :core（ADR-021 零 MC API，本线零改动）与 Node 侧（bridge/，本线零改动）；本包只做 Fabric 接插。参照实现 = `platforms/je/paper`，接缝签名以 :core 公开 API 为准（NodeIpc / NodeSupervisor / EmbeddedRuntime / IpcLogLevels / KurobridgeVersions）。

## 1. 版本基线（2026-09-19 查证记录）

| 组件 | 版本 | 依据 |
| --- | --- | --- |
| Minecraft | 1.21.4 | 与 :paper 对齐（任务书裁决） |
| yarn mappings | 1.21.4+build.8 | meta.fabricmc.net /v2/versions/yarn/1.21.4 最新且 recommended |
| fabric-loader | 0.19.5（编译目标）；depends 声明 `>=0.16.0` | meta.fabricmc.net /v2/versions/loader/1.21.4 最新 |
| fabric-api | 0.119.4+1.21.4 | Modrinth API：1.21.4 线最新 release（2025-08-08） |
| fabric-loom | 1.18.2 | maven.fabricmc.net maven-metadata 最新 release；loom 1.11+ 才支持 Gradle 9 |
| Gradle / 工具链 | 9.7.0 wrapper / Java 25 工具链 + release 21 | 继承根配置，不动（与 :paper 同严度） |

loom 只发布在 Fabric maven（Gradle Plugin Portal 无此插件，实测 metadata 404），故 `platforms/je/settings.gradle.kts` 增加 pluginManagement（Fabric maven 优先 + gradlePluginPortal 兜底既有 spotless/shadow）；loom 版本内联在本模块 plugins 块（仅本模块使用，不动根 build.gradle.kts 共享件）。fabric-api/yarn 依赖经本模块 repositories 的 Fabric maven 解析。

**版本矩阵（多 MC 版本）延后登记**：首版单版本基线。接管点：(a) 每 MC 版本一组 minecraft/mappings/fabric-api 坐标（版本目录或独立模块）；(b) fabric.mod.json depends 从 `~1.21.4` 收紧/放宽的策略；(c) CI java job 的版本 matrix。届时按 ADR-021「改 MC 版本 :core 一行不动」验收。

## 2. 生命周期映射与 node 拉起时机（裁决）

| :paper | :fabric | 裁决理由 |
| --- | --- | --- |
| onEnable（STARTUP 期） | `ServerLifecycleEvents.SERVER_STARTING` | 同为「世界加载前、连接未开」的同步窗口：EmbeddedRuntime.install 同步落盘（首启 1-2s）换取与 paper 相同的加载顺序语义；SERVER_STARTED 太晚（玩家可能已在进服路径上） |
| onDisable | `ServerLifecycleEvents.SERVER_STOPPING` | 同为「服务端关停路径」：supervisor.stop 的有界等待+强杀兜底在 :core 内部（shutdownGrace 5s + forceWait 2s），允许阻塞——决策 D-08 语义原样适用 |
| 插件类构造/注册 | `ModInitializer.onInitialize` | 监听器与 /kurobridge 命令在 onInitialize 注册（SERVER_STARTING 前），全部容忍无 IPC（paper 同语义） |

差异登记：SERVER_STOPPING 时点在「网络通道关闭、玩家断开之前」，paper 的 onDisable 在玩家断开之后——Node 收到 shutdown 帧的时机略早，但关停语义（优雅帧 → stdin EOF → 有界等待 → 强杀）不变；真机清单核对项。dedicated server 单 JVM 单周期，与 paper 相同无重入处理。

关停路径等价性（任务书问题 2 的答案）：等价。supervisor.stop("server stopping") → :core NodeIpc.shutdown：写 shutdown 帧 → 关 stdin（Node EOF 自杀）→ waitFor(5s) 有界等待 → destroyForcibly → waitFor(2s) 兜底放弃。全部在 :core 内实现，两平台共用同一段代码，fabric 壳只负责在正确的生命周期点调用。

## 3. 事件映射表（含对齐格数）

| 事件 | :paper | :fabric | 对齐情况 |
| --- | --- | --- | --- |
| chat（relay 门） | AsyncChatEvent + `kurobridge.relay` 权限门 | `ServerMessageEvents.CHAT_MESSAGE`（SignedMessage.getContent().getString()） | **框架对齐、权限门缺失**：fabric 原生无权限节点系统（op 等级制），v1 全员转发（paper 权限 default: true 的缺省行为一致，但 negate 静音能力缺失）。接管计划：引 fabric-permission-api（桥接 kurobridge.relay，default true），登记 §7 真机清单 |
| join/quit + status | PlayerJoinEvent / PlayerQuitEvent | `ServerPlayConnectionEvents.JOIN` / `DISCONNECT`（handler.player.getGameProfile().getName()） | 对齐；join/quit 后各补一帧 status 快照（在线数变化点），与 paper 相同 |
| status 快照 | Bukkit.getTPS()[0]（1 分钟窗）+ online + uptime | TickRateSampler 自测（60s 滑动窗）+ getCurrentPlayerCount() + ManagementFactory uptime | 对齐（语义级）：vanilla 1.21.4 的 `getAverageTickTime()` 仅 100 tick（约 5s）窗，与 paper 1 分钟窗语义不符故弃用；自测窗 60s 对齐 paper。计数公式 (n-1)/跨度 每秒，上限 20、下限 0、1 位小数（与 paper 同式） |
| death | PlayerDeathEvent（deathMessage 可为 null→空串） | `ServerLivingEntityEvents.AFTER_DEATH` + `instanceof ServerPlayerEntity` 过滤；getDamageTracker().getDeathMessage().getString() | 对齐（语义级）：fabric 侧死亡消息恒非 null，空串兜底保留（协议允许 message 空串）；死亡消息措辞与 Bukkit 文案不同（vanilla 原生文案，预期内） |
| /kurobridge send | Command 手工触发入口 | Brigadier 同名命令 | 对齐 |

**对齐格数（任务书问题 1 的答案）**：事件覆盖 5 格（chat / join / quit / death / status）全部落地，其中 3 格完全对齐（join、quit、death），2 格语义级对齐但有登记差异——chat 缺 relay 权限门（fabric 无原生权限节点，v1 全员转发）、status 的 TPS 窗口是自测实现（60s 对齐 paper 1 分钟语义，vanilla 原生 100-tick 窗不足）。另一处口径差异：fabric 的 CHAT_MESSAGE 还覆盖玩家执行命令产生的聊天消息（如 /me），paper 的 AsyncChatEvent 不含——轻微超集，登记不收敛（Node 侧按普通聊天处理，无解析依赖）。

## 4. Node→游戏请求（主线程调度与命令回显）

与 paper 同契约：全部 NodeIpcListener 回调在 :core IPC 读取虚拟线程上，Bukkit 主线程 → fabric 的 MinecraftServer 主线程。

- **broadcast**：`server.execute(() -> server.getPlayerManager().broadcast(Text.literal(message), false))`。PlayerManager.broadcast(Text, boolean) 的 vanilla 语义即「全体玩家 + 服务端控制台」，一步覆盖 Bukkit.broadcast 的等价面；调度失败显式 result.error（Node 不等超时）。
- **execute_command**：`server.execute` 内真实执行完回执——收集型输出 = `CollectingCommandOutput implements CommandOutput`（sendMessage(Text) 收 PlainText，shouldReceiveFeedback/shouldTrackOutput/shouldBroadcastConsoleToOps 恒 true 的控制台语义），source = `server.getCommandSource().withOutput(collector)`（level 4 控制台语义，等价 paper CollectingCommandSender 的恒真权限），`dispatcher.parse` + `dispatcher.execute`；CommandSyntaxException → result.error(原文)，RuntimeException → result.error。**不需要 paper 的 VanillaCommandWrapper 回退路径**：fabric 无 Craft* 类型包装层，自定义 CommandOutput 原生可用，VanillaFeedbackCapture（log4j appender 截控制台流）整体不适用也不需要——两条收集路径在 fabric 合并为一条。登记差异：控制台 source 的命令回执行（如 `-> 1`）可能落服务端控制台日志（ReturnValueConsumer 未定制），无害，真机清单核对。
- **stderr / onProcessExited / onReady**：与 paper 同构；日志级别经 :core IpcLogLevels.parse（ADR-034 单一解析点）后做 JUL→slf4j 机械映射（SEVERE→error、WARNING→warn、FINE→debug、其余 info），映射不新增语义。

## 5. 命令形态（Brigadier，v1 即实现不延后）

`CommandRegistrationCallback` 注册 `/kurobridge send <文本...> | reload | qr`，`requires(hasPermissionLevel(2))`。与 paper 差异登记：paper 用权限节点 kurobridge.admin（default: op），fabric 近似为 op 等级 ≥2——粒度粗于权限节点（op 全通过），与 relay 门同属「fabric 无原生权限系统」根因，同接管计划。send/reload 的「看护放弃」文案与 paper 一致（isGivenUp）。qr 子命令读 `<服务器根>/plugins/kurobridge/qr.json`（Jackson 在包内，零 IPC）。

## 6. 打包路线（裁决）

- **产物链**：`shadowJar`（白名单合并 :core + Jackson 三件，fabric-api/loader 明确不入包）→ `remapJar`（loom，inputFile = shadowJar 产物）→ `build/libs/kurobridge-fabric-0.1.0.jar`。loom 1.18 的 RemapJarTask 主输入属性为 `inputFile`（`input` 为弃用别名）。
- **弃选路线**：loom `include` 嵌套 jar 要求嵌套 jar 本身是 mod（含 fabric.mod.json）；:core 是纯库，加 fabric.mod.json 违反 ADR-021 纯度（宿主不得改造 :core 构建产物），弃。直接 `jar { from(project(":core").sourceSets.main.output) }` 无法合并外部 Jackson jar 内容（无 fat jar 能力），弃。
- **白名单式 include 的原因**：shadow 缺省吞整个 runtimeClasspath（loom 下含 fabric-api/loader 的 mod jar），必须显式只留 :core（group com.kurobridge）与 com.fasterxml.jackson.core 三件。
- **embed 链**：toolings/packaging/embed.ts 的 runEmbed 本已参数化 outDir，硬编码仅在 CLI 入口 runCli——扩展为按目标目录列表循环（paper 与 fabric 各一份同内容产物；第二次调用走 zip/napuketto 缓存，零重复下载）。产物契约不变（manifest.json nodeVersion/files/napukettoZip + sha256），Java 侧 :core EmbeddedRuntime 原样消费。
- **嵌入产物不入库**：paper 用根 .gitignore 先例；fabric 用**嵌套自含 .gitignore**（`fabric/src/main/resources/embedded/.gitignore` 内容 `*` + `!.gitignore`），不动根共享文件。
- **build-jar.mjs**：三步链追加第四步 `:fabric:remapJar`（同 wrapper/UTF-8 环境注入逻辑），最终日志列两产物目录。
- **fabric.mod.json 版本**：`"version": "${version}"` 经 processResources expand 注入 project.version（SSOT = 根 version 族）。原因：check-versions 门禁的版本族不含 fabric.mod.json（门禁文件不在本线领地），硬编码会制造 ADR-034 反对的隐藏版本点；expand 让漂移在构建期不可能发生。depends 声明 `minecraft ~1.21.4`、`fabricloader >=0.16.0`、`java >=21`、`fabric-api *`。

## 7. 目录契约、环境变量与降级语义（照抄 :paper）

- 目录契约：`<服务器根>/plugins/kurobridge/`（bin/、node.pid、qr.json），子进程 cwd = 服务器根。**不用** fabric 的 config/ 目录——Node 侧按 paper 时代契约定位 config.json，壳侧换目录即制造双权威（任务书红线）。
- 三环境变量语义不变：`KUROBRIDGE_BUNDLE` 设=开发覆盖（node 缺省 "node"，stub 从 bundle 相对推导 `../stub/peer.mjs`）；未设=JAR 自含（EmbeddedRuntime.install → bin/node.exe，stub 仅显式注入）；`KUROBRIDGE_NODE` 覆盖 node 路径；`KUROBRIDGE_STUB_PEER` 显式 stub 路径。
- 降级语义：install 失败 → SEVERE 日志 + 插件保持加载但无 IPC，不崩服（paper 同语义）。PID 文件写入/残留提示语义由 :core 承担。

## 8. 单测与验证边界

- 可抽纯逻辑：TickRateSampler（60s 滑动窗、样本 <2 返 20.0 缺省、上限 20、normalizeTps 四舍五入 1 位小数 + 下限 0）——JUnit 直测。其余（生命周期/事件接线/命令）为 fabric 事件 API 接线，按 paper 先例零单测，构建+门禁（spotless palantir 2.71.0、-Xlint:all -Werror、release 21）背书。
- 本线交付到「构建 + 单测 + SOP」为止：`gradlew build`（含 :fabric:test）与 `pnpm check && pnpm test` 全绿；真机（fabric dedicated server 实机）联调明确不做，真机清单进 STATUS 追加块。
