# KuroBridge

> 仓名 KuroAdapter，产品名 KuroBridge（ADR-030 品牌迁移后统一；本仓文档与代码标识均以产品名行文）。

MC 服务器 ↔ 社交平台群服互通插件。丢进 `plugins/` 的 Paper JAR（另有 Fabric、LeviLamina/LSE、Endstone 适配），通过 WebSocket 与协议端通信，实现「游戏 ↔ 社交平台」双向互通（QQ / Telegram / Discord / WhatsApp…）。

> **全自研 · MIT 开源**。参考 **HuHoBot**（Python + ymbotpy）的「业务在机器人侧 + 自定义 WS 协议」思路，但不包含其任何代码（GPL-3.0 与 MIT 不兼容）。

## 形态

```
kurobridge（Paper JAR，Java 薄壳）
│
├─ Java 薄壳：Bukkit 事件/命令/权限桥接 + 内嵌 Node 子进程管理（几百行模板代码）
│
└─ 内嵌 Node 子进程 → bridge/core（TypeScript 业务核心 + WS 服务端）
      ├─ embedded：打包内置 napuketto（开箱可扫码），运行默认不开——config `embedded.napuketto.enabled: true` 开启
      └─ external：不附带协议端，由 koishi-plugin-kurobridge 等对端连入
```

- **两种模式不是架构差异，只是打包差异**（config `embedded.napuketto.enabled` + `ws.port` 固定端口两条件）；两种模式都运行同一套 Node 业务核心。
- **kurobridge 永远是 WS 服务端角色**，对端（协议端）主动连它；只认一套自研协议 `kurobridge-ws`，不关心对端是谁。

## 仓库结构

```
├─ platforms/je/     # Java 服务端适配（Gradle 多模块：core + paper + fabric + 预留 neoforge/velocity）
├─ platforms/be/     # BE 服务端家族：lse（TS，R2′ WS 回环薄壳）+ endstone（C++ 薄壳，portable 层与 clang-cl dll 已落地）
├─ bridge/
│   ├── core/         # 业务核心 + 协议服务端（TS，平台无关）
│   └── embedded/     # 嵌入式瘦身对端（打进 JAR，无 Koishi）
├── docs/             # 文档中心：架构 / 模块 / 参考 / 指南 / 决策 / 现状
└── sandbox/          # 运行产物（gitignore）

> koishi-plugin-kurobridge（external 官方对端）在**独立仓库**开发（ADR-018）。
> 平台家族入口：[platforms/je/readme.md](platforms/je/readme.md)（Java 版）·
> [platforms/be/readme.md](platforms/be/readme.md)（基岩版）。
```

## 文档

- [文档中心](docs/README.md) —— 按任务索引全部文档
- [架构总览](docs/architecture/overview.md) —— 定位、拓扑、模块与依赖、红线
- [运行时](docs/architecture/runtime.md) —— 启动、握手、转发、热载、看护与关停
- [模块文档](docs/modules/bridge-core.md) —— core / embedded / JE / LSE / Endstone
- [配置参考](docs/reference/config.md) · [协议参考](docs/reference/protocol.md)
- [开发指南](docs/guides/development.md) · [构建与发布](docs/guides/build.md)
- [决策台账](docs/decisions.md)（ADR-001~037）· [项目现状](docs/status.md)

## 工程约定

- 工程指南见 [AGENTS.md](AGENTS.md)（借鉴 NapukettoQQ 的工程体系）。
- 技术栈：TS（Biome + tsconfig 严格全家桶）+ Java 薄壳（工具链 25 / 字节码 target 21，`-Xlint:all -Werror` + Spotless，ADR-015）。
- 协议 SSOT 为姊妹仓 KuroProtocol 的 zod schema，本仓经 npm 依赖 `@kuro-bridge/protocol@^0.4.0` 消费（无仓内副本，ADR-031/035）；任何文件禁止手写消息类型。

## License

MIT
