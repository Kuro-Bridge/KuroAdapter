# KuroBot 架构书

> 状态：**设计定稿（2026-08-10）**。工程体系借鉴 NapukettoQQ（文档分层 / biome+tsconfig / pnpm workspace / 测试设施）。本文是架构 SSOT，改动先更新本文再动代码。

## 1. 定位与范围

KuroBot = MC 服务器插件（Paper JAR，Java），全自研，MIT 开源。群服互通插件：通过 WebSocket 与机器人框架通信，实现「游戏 ↔ 社交平台」双向互通（QQ / TG / Discord / WhatsApp…）。

```
kurobot（Paper JAR）—— Java 薄壳 + 内嵌 Node 子进程（TS 业务核心）
```

**核心原则**：
1. **kurobot 永远是 WS 服务端角色**，对端（协议端）主动连它。embedded / external **不是架构差异，只是打包/配置差异**（config 一个开关）。
2. **kurobot 只认一套自研协议 `kurobot-ws`**，不关心对端是谁（内嵌 napukettoqq / 独立 napukettoqq / koishi-plugin-kurobot / 其它实现）。
3. **业务核心在 Node（TS）侧**，Java 只是 Bukkit 桥接薄壳——开发量 90% 落在 TypeScript。
4. **Koishi 形态 = 站在 Koishi 的 adapter 生态肩膀上**，把全世界社交平台统一成 session 接口；平台渲染（富文本/颜色码/长度收敛）只存在于 koishi-plugin-kurobot。

## 2. 架构总览

```mermaid
flowchart LR
    subgraph MC["Minecraft 服务端"]
        subgraph JAR["kurobot.jar（Java 薄壳）"]
            EV[Bukkit 事件监听] --> IPC
            CM[命令/权限] --> IPC
            PM[子进程管理<br/>stdin EOF 自杀 + PID + Watchdog]
            IPC[stdin/stdout JSON-lines]
        end
        subgraph NODE["内嵌 Node 子进程"]
            CORE["bridge/core（TS）<br/>业务核心 + kurobot-ws 服务端"]
            IPC --> CORE
        end
    end

    subgraph PEER["对端（协议端）"]
        EMB["embedded：napukettoqq（随 JAR 附带）"]
        EXT["external：koishi-plugin-kurobot → Koishi adapter"]
        EXT2["其它协议实现"]
    end

    CORE -- "WS 动态端口 listen(0)" --> EMB
    CORE -- "WS 配置端口" --> EXT
    CORE -- "WS" --> EXT2
```

## 3. 两种模式

| | `mode=embedded`（默认） | `mode=external` |
|---|---|---|
| 内嵌 Node 业务核心 | ✅ 拉起 | ✅ 拉起 |
| 协议端 | 内嵌 napukettoqq（JAR 附带） | 外部对端（koishi-plugin-kurobot 等） |
| 开箱即用 | ✅ 控制台扫码 | 需另配 Koishi |
| 架构差异 | **无**，仅打包/配置差异 | |

> 注：早期「external 不拉内嵌进程」的结论已作废（ADR-006）——业务核心在 Node 里，两种模式都必须拉 Node。

## 4. 分层与依赖方向

```
bridge/protocol（@kurobot/protocol）   zod schema SSOT，零框架依赖
   ↑
bridge/core     业务核心 + 协议服务端；零 Node API、零框架（平台无关）
   ↑                    ↑
bridge/embedded   esbuild 单文件（embedded 形态）     platforms/je（Java 薄壳，JSON-lines IPC）
```

> **koishi-plugin-kurobot 是独立仓库**（ADR-018）：作为 `kurobot-ws` 的官方参考对端（external 形态），依赖 `@kurobot/protocol` 发布版本，不在本仓库内开发。

**关键规则**：
- `bridge/core` 禁止任何 Node API（`ws`/`process`/`fs`/`pino`），传输层与 logger 均为可注入接口，target ES2020 → **QuickJS（LSE）可跑**。
- Java 薄壳**不含协议逻辑**，只做 Bukkit 桥接 + JSON-lines IPC + 子进程管理。
- 平台渲染只出现在独立仓库 koishi-plugin-kurobot（本仓库不涉及）。

