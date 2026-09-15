# 还没写好是个空壳


MC 服务器 ↔ 社交平台群服互通插件。丢进 `plugins/` 的 Paper JAR，通过 WebSocket 与机器人框架通信，实现「游戏 ↔ 社交平台」双向互通（QQ / Telegram / Discord / WhatsApp…）。

> **全自研 · MIT 开源**。参考 **HuHoBot**（Python + ymbotpy）的「业务在机器人侧 + 自定义 WS 协议」思路，但不包含其任何代码（GPL-3.0 与 MIT 不兼容）。

## 形态

```
kurobridge（Paper JAR，Java 薄壳）
│
├─ Java 薄壳：Bukkit 事件/命令/权限桥接 + 内嵌 Node 子进程管理（几百行模板代码）
│
└─ 内嵌 Node 子进程 → bridge/core（TypeScript 业务核心 + WS 服务端）
      ├─ embedded（默认）：附带协议端 napukettoqq，开箱即用，控制台扫码
      └─ external：不附带协议端，由 koishi-plugin-kurobridge 等对端连入
```

- **两种模式不是架构差异，只是打包差异**（`config` 一个开关）；两种模式都运行同一套 Node 业务核心。
- **kurobridge 永远是 WS 服务端角色**，对端（协议端）主动连它；只认一套自研协议 `kurobridge-ws`，不关心对端是谁。

## 仓库结构

```
├─ platforms/je/     # Java 服务端适配（Gradle 多模块：core + paper + 预留 fabric/neoforge/velocity）
├─ platforms/be/     # BE 服务端家族：lse（LSE TS）+ endstone（C++ 薄壳，预留）
├─ bridge/
│   ├── protocol/     # @kurobridge/protocol：协议 zod schema SSOT
│   ├── core/         # 业务核心 + 协议服务端（TS，平台无关）
│   └── embedded/     # 嵌入式瘦身对端（打进 JAR，无 Koishi）
├── docs/             # 架构书 / 决策记录 / 现状 / 协议文档 / 历史册归档（history/）
└── sandbox/          # 运行产物（gitignore）

> koishi-plugin-kurobridge（external 官方对端）在**独立仓库**开发（ADR-018）。
```

## 文档

- [架构书](docs/architecture.md) —— 分层、进程模型、红线、工具链
- [决策记录](docs/DECISIONS.md) —— 每项拍板的来龙去脉（ADR-001~030）
- [现状与路线](docs/STATUS.md) —— 当前进度、卡点、债务索引
- [对端接入指南](docs/protocol/peer-guide.md) —— `kurobridge-ws` 0.4.0 协议端实现依据
- [历史册归档](docs/history/README.md) —— 已完成阶段的任务书/实录索引

## 工程约定

- 工程指南见 [AGENTS.md](AGENTS.md)（借鉴 NapukettoQQ 的工程体系）。
- 技术栈：TS（Biome + tsconfig 严格全家桶）+ Java 21 薄壳（`-Xlint:all -Werror` + Spotless）。
- 协议 SSOT 为 zod schema（`@kurobridge/protocol`），任何文件禁止手写消息类型。

## License

MIT
