# KuroBridge 文档中心

KuroBridge（仓名 KuroAdapter）：Minecraft 服务器 ↔ 社交平台群服互通插件。Java / C++ / QuickJS 只做平台薄壳，业务核心与 `kurobridge-ws` 服务端在 Node（TypeScript）。

## 从哪里开始

| 我想… | 读 |
| --- | --- |
| 5 分钟理解系统长什么样 | [架构总览](architecture/overview.md) |
| 理解进程、IPC、握手、看护与关停 | [运行时与生命周期](architecture/runtime.md) |
| 改业务核心（转发 / 权限 / 配置） | [bridge/core](modules/bridge-core.md) |
| 改 JAR 内引导层或 napuketto 嵌入 | [bridge/embedded](modules/bridge-embedded.md) |
| 改 Java 薄壳（Paper / Fabric） | [JE 平台](modules/je.md) |
| 改基岩版适配（LSE / Endstone） | [LSE](modules/be-lse.md) · [Endstone](modules/be-endstone.md) |
| 配置服务器 | [config.jsonc 参考](reference/config.md) |
| 对接协议端 | [协议参考](reference/protocol.md) |
| 本地开发、门禁、提交 | [开发指南](guides/development.md) |
| 构建 JAR / mod / dll、发版 | [构建与发布](guides/build.md) |
| 查“为什么这么定” | [决策台账](decisions.md) |
| 查当前能力与已知缺口 | [项目现状](status.md) |
| 查版本变更与发布物 | [变更日志](../CHANGELOG.md) |

## 文档地图

```
docs/
├── README.md                  # 本页：索引与文档规则
├── architecture/
│   ├── overview.md            # 定位、形态、模块、依赖方向、业务归属
│   └── runtime.md             # 启动/握手/转发/热载/看护/关停
├── modules/
│   ├── bridge-core.md         # @kuro-bridge/bridge-core：导出面与业务规则
│   ├── bridge-embedded.md     # @kuro-bridge/bridge-embedded：Node 引导层
│   ├── je.md                  # platforms/je：:core + paper + fabric
│   ├── be-lse.md              # platforms/be/lse：WS 回环薄壳
│   └── be-endstone.md         # platforms/be/endstone：C++ 薄壳
├── reference/
│   ├── config.md              # config.jsonc 逐字段说明
│   └── protocol.md            # kurobridge-ws 与 IPC 帧面速查
├── guides/
│   ├── development.md         # 环境、命令、代码规范、扩展方式
│   └── build.md               # 构建链、嵌入式打包、CI、排障
├── decisions.md               # ADR-001~042 精简台账
└── status.md                  # 支持矩阵、已知缺口、下一步
```

仓根另有 [CHANGELOG.md](../CHANGELOG.md)：按版本记录对外可见变更。

平台包内另有部署 SOP（[platforms/je/readme.md](../platforms/je/readme.md)、[platforms/be/lse/readme.md](../platforms/be/lse/readme.md)、[platforms/be/endstone/readme.md](../platforms/be/endstone/readme.md)）。

## 文档规则

1. **代码即事实**。配置形状的 SSOT 是 [`bridge/core/src/business/config.ts`](../bridge/core/src/business/config.ts) 的 zod schema；协议 SSOT 在姊妹仓 KuroProtocol（npm 包 [`@kuro-bridge/protocol`](https://www.npmjs.com/package/@kuro-bridge/protocol)）。文档与代码冲突时先修代码或文档，不允许两份“权威”。
2. **单篇单主题**。新内容优先补进现有主题文件；确需新文件时放进对应目录，禁止在 `docs/` 根堆散篇。
3. **不写阶段史**。任务书、交接册、一次性实录不入库；需要考古时用 `git log`。决策只留结论与理由（[decisions.md](decisions.md)）。
4. **链接必须可达**。`pnpm check:docs` 扫全仓 Markdown 相对链接与旧 npm scope 口径，死链即红。
5. **改文档也算改动**。涉及架构、配置、协议、构建流程的代码改动，同笔提交更新对应文档。
