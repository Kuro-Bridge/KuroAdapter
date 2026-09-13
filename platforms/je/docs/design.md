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

## 已知坑（详见 PROTOTYPE-NOTES / MVP1-NOTES）

- Spotless palantir 钉 2.71.0（JDK 25 兼容线）；`-Xlint:all -Werror`。
- Shadow 9：fat jar 用 `:paper:shadowJar`（不挂 assemble）。
- gradlew 输出经管道（`| tail`）会挂起客户端——输出重定向到文件再读（MVP1-NOTES M-18）。
- paper-plugin.yml 不支持 commands 声明 → CommandMap 运行期注册。
