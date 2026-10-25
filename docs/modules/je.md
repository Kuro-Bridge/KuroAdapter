# platforms/je（Java 薄壳）

Gradle 多模块，一个服务端 = 一个模块。Java 只做平台桥接；业务全部在 Node。模块状态：`:core`、`:paper`、`:paper-legacy`、`:fabric` 已实现；`:neoforge`、`:velocity` 为预留骨架（只有空 `build.gradle.kts`）。

## 模块

| 模块 | 依赖 | 产物 | 职责 |
| --- | --- | --- | --- |
| `:core` | Jackson、JDK | `core-0.1.0.jar` | IPC 编解码、进程管理、看护器、JAR 运行时解压；零 Bukkit API |
| `:paper` | `:core`、`:paper-legacy`、paper-api 26.3（compileOnly）、log4j-core（compileOnly）、Jackson | `kurobridge-0.1.0.jar`（shadowJar） | Paper 事件/命令/权限桥接 |
| `:paper-legacy` | paper-api 1.21.4（compileOnly） | 并入 `:paper` shadowJar | 旧 Adventure 序列化器隔离层（ADR-038）：`PlainComponentSerializer` 对 1.21.4 时代 API 编译，现代服缺失时由兼容链回退触碰 |
| `:fabric` | `:core`、fabric-loader / fabric-api（modImplementation）、Jackson | `kurobridge-fabric-0.1.0.jar`（remapJar） | Fabric mod 薄壳 |
| `:neoforge` / `:velocity` | — | 空 jar | 预留 |

工具链：JDK 25 编译，main 源集 `options.release = 8`（ADR-038 universal 基线：1.12.2 ~ 26.3 单 jar；`--release` 同时是 Java 9+ SE API 误用的机器门禁）；`-Xlint:all -Werror`；Spotless Palantir 2.71.0。Gradle 9.7 wrapper。

## :core

| 类 | 职责 |
| --- | --- |
| `NodeIpc` | 拉起 `node <bundle>`、stdin/stdout JSON-lines、ready 等待、请求-响应、PID 文件、双路径关停 |
| `IpcFrameCodec` | 帧编解码，与协议 zod 逐字段一致（Java 手写 DTO 的唯一允许例外） |
| `NodeIpcListener` | 回调契约：`onReady` / `onBroadcast` / `onExecuteCommand` / `onStderrLine` / `onProcessExited` |
| `IpcResult` | 请求回执（`ok(output)` / `error(reason)`），重复调用只认第一次 |
| `NodeSupervisor` | 看护状态机：退避、10 分钟窗累计 3 次放弃、`autoRestart`、手动停止 |
| `EmbeddedRuntime` | JAR 内 `embedded/` → `plugins/kurobridge/bin/` 的幂等解压（sha256 manifest + zip slip 防护 + napuketto zip 展开） |
| `IpcLogLevels` | 日志行 → JUL 级别的单一解析点 |
| `IpcLogLines` | 日志行展示层剥传输前缀（ADR-038）：中继到控制台的最后一跳剥 `[KuroBridge][node][level]` / `[NodeIpc][LEVEL]`，Bukkit logger 自带插件前缀，透传即套娃 |
| `PidSupport` | 跨版本取 PID：反射 `Process.pid()`（Java 9+），Java 8 返回 -1 |
| `KurobridgeVersions` | 协议版本展示副本（门禁与 npm 包 version 对齐） |
| `ProcessFactory` | 进程启动抽象，测试注入替身 |

### NodeIpc 生命周期

1. `start()`：检查残留 PID 文件（仅告警）→ `ProcessFactory.start` → 写 PID → 启动 stdout/stderr 两条命名 daemon 线程（Java 8 基线无虚拟线程，ADR-038）→ 30s ready 超时保护。
2. 运行期：stdout 逐行解码分发（ready / request / result）；stderr 逐行交 `onStderrLine`；写 stdin 加锁串行。
3. `shutdown(reason)`：发 `shutdown` 帧 → 关 stdin → 等 5s → `destroyForcibly()` → 再等 2s → 删 PID。幂等。
4. 非优雅断开（stdout EOF / 写失败）：杀存活进程、拒绝在途请求与 start future、关闭调度器，并发一次 `onProcessExited`（优雅关停不发）。

`broadcast` / `executeCommand` 用 UUID 关联，默认 10s 超时；未知/坏行只告警跳过，不崩进程。

### EmbeddedRuntime

