# platforms/je 设计（Gradle 多模块：Java 薄壳）

> 包级设计文档。ADR-019（多模块拆分）、ADR-021（多版本策略）、ADR-010（IPC）、ADR-005（薄壳化）。
> 本文件在 MVP 阶段一首次建立（此前依赖仓库级架构书，未建包级文档——见 MVP1-NOTES）。

## 模块

- `:core`（零 Bukkit API）：`NodeIpc`（子进程管理 + stdin/stdout JSON-lines 客户端）、
  `IpcFrameCodec`（帧编解码，与 bridge/protocol 的 zod schema 逐字段镜像，ADR-008 允许的
  Java 手写 DTO 唯一例外）、`ProcessFactory`（进程启动抽象，测试可注入）、`IpcResult`/
  `NodeIpcListener`（回调契约）。JUnit 5：FakeProcess 替身（30+ 用例）+ 真 node/bundle/stub
  的管道集成测试。
- `:paper`（Paper 1.21.4，compileOnly paper-api）：`KuroBridgePlugin`（生命周期/组装/命令注册）、
  `ChatListener`（AsyncChatEvent → game_chat）、`ConnectionListener`（PlayerJoin/QuitEvent →
  player_join/player_quit + status 快照）、`KurobridgeCommand`（/kurobridge send）、
  `NodeRequestHandler`（Node 请求 → runTask 回主线程执行 + 回执）。**零业务、零单元测试**
  （依赖沙盒验收兜底，MVP-2 债务）。
- `fabric` / `neoforge` / `velocity`：预留骨架（ADR-021 版本矩阵策略）。

## 线程契约（硬约束：IPC 永不阻塞主线程）

- Bukkit 事件（主线程/异步线程）→ `NodeIpc.send*` 直调（:core 写锁串行，线程安全）。
- Node → Java 请求（IPC 读取虚拟线程）→ `runTask` 调度回主线程，入队即回执。

## MVP 阶段一（2026-09-13）

- `NodeIpc.sendGameChat` 返回 boolean（候选 E：通道不可用 → false，上层明确反馈）；
  新增 `sendPlayerJoin` / `sendPlayerQuit` / `sendStatus`（同模式）。
- `ProcessFactory.start` 增第三参 workingDirectory（null = 继承 cwd = 服务器根，Node 侧据此
  定位 plugins/kurobridge/config.json）；`NodeIpc.setWorkingDirectory` 包内可见（start 前调用），
  集成测试用 @TempDir 预置绑定配置。
- status 快照取数：TPS=`Bukkit.getTPS()[0]`（clamp≥0 保留 1 位小数）、在线数=
  `Bukkit.getOnlinePlayers().size()`、uptime=`ManagementFactory`（JVM uptime，JDK 标准接口）。
  推送时机 = 玩家进出服（在线数变化点），零业务（频道 fan-out 在 Node 侧）。

## MVP 阶段二（2026-09-13）：打包闭环

> 任务书：`docs/MVP2-PROMPT.md`。目标：JAR 自含 Node 运行时，装上就能用（不再依赖
> `KUROBRIDGE_NODE`/`KUROBRIDGE_BUNDLE` 环境变量）。

### scripts/embed 打包工具（产物契约）

`scripts/embed.ts`（Node 脚本，只用内置依赖；Node ≥23.6 原生 TS 剥离直接跑，无需编译）：

- 下载 node-v26.7.0-win-x64.zip（nodejs.org 官方 dist）+ SHASUMS256.txt sha256 校验；
  本地缓存 `.cache/node-dist/`（gitignored）。镜像/缓存可经环境变量覆盖：
  `KUROBRIDGE_NODE_DIST_BASE`（默认 `https://nodejs.org/dist`）、`KUROBRIDGE_NODE_CACHE_DIR`。