## 5. 进程模型与 IPC

- **Java ↔ Node**：stdin/stdout **JSON-lines**，零端口零配置（ADR-010）。请求-响应（UUID）+ 事件推送两种帧。
- **Node ↔ 对端**：WS，动态端口 `listen(0)`（embedded，避免僵尸进程占端口）或配置端口（external）。端口号经 IPC 从 Node 回传给 Java（日志展示/管理用）。
- **子进程生命周期**：stdin EOF 自杀 + PID 文件 + Watchdog 心跳 + 崩溃兜底重启。

## 6. 业务归属

| 数据/逻辑 | 归属 | 说明 |
|---|---|---|
| 群↔服绑定、白名单、指令权限、转发规则 | **bridge/core（TS）** | 配置 JSON 放 `plugins/kurobot/`，Node 读写，服主改 JSON |
| Bukkit API 桥接（事件/命令/权限/broadcast/executeCommand） | **Java 薄壳** | 模板化，~几百行 |
| 消息渲染、平台格式收敛 | **koishi-plugin-kurobot（独立仓库）** | 唯一认识平台的地方（ADR-018） |
| 协议端（QQ 连接） | napukettoqq | 只做协议端，不做业务 |

## 7. 目录树

```
kurobot/
├── readme.md / AGENTS.md / lefthook.yml / mise.toml
├── package.json（仅脚本 + workspaces）/ pnpm-workspace.yaml
├── biome.json / tsconfig.json / vitest.config.ts / .editorconfig   # 对齐 NapukettoQQ
├── docs/
│   ├── architecture.md（本文）/ DECISIONS.md / STATUS.md
│   └── protocol/            # 协议说明文档（draft 等）
│       └── draft-v0.1.md    # 协议草案说明（schema 源见 bridge/protocol）
├── platforms/
│   ├── je/                  # Java 交付物根（Gradle 多模块：一个服务端 = 一个模块，ADR-019）
│   │   ├── build.gradle.kts / settings.gradle.kts
│   │   ├── core/            # 薄壳核心（IPC 客户端 / 进程管理，零 Bukkit API）
│   │   ├── paper/           # Paper 适配（依赖 :core，产出 shadowJar）
│   │   │   └── src/main/resources/embedded/   # 构建期生成（gitignore）
│   │   ├── fabric/          # 预留：Fabric mod 适配（依赖 :core）
│   │   ├── neoforge/        # 预留：NeoForge mod 适配（依赖 :core）
│   │   └── velocity/        # 预留：Velocity 代理适配（依赖 :core）
│   └── be/                  # BE 服务端家族（基岩版，ADR-020）
│       ├── lse/             # LeviLamina LSE 平台适配（TS → JS，复用 bridge/core）
│       │   ├── package.json / tsconfig.json / plugin.json
│       │   └── src/index.ts # 入口（ll.registerPlugin + mc.listen）
│       └── endstone/        # Endstone 适配（C++ 薄壳 + 内嵌 Node，预留骨架）
│           ├── CMakeLists.txt
│           └── src/main.cpp # 占位入口
├── bridge/
│   ├── protocol/            # @kurobot/protocol：zod schema SSOT
│   ├── core/                # @kurobot/bridge-core（平台无关）
│   └── embedded/            # 嵌入式瘦身对端（esbuild 单文件，打进 JAR）
├── scripts/                 # 构建/工具脚本（embed.ts：嵌入式打包；paper 启停沙盒）
└── sandbox/                 # 运行产物全 gitignore（Paper 服务端等）
```

> koishi-plugin-kurobot（external 形态官方对端）在独立仓库开发，不在本目录树内。

未来扩展：`platforms/` 按**技术栈 + 客户端**划分：`je`=Java 服务端（paper/fabric/velocity）、`be`=BE 服务端家族（lse=TS 脚本 / endstone=C++ 薄壳）。Nukkit 已剔除（非主流，2026-08-11）。PocketMine-MP（PHP）工具链不匹配不做。

