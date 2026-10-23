# platforms/je 包级设计

> 系统级说明见 [docs/modules/je.md](../../../docs/modules/je.md)。本文件只记录 Gradle 结构与实现细节。

## 模块

| 模块 | 说明 |
| --- | --- |
| `:core` | 零 Bukkit API：`NodeIpc`、`IpcFrameCodec`、`NodeSupervisor`、`EmbeddedRuntime`、`IpcLogLevels`、`KurobridgeVersions`、`ProcessFactory`、`IpcResult` / `NodeIpcListener` |
| `:paper` | Paper 1.21.4（compileOnly paper-api）：插件生命周期、三个监听器、`/kurobridge`、`NodeRequestHandler` |
| `:fabric` | Fabric mod（1.21.4）：生命周期/事件桥接/命令/请求处理，见 [fabric/docs/design.md](../fabric/docs/design.md) |
| `:neoforge` / `:velocity` | 预留空模块 |

## 线程契约

- 游戏事件（主线程/异步线程）→ `NodeIpc.send*` 直调；`:core` 写锁串行，不阻塞主线程。
- Node 请求（IPC 读取虚拟线程）→ `runTask` / `server.execute` 调度回主线程；失败也必须显式回执。

## 构建

- 工具链：JDK 25，`options.release = 21`，`-Xlint:all -Werror`，Spotless Palantir 2.71.0。
- `:paper`：shadowJar 合并 `:core` + Jackson + `embedded/` 资源，产物 `kurobridge-0.1.0.jar`。
- `:fabric`：shadow 白名单合并 `:core` + Jackson → loom `remapJar`，产物 `kurobridge-fabric-0.1.0.jar`。
- 根命令：`pnpm build:je`（gradlew build）、`pnpm build:jar`（TS → embed → shadowJar → remapJar）。

## 环境变量优先级

| 场景 | node | bundle | stub |
| --- | --- | --- | --- |
| `KUROBRIDGE_BUNDLE` 已设 | `KUROBRIDGE_NODE` 或 `node` | 环境变量值 | env 或从 bundle 推导 `../stub/peer.ts` |
| 未设（JAR 模式） | `KUROBRIDGE_NODE` 或 `bin/node.exe` | `bin/index.mjs` | env 或空（external 形态） |

## 运行期目录

`plugins/kurobridge/`：`config.json`、`bin/`、`node.pid`、`napuketto.toml`、`napuketto-data/`、`qr.png` / `qr.json`。统一以服务器根（cwd）为基准，不用 `getDataFolder()`。

## 测试边界

- `:core` 有 JUnit（codec / 进程 / 看护 / 解压 / 真实 node 集成）。
- `:paper` 无单测，靠沙盒验收；`:fabric` 仅有 `TickRateSampler` 单测。
- 改 Bukkit/Fabric 桥接必须更新沙盒或真机清单。