- 只取 zip 内 `node.exe` + `LICENSE`（手写最小 zip 读取器：EOCD→中央目录→本地头，
  stored/deflate 两法 + crc32 校验；不支持 zip64——产物 <4GB），连同
  `bridge/embedded/dist/index.mjs` 产出到 `platforms/je/paper/src/main/resources/embedded/`：
  `node.exe`、`index.mjs`、`NODE_LICENSE`、`manifest.json`。
- `manifest.json`：`{"nodeVersion":"26.7.0","files":{名字: sha256}}` —— 运行期比对的 SSOT。
- 幂等：产物已存在且 sha256 一致 → 跳过；写盘走 tmp+rename 原子替换。
- 纯逻辑（shasums 解析 / zip 读取 / 产物规划）配 vitest（`scripts/embed.test.ts`，
  下载器可注入，测试不发真网）。

### :paper 运行期解压加载链（EmbeddedRuntime，放 :core）

新增 `:core` 类 `EmbeddedRuntime`（零 Bukkit API，可 JUnit——放 :core 的原因：Jackson 已是
其 implementation 依赖且测试设施现成；:paper 主类只组装）：

- 输入：bin 目录 + 资源源（`name → InputStream`，:paper 注入 classloader）+ 日志消费者。
- 读 `embedded/manifest.json` → 逐文件：磁盘存在且 sha256 与 manifest 一致 → 复用；
  缺失或哈希不符（版本升级/损坏）→ 从 JAR 资源流解压（tmp + 原子 move，拷贝中
  DigestInputStream 校验 sha）。三条路径均落 INFO 日志（验收靠 grep）。