## 8. 技术栈矩阵

| 模块 | 语言 | 关键依赖 | 构建 | 测试 |
|---|---|---|---|---|
| `docs/protocol` | TS | zod（SSOT） | tsdown | vitest |
| `bridge/core` | TS | zod；零框架零 Node API | tsdown | vitest（+ fast-check，二期） |
| `bridge/embedded` | TS | 无框架 | esbuild 单文件 | 集成测试（起真 WS server） |
| `platforms/je` | Java 21 字节码（工具链 25，target 21） | Paper API（compileOnly）+ Jackson | Gradle shadowJar | JUnit 5（IPC 编解码 + 进程生命周期） |
| `platforms/be/lse` | TS → JS | `@levimc-lse/types` + `@kurobot/bridge-core` | esbuild 单文件（IIFE，target es2020） | vitest |
| `platforms/be/endstone` | **C++ 20** | Endstone API + 内嵌 Node | CMake（预留） | —（预留） |
| koishi-plugin-kurobot（独立仓库） | TS | Koishi v4 + `@kurobot/protocol` | Koishi 标准 | vitest + `@koishijs/plugin-mock` |

**苛刻度（对齐 NapukettoQQ）**：
- **TS 侧**：直接沿用 Napuketto 的 biome.json + tsconfig（`erasableSyntaxOnly`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`noFloatingPromises`、`noExcessiveCognitiveComplexity(15)`、`useNamingConvention`、`useErrorMessage`、organizeImports 全保留）。一份 biome 配置管 bridge/ + platforms/be/。
- **Java 侧（第一版）**：`-Xlint:all -Werror` + Spotless(Palantir) + JUnit 5 + JaCoCo 存在性门禁（行 ≥60%）。**Error Prone / NullAway 第一版不上**（ADR-011），薄壳定型后再评估。
- **协议防漂移门禁**：消息类型只能 import `@kurobot/protocol`（lint 规则强制）；改 schema 不更新消费方 → `pnpm check` 红。

## 9. 嵌入式打包要点（沿用 Napuketto 许可证方案）

- `node.exe`（MIT）→ 进 JAR；`wrapper.node`（腾讯闭源）→ **不进 JAR**，运行期从 QQ 安装目录发现拷贝；stub 闭源件走 release 附带。
- 动态端口（`listen(0)`）避免僵尸进程端口占用问题。
- 子进程生命周期：stdin EOF 自杀 + PID 文件 + Watchdog 心跳 + 崩溃兜底。
- 嵌入式打包：`scripts/embed.ts` 下载/校验 node 官方 dist（win-x64，sha256 对 SHASUMS256.txt）
  → 连同 `bridge/embedded` 产物拷入 `platforms/je/paper/src/main/resources/embedded/`
  （含 manifest.json 清单，运行期解压比对）；多平台矩阵记债务。

## 10. 协议

协议草案见 [`docs/protocol/draft-v0.1.md`](protocol/draft-v0.1.md)。

要点：协议名 `kurobot-ws`；WS 子协议 `Sec-WebSocket-Protocol: kurobot-ws.v1`（大版本，握手期拒绝不兼容对端）+ `hello` 内 `protocolVersion`（小版本/能力协商）；帧 `{ header: { type, id }, body }`；绑定频道列表随 `hello` 上报 + `bindingsUpdated` 增量事件；UUID 请求-响应 + `msgContinue` 流式回报；业务心跳 + 假连接检测；指数退避重连。

## 11. 红线

1. Java 薄壳不写业务逻辑（绑定/权限/转发）。
2. `bridge/core` 不出现任何 Node API / Koishi API。
3. 消息类型不手写，只 import `@kurobot/protocol`。
4. 不引入 OneBot 11；不复制 HuHoBot / NapCat / NapukettoQQ 代码。
5. 嵌入式打包：`wrapper.node` 不进 JAR。
6. IPC 只用 stdin/stdout JSON-lines，Java 不碰端口。
