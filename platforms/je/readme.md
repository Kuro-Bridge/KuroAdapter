# platforms/je —— JE 服务端家族（Java 版）

> Java 服务端适配（Gradle 多模块，ADR-019：一个服务端 = 一个模块）：`:core` 薄壳核心
> （IPC 编解码 + 进程管理，零 Bukkit API）+ 各服务端适配模块。业务核心在 Node 侧
> `bridge/core`，Java 只做桥接薄壳。实况以 [docs/STATUS.md](../../docs/STATUS.md) 为准。

## 模块状态（2026-09-19）

| 模块 | 状态 |
|---|---|
| `core/` | ✅ 生产在用（IPC 编解码 / 进程生命周期，JUnit 覆盖） |
| `paper/` | ✅ 生产在用（Paper 1.21.4，`shadowJar` 产出可分发 JAR） |
| `fabric/` | ✅ 首版 mod 壳已实现（2026-09-19 平台落地波；chat/join/quit/death/status 五事件对齐 paper，chat/status 两格有登记差异） |
| `neoforge/`、`velocity/` | 🚧 预留骨架（接入对应服务端 API 后启用，ADR-021） |

## 文档

- 家族设计与 embed 打包契约：[docs/design.md](docs/design.md)
- fabric 包级设计（首版）：[fabric/docs/design.md](fabric/docs/design.md)
- BE 家族入口：[../be/readme.md](../be/readme.md)