- 逐文件比对 `manifest.json` 的 sha256：一致即复用；缺失/不符才从 JAR 解压（临时文件 + 原子 move，拷贝中校验）。
- manifest 文件名必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]*`，且 normalize 后必须仍在 bin 目录内（防 zip slip，双保险）。
- `manifest.napukettoZip` 存在时，把 `napuketto.zip` 展开到 `bin/napuketto/`；用哨兵 `.kurobridge-install.json` 记录 zip sha256，一致复用，否则删目录重建。
- 失败 → SEVERE，插件保持加载但无 IPC（降级），不崩服。

## :paper

| 类 | 行为 |
| --- | --- |
| `KuroBridgePlugin` | `onEnable`：环境变量覆盖或 JAR 解压 → 组装 `NodeSupervisor` 拉起 node → 注册监听器与命令。`onDisable`：停看护 + 优雅关停 |
| `Compat` | 运行期版本探测（ADR-038）：`AsyncChatEvent` 有无 → 现代或 legacy 聊天监听（不双注册）；Adventure 有无 → Component 或 String 广播 |
| `ChatListener` | `AsyncChatEvent`（Paper 1.19+）→ 纯文本 → `game_chat`；无 `kurobridge.relay` 权限（含 negate）则不转发 |
| `LegacyChatListener` | `AsyncPlayerChatEvent`（1.12.2 ~ 1.18.2）→ `getMessage()` String → `game_chat`；语义同 `ChatListener` |
| `ConnectionListener` | `PlayerJoinEvent` / `PlayerQuitEvent` → `player_join` / `player_quit`；随后补一帧 `status`（TPS / 在线数 / JVM uptime） |
| `DeathListener` | `PlayerDeathEvent` → `player_death`：`getDeathMessage()` String 全版本路径（`deathMessage == null` 时 message 为空串），剥 legacy 颜色码 |
| `Broadcasts` | 广播兼容层：Adventure 存在走 `Bukkit.broadcast(Component)`（隔离在 `ComponentPath`），否则 `Bukkit.broadcastMessage(String)` |
| `NodeRequestHandler` | Node 请求回主线程：`broadcast` 调度后即回执；`execute_command` 执行完回执（收集型 sender，vanilla 命令回退 console + log4j 截流） |
| `KurobridgeCommand` | `/kurobridge send <文本>` / `reload` / `qr`；权限 `kurobridge.admin`（default op）；回执全 String（universal） |
| `CollectingCommandSender` / `VanillaFeedbackCapture` | 命令输出收集、vanilla 反馈捕获 |
| `PlainText` | Component → 纯文本兼容链（ADR-038）：`PlainTextComponentSerializer`（隔离 holder）→ `:paper-legacy` 的旧序列化器回退，首用解析缓存 |

- 命令在 `plugin.yml` 声明（经典清单 1.12.2 ~ 26.3 全版本可加载；`paper-plugin.yml` 是 1.19.4+ 专属格式，ADR-038 弃用），主类 `onCommand` 委派 `KurobridgeCommand`。
- `status` 只在 join/quit 时推送，不是周期上报。
- 就绪后输出汇总行：插件版本 / node 版本 / 协议版本。

## :fabric

生命周期与 paper 对齐：

- `onInitialize`：注册事件与 `/kurobridge` 命令（均容忍无 IPC）。
- `SERVER_STARTING`：环境变量覆盖或 JAR 解压 → 组装看护器拉起 node。
- `SERVER_STOPPING`：停看护 + 优雅关停（时点早于玩家断开，登记差异）。

事件映射：`ServerMessageEvents.CHAT_MESSAGE` / `ServerPlayConnectionEvents.JOIN` / `DISCONNECT` / `ServerLivingEntityEvents.AFTER_DEATH`，join/quit 后补 `status`。TPS 由 `TickRateSampler` 自测（60s 滑动窗，逐 tick 采样）。

与 paper 的登记差异：

- `chat` 无 `kurobridge.relay` 权限门（fabric 原生无权限节点；v1 全员转发）。
- `CHAT_MESSAGE` 覆盖 `/me` 等命令产生的聊天（轻微超集）。
- 死亡消息是 vanilla 文案（`DamageTracker`），措辞与 Bukkit 不同。
- `/kurobridge` 用 `hasPermissionLevel(2)` 近似 `kurobridge.admin`。
- 命令执行更简单：收集型 `CommandOutput` 原生可用，不需要 vanilla 回退路径。

## 打包与运行期布局

- `pnpm build:jar`：`pnpm -r build` → `embed.ts` → `:paper:shadowJar` → `:fabric:remapJar`。
- paper shadowJar 包含 `:core`、`:paper-legacy`、Jackson、`embedded/` 资源；fabric shadow 白名单只合并 `:core` + Jackson 三件，再由 loom `remapJar`。
- JAR 安装后运行期路径（cwd = 服务器根）：

```
plugins/kurobridge/
├── config.jsonc         # Node 读写；缺失生成注释模板（随机 token）
├── bin/                 # 从 JAR 解压/复用
│   ├── node.exe
│   ├── index.mjs
│   ├── NODE_LICENSE
│   ├── manifest.json
│   ├── napuketto.zip    # 仅 JE 嵌包
│   └── napuketto/
├── napuketto.toml       # 仅旧版 CLI 回退形态使用（ADR-041 内联注入后服主无需维护）
├── napuketto-data/
├── node.pid             # 优雅关停删除；异常退出残留
├── qr.png / qr.json     # embedded 形态的扫码交接
```

- 不使用 `getDataFolder()`：插件名 `KuroBridge` 在大小写敏感文件系统会得到另一个目录；两侧统一以 cwd 为基准。

## 环境变量

| 变量 | 开发覆盖 | JAR 模式 |
| --- | --- | --- |
| `KUROBRIDGE_BUNDLE` | 已设置即完全跳过 JAR 解压 | 不设置 |
| `KUROBRIDGE_NODE` | 缺省 `node`（PATH） | 缺省 `plugins/kurobridge/bin/node.exe` |
| `KUROBRIDGE_STUB_PEER` | 缺省从 bundle 推导 `../stub/peer.ts` | 不设置 = 无 stub（external 形态） |

## 已知缺口

- `:paper` 无单元测试（Bukkit 桥接靠沙盒验收；日志行解析类测试在 `:core`）；`:fabric` 只有 `TickRateSampler` 单测。
- universal 面（ADR-038）：26.3（embedded 深验）/ 26.2 / 1.21.11 / 1.16.5（`Debug/Paper-1.16.5`，Java 16）四线真机冒烟通过；1.12.2 未上机（`api-version` 下限 1.13，1.12.2 忽略该键可加载，需 Java 8 运行时实测）。
- fabric 多 MC 版本矩阵未做（首版钉 1.21.4）。
- fabric 缺 relay 权限门与 `/kurobridge` 细粒度权限。
- neoforge / velocity 未实现。

测试：`:core` 的 JUnit 覆盖 codec、进程生命周期、看护器、EmbeddedRuntime，以及真实 node + stub 的管道集成（缺 node 时相关用例自跳过）。