- **防 zip slip**：按固定名读资源（不枚举 zip entry，无 entry 名注入面）；manifest 的文件名
  必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]*`（单段、无路径分隔符、无 `..`），解析后的目标路径
  normalize 后必须仍在 bin 目录内（双保险）；**名字校验整体前置**——任何越权名在触碰磁盘前
  拒绝整个 manifest（JUnit 断言零落盘）。
- **bin 目录推导**（:paper 侧）：相对服务器根的 `plugins/kurobridge/bin/`（小写 kurobridge，
  与 Node 侧 `plugins/kurobridge/config.json` 同基）。**不用 getDataFolder()**——
  paper-plugin.yml 的 name 是 `KuroBridge`，大小写敏感文件系统上会得到 `plugins/KuroBridge/`
  两个目录。两侧统一以 cwd（=服务器根）为基准推导，语义对称。
- 解压失败 → SEVERE 日志 + 插件保持加载但无 IPC（对齐既有「开发模式」降级语义），不崩服。
- 在 onEnable（STARTUP）同步执行：首启约 1-2s（85MB 哈希+拷贝），后续启动走复用路径；
  换来加载顺序天然正确（解压完才拉进程）。node.exe 只在启动路径解压（必然未运行，
  无文件占用问题），不做运行期覆盖。

### 环境变量优先级（KUROBRIDGE_NODE/KUROBRIDGE_BUNDLE 保留为开发覆盖）

| 场景 | node 可执行 | bundle | stub |
|---|---|---|---|
| `KUROBRIDGE_BUNDLE` 已设（开发覆盖） | `KUROBRIDGE_NODE` 缺省 `"node"`（现状） | 环境变量值 | env → bundle 相对推导（现状） |
| 未设（JAR 模式） | `KUROBRIDGE_NODE` 缺省 `bin/node.exe` | `bin/index.mjs` | env → **无**（INFO 说明，外部协议端形态） |

`KUROBRIDGE_STUB_PEER` 语义不变；stub 不进 JAR（测试件），沙盒继续经它指向仓库内 stub。

### 沙盒脚本

`scripts/paper-start.sh`：不再强制导出 `KUROBRIDGE_NODE`/`KUROBRIDGE_BUNDLE`（保留透传能力），
补 `KUROBRIDGE_STUB_PEER` 缺省值（仓库内 stub 路径）——验收「JAR 真装路径」。

## 债务清偿二（DEBT-2，2026-09-13）：进程健壮性

> 任务书：`docs/DEBT2-PROMPT.md`。目标：node 死了自动重启（看护器）、进程卫生（PID 文件、
> 退出通知）、就绪可观测（汇总行、升级提示）。本节是动代码前的设计定稿。

### NodeIpc 进程退出通知（:core）

- `NodeIpcListener` 新增 `onProcessExited(Integer exitCode, String cause)`：**通道拆除**
  （既有 `tearDownChannel`，幂等）时通知一次。`exitCode` 可为 null——进程尚未退出
  （如 stdin 写失败但进程存活，此时 NodeIpc 先 `destroyForcibly()` 防双进程）或退出码
  不可取；`cause` 为 teardown 原因（"stdout EOF" / "stdin 写入失败" / "shutdown(...)"）。
- **优雅关停不发退出通知**：`shutdown()` 设 graceful 标记后走同一条 teardown链，
  看护器不应被正常关机触发（回调仍会发给 listener，由看护器的停止状态忽略——双保险）。
- 线程契约不变：回调在既有 IPC 读取线程（stdout 循环）语义上执行。

### NodeSupervisor 看护器（:core，零 Bukkit API，可 JUnit）

- **职责边界**：进程管理（宿主职责），不碰业务。输入是退出通知，输出是重启动作或放弃。
- 构造注入：`NodeIpcFactory`（每次重启新建 NodeIpc 实例——NodeIpc 一次性设计，`start()`
  只能成功一次）、listener、log、`SleepScheduler` 函数接口（`(delayMs, runnable) -> cancel`，
  :paper 给 `ScheduledExecutorService`，测试给同步/手动实现）、`SupervisorOptions`
  （`autoRestart` 缺省 true、退避档位、窗口参数，测试可缩短）。
- **状态机**：`running → restarting → running → …`；终态两个：`stopped`（onDisable，
  取消挂起的重启定时器）与 `given-up`（放弃，服务器不崩、send 明确报错）。
- **退避与放弃**：连续失败计数（成功 ready 后归零——进程稳定运行视为恢复）→ 退避
  1s → 5s → 15s（封顶）。**放弃判定独立于退避**：滑动 10 分钟窗口内累计失败 ≥3 次
  （失败时间戳入窗口，重启成功不擦除窗口——「累计」而非「连续」）→ SEVERE 放弃，
  日志提示手动恢复路径（重启服务器或 `/reload confirm` 重载插件）。
- **重启动作**：经 factory 新建 NodeIpc → 注入 pid 文件路径（同上一实例）→ `start()`。
  `autoRestart=false`：退出通知仅 INFO 日志，不重启（验收 §4.3 的 false 分支）。
- 退避间隔计算抽纯函数 `backoffDelayMs(consecutiveFailures)` 供 JUnit 直接断言。

### PID 文件（:core NodeIpc 承担）

- `setPidFile(Path)`（public，start 前调用；null = 不启用）→ spawn 成功即写 winpid
  （`Process.pid()`）到 `plugins/kurobridge/node.pid`（路径由 :paper 传入）。
- **优雅关停删除**（shutdown 内，waitForExit 之后）；**异常退出（teardown）不删**——
  残留正是「上次可能异常退出」的证据：下次 spawn 前发现残留文件 → INFO 提示。
- 明确不做（任务书 §1.2 拍板）：跨进程互斥/防双实例——Paper 插件单实例由容器保证。

### ready.autoRestart 契约（本册唯一协议变更）

- 协议版本 0.2.0 → **0.2.1**（patch 顺延；DEBT-1 未执行，按实际基线）。
- `ready` body 加**可选**字段 `autoRestart: boolean`（缺省 true）：schema 与默认值都在
  Node 侧（业务配置 SSOT），Java 只消费宿主参数——与 wsPort 同性质，不违反「Java 不做业务」。
- Java 侧 `InboundFrame.Ready` 加 `Boolean autoRestart()`（Jackson 镜像，缺省 null →
  消费方按 true 处理）；:paper 据此设看护器开关。
- 旧 Node（不发该字段）在新 Java 下行为不变（null → true），前向兼容。

### :paper 接线与可观测

- `KuroBridgePlugin.startNodeIpc` 改为组装 `NodeSupervisor`（factory 闭包内更新 volatile
  `ipc` 字段——重启后监听器/命令自动指向新实例）；`onDisable` 先 `supervisor.stop()`
  再 `ipc.shutdown("plugin disable")`。
- **就绪汇总行**：ready 回调后输出一行 `就绪：插件 vX / node vY / 协议 vZ`。版本来源：
  插件版本 = paper-plugin.yml 的 version（`getPluginMeta()`）；node 版本 = JAR 模式取
  `EmbeddedRuntime.Installed.nodeVersion()`（install 结果新增），开发覆盖模式无 manifest
  → 显示 `dev`（D2 决策记录）；协议版本 = :core 常量 `KurobridgeVersions.PROTOCOL_VERSION`
  （**硬编码副本**，唯一维护约束：改协议版本须同步，测试对齐 stub 断言兜底）。
- **升级提示**：`EmbeddedRuntime` 哈希不符重建路径的日志文案改为
  「检测到打包内容变更（升级），已重建 plugins/kurobridge/bin/<名>」。

### 实现回填（相对本节设计的差异，2026-09-13 验收后）

- **onReady 签名**：`NodeIpcListener.onReady(int wsPort, boolean autoRestart)`——
  ready.autoRestart 在 NodeIpc.handleReady 归一化（null→true，兼容旧 Node）后随回调
  下发；设计里「Ready record 加 Boolean」的形状落位为接口签名（KuroBridgePlugin.onNodeReady
  消费，setAutoRestart 更新看护器）。放弃 start future 携带（保持
  `CompletableFuture<Integer>` 形状）。
- **teardown 链扩充**：非优雅拆除（stdout EOF / stdin 写失败）时——存活进程
  destroyForcibly（防看护器重启出双进程）+ `scheduler.shutdownNow()` 就地释放（异常
  路径无人调 shutdown，否则每次崩溃泄漏一个调度器线程）。优雅路径行为不变。
- **看护器接线**：:paper 专用虚拟线程 ScheduledExecutorService 适配 DelayScheduler；
  :core 日志行 `[NodeSupervisor][SEVERE]` 由 relayIpcLog 分流到 logger.severe（既有
  `[NodeIpc][WARN]` 分流同款）。KurobridgeCommand 在 given-up 时返回专属报错文案。
- **重要发现（影响孤儿治理定位）**：Node 26（libuv）Windows 下子进程随父级联死亡——
  taskkill 强杀 node 后 stub 立即消失（sandbox+最小环境双实测），MVP1 的「stub 无限
  重连孤儿」不再出现；stub 重连上限退居纵深防御（DEBT2-NOTES 发现 A）。
- **沙盒复现手段**：`KUROBRIDGE_NODE=<坏路径>` 经 paper-start.sh 透传注入 → 6s 走完
  3 次失败 → SEVERE 放弃（放弃终态的沙盒验证路径）。

### :paper 单元测试政策

维持「不引 MockBukkit」；看护器/退避/PID 的可测逻辑全部落在 :core（NodeSupervisorTest、
NodeIpcTest 扩展），:paper 仍靠沙盒验收兜底。

## 债务清偿一（DEBT-1，2026-09-13）：player_death / 输出收集 / reload / relay 权限

> 任务书：`docs/DEBT1-PROMPT.md` §3 阶段 4。在 DEBT-2 重构后的 NodeIpc/看护器形状上实现
> （复跑指引 5）。协议版本硬编码副本同步 0.3.0。

### :core IPC 扩展（零 Bukkit API）

- 出帧新增：`sendPlayerDeath(player, message)`（message 允许空串——Bukkit deathMessage
  可为 null，空串兜底）与 `sendConfigReload()`（空 body 事件帧，语义对齐 shutdown 的
  单向通知——不做 Java→Node 请求-响应机制）。
- `execute_command_result` 增可选 `output: string[]`：`InboundFrame.Result` 增 `output`
  字段（仅 execute_command_result 解析，broadcast_result 不解析——镜像 Node 侧 zod 的
  按帧型校验）；`NodeIpc.executeCommand` 返回类型升级 `CompletableFuture<Void>` →
  `CompletableFuture<List<String>>`（ok → 输出行，null 归一空列表；!ok → IpcException，
  语义对齐 broadcast）。
- `IpcResult` 回执扩展：`ok()` 改为 default 委托 `ok(List<String> output)`；null/空列表
  不产生 output 字段（协议：空输出不产生字段）。

### :paper

- `DeathListener`（新）：`PlayerDeathEvent` → deathMessage plain 序列化（null → ""）→
  `sendPlayerDeath`；fan-out 归 Node 侧绑定表（零业务）。
- `NodeRequestHandler.onExecuteCommand` 升级：从「调度成功即 ok」改为——主线程任务内以
  **CollectingCommandSender**（:paper 新类，实现 CommandSender：收集全部 sendMessage
  变体的文本行；权限判定恒 true = 控制台语义，与原 ConsoleSender 等价）执行命令，执行完
  `result.ok(output)`。回执时序变化：Node 侧等待真实执行完成（主线程卡死 >10s 走既有
  IPC 请求超时）。
- `KurobridgeCommand` 增 `reload` 子命令（kurobridge.admin）→ `sendConfigReload()` → 即时回
  「已通知重载」；重载效果（绑定变更推送）由 Node 侧 bindings_updated 路径体现。
- `ChatListener` 增 `kurobridge.relay` 权限检查：false → 该玩家聊天不上报（default: true
  既有声明不变，negate 即静音语义）；paper-plugin.yml 补注释说明。

### 测试政策

:core JUnit 补 codec 新帧编解码 / Result.output 解析 / executeCommand 输出 future；
:paper 维持零单测（沙盒验收兜底），CollectingCommandSender 行为在沙盒 §4.4 验证。

### 实际差异回填（沙盒验收期发现，D1-04）

设计时假设自定义 CommandSender 可承接全部命令——实测 **Paper 的
`VanillaCommandWrapper.getListener` 只认内部 Craft* sender 类型**，vanilla 命令
（whitelist/say 等）对自定义 sender 一律抛 "Cannot make ... a vanilla command listener"
（Bukkit/插件命令不受影响）。落地为双路径：Bukkit 命令经 CollectingCommandSender 直接
收集；vanilla 命令回退真实 console sender 执行，输出由 **VanillaFeedbackCapture**
（:paper 新类，log4j root logger 临时 appender，仅收 `Server thread` 在 attach/detach
窗口内的行——vanilla 反馈必然经 DedicatedServer.sendMessage 落日志流）收集。为此 :paper
新增 `compileOnly log4j-core`（运行期由服务端自带）。放弃 ProxiedNativeCommandSender
动态代理：该接口暴露 NMS 类型，违背 paper-api 单 jar 通吃红线。 §4.5 验收证据：
`whitelist list` → `output=[There are 1 whitelisted player(s): FakePlayer]`。

## 已知坑（详见 PROTOTYPE-NOTES / MVP1-NOTES）

- Spotless palantir 钉 2.71.0（JDK 25 兼容线）；`-Xlint:all -Werror`。
- Shadow 9：fat jar 用 `:paper:shadowJar`（不挂 assemble）。
- gradlew 输出经管道（`| tail`）会挂起客户端——输出重定向到文件再读（MVP1-NOTES M-18）。
- paper-plugin.yml 不支持 commands 声明 → CommandMap 运行期注册。
