# platforms/je 设计（Gradle 多模块：Java 薄壳）

> 包级设计文档。ADR-019（多模块拆分）、ADR-021（多版本策略）、ADR-010（IPC）、ADR-005（薄壳化）。
> 本文件在 MVP 阶段一首次建立（此前依赖仓库级架构书，未建包级文档——见 MVP1-NOTES）。

## 模块

- `:core`（零 Bukkit API）：`NodeIpc`（子进程管理 + stdin/stdout JSON-lines 客户端）、
  `IpcFrameCodec`（帧编解码，与 bridge/protocol 的 zod schema 逐字段镜像，ADR-008 允许的
  Java 手写 DTO 唯一例外）、`ProcessFactory`（进程启动抽象，测试可注入）、`IpcResult`/
  `NodeIpcListener`（回调契约）。JUnit 5：FakeProcess 替身（30+ 用例）+ 真 node/bundle/stub
  的管道集成测试。
- `:paper`（Paper 1.21.4，compileOnly paper-api）：`KuroBotPlugin`（生命周期/组装/命令注册）、
  `ChatListener`（AsyncChatEvent → game_chat）、`ConnectionListener`（PlayerJoin/QuitEvent →
  player_join/player_quit + status 快照）、`KurobotCommand`（/kurobot send）、
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
  定位 plugins/kurobot/config.json）；`NodeIpc.setWorkingDirectory` 包内可见（start 前调用），
  集成测试用 @TempDir 预置绑定配置。
- status 快照取数：TPS=`Bukkit.getTPS()[0]`（clamp≥0 保留 1 位小数）、在线数=
  `Bukkit.getOnlinePlayers().size()`、uptime=`ManagementFactory`（JVM uptime，JDK 标准接口）。
  推送时机 = 玩家进出服（在线数变化点），零业务（频道 fan-out 在 Node 侧）。

## MVP 阶段二（2026-09-13）：打包闭环

> 任务书：`docs/MVP2-PROMPT.md`。目标：JAR 自含 Node 运行时，装上就能用（不再依赖
> `KUROBOT_NODE`/`KUROBOT_BUNDLE` 环境变量）。

### scripts/embed 打包工具（产物契约）

`scripts/embed.ts`（Node 脚本，只用内置依赖；Node ≥23.6 原生 TS 剥离直接跑，无需编译）：

- 下载 node-v26.7.0-win-x64.zip（nodejs.org 官方 dist）+ SHASUMS256.txt sha256 校验；
  本地缓存 `.cache/node-dist/`（gitignored）。镜像/缓存可经环境变量覆盖：
  `KUROBOT_NODE_DIST_BASE`（默认 `https://nodejs.org/dist`）、`KUROBOT_NODE_CACHE_DIR`。
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
- **bin 目录推导**（:paper 侧）：相对服务器根的 `plugins/kurobot/bin/`（小写 kurobot，
  与 Node 侧 `plugins/kurobot/config.json` 同基）。**不用 getDataFolder()**——
  paper-plugin.yml 的 name 是 `KuroBot`，大小写敏感文件系统上会得到 `plugins/KuroBot/`
  两个目录。两侧统一以 cwd（=服务器根）为基准推导，语义对称。
- 解压失败 → SEVERE 日志 + 插件保持加载但无 IPC（对齐既有「开发模式」降级语义），不崩服。
- 在 onEnable（STARTUP）同步执行：首启约 1-2s（85MB 哈希+拷贝），后续启动走复用路径；
  换来加载顺序天然正确（解压完才拉进程）。node.exe 只在启动路径解压（必然未运行，
  无文件占用问题），不做运行期覆盖。

### 环境变量优先级（KUROBOT_NODE/KUROBOT_BUNDLE 保留为开发覆盖）

| 场景 | node 可执行 | bundle | stub |
|---|---|---|---|
| `KUROBOT_BUNDLE` 已设（开发覆盖） | `KUROBOT_NODE` 缺省 `"node"`（现状） | 环境变量值 | env → bundle 相对推导（现状） |
| 未设（JAR 模式） | `KUROBOT_NODE` 缺省 `bin/node.exe` | `bin/index.mjs` | env → **无**（INFO 说明，外部协议端形态） |

`KUROBOT_STUB_PEER` 语义不变；stub 不进 JAR（测试件），沙盒继续经它指向仓库内 stub。

### 沙盒脚本

`scripts/paper-start.sh`：不再强制导出 `KUROBOT_NODE`/`KUROBOT_BUNDLE`（保留透传能力），
补 `KUROBOT_STUB_PEER` 缺省值（仓库内 stub 路径）——验收「JAR 真装路径」。

## 已知坑（详见 PROTOTYPE-NOTES / MVP1-NOTES）

- Spotless palantir 钉 2.71.0（JDK 25 兼容线）；`-Xlint:all -Werror`。
- Shadow 9：fat jar 用 `:paper:shadowJar`（不挂 assemble）。
- gradlew 输出经管道（`| tail`）会挂起客户端——输出重定向到文件再读（MVP1-NOTES M-18）。
- paper-plugin.yml 不支持 commands 声明 → CommandMap 运行期注册。
