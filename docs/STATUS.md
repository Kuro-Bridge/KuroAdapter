# KuroBot 现状与路线（STATUS）

> 借鉴 NapukettoQQ 的 `STATUS.md` 形态：现状 + 关键决策点 + 下一步。开始任何工作前先读本文。

## 当前状态（2026-08-10）

**设计已定稿**（见 `architecture.md` + `DECISIONS.md`），仓库为空骨架，尚未开始代码。

- 已建：`readme.md`、`AGENTS.md`、`docs/architecture.md`、`docs/DECISIONS.md`、`docs/STATUS.md`、`docs/protocol/draft-v0.1.md`、仓库骨架（biome/tsconfig/package.json 等）、`bridge/protocol` 包。

## 关键决策点（已拍板，勿再翻烧饼）

| # | 决策 | 要点 |
|---|---|---|
| 1 | 单仓 monorepo | ADR-001 |
| 2 | Java 21 | ADR-002 |
| 3 | 协议 `kurobot-ws` + 双层版本 | ADR-003 |
| 4 | 绑定频道随 hello + bindingsUpdated | ADR-004 |
| 5 | 业务核心在 Node（TS），Java 薄壳 | ADR-005 |
| 6 | external 也拉 Node | ADR-006 |
| 7 | core 平台无关（零 Node API） | ADR-007 |
| 8 | SSOT 用 zod（非 TypeBox） | ADR-008 |
| 9 | 不引入 nx/turbo | ADR-009 |
| 10 | IPC = stdin/stdout JSON-lines | ADR-010 |
| 11 | Java 第一版不上 Error Prone/NullAway | ADR-011 |
| 12 | LSE TS 化（@levimc-lse/types） | ADR-012 |
| 13 | 测试栈 vitest + JUnit 5；fast-check 二期 | ADR-013 |
| 14 | 嵌入式打包沿用 Napuketto 许可证方案 | ADR-014 |
| 15 | 工具链升级：Node 26 + Java 25（target 21） | ADR-015 |
| 16 | 运行时不用 Bun | ADR-016 |
| 17 | 剔除 CI/CD，本地门禁（lefthook + pnpm check） | ADR-017 |
| 18 | koishi 插件独立仓库（不在本仓库内） | ADR-018 |
| 19 | platforms/je 多模块（:core + paper + 预留 fabric/velocity） | ADR-019 |
| 20 | BE 服务端家族：LSE(TS) + Endstone(C++ 薄壳)，剔 Nukkit | ADR-020 |
| 21 | je 多版本策略：:core 版本无关，fabric/neoforge 按版本矩阵构建 | ADR-021 |

## 待定事项

- 协议 `kurobot-ws` 具体消息 schema 逐字段定稿（`bridge/protocol` 下一步细化，含 zod 源）。
- 独立仓库 koishi-plugin-kurobot 的建立时间与 Koishi 版本基线（v4 稳定版）——JE 闭环后启动。
- `platforms/be` 家族骨架已建（2026-08-11）：`lse/`（TS）+ `endstone/`（C++ 薄壳预留），实现排期在 JE 闭环后。
- `platforms/je` 的 fabric/neoforge/velocity 模块为预留骨架，接入对应服务端 API 后启用。

## 下一步实现顺序（推荐）

```
0. 仓库骨架：biome.json / tsconfig.json / package.json / pnpm-workspace.yaml /
   vitest.config.ts / .editorconfig / mise.toml / lefthook.yml / CI 空跑
   （直接借鉴 NapukettoQQ 的配置体系）
1. bridge/protocol：zod schema SSOT（@kurobot/protocol 包）+ draft 说明同步
2. bridge/core 最小闭环：connect → hello 握手 → 心跳 → chat 收发 → 重连
   （传输层抽象，先写 Node 实现，QuickJS 适配后续）
3. platforms/je 薄壳：IPC 客户端 + 进程管理 + 事件/命令/权限桥接
4. 嵌入式打包工具（tools/embed 已删，重建）+ sandbox 沙盒联调
5. koishi-plugin-kurobot：独立仓库（ADR-018），复用 `@kurobot/protocol` 发布版本
6. platforms/be：lse（LSE TS 适配，复用 bridge/core）→ endstone（C++ 薄壳）另行评估
```

## 原型机结论（2026-09-13，spike 分支 prototype/spike）

> 任务书见 `docs/PROTOTYPE-PROMPT.md`，全部决策与发现见 `docs/PROTOTYPE-NOTES.md`。

**命题「Paper → Java 薄壳 → Node 子进程（IPC）→ bridge/core（WS 服务端）→ 协议端」端到端跑通——成立。** 真实 Paper 1.21.4-232 沙盒验收全过：

- 插件加载 → node 拉起 → IPC ready（stdin/stdout JSON-lines，WS 动态端口）→ stub 孙进程连入 → hello/hello_ack 握手 → 心跳协议（单测+集成验证）。
- 双向消息：`/kurobot send` → stub 收到并打印；stub 握手后消息 → 服务器 broadcast。
- 生命周期：`stop` → shutdown 帧 → Node 自杀 → 无孤儿进程；**node 被强杀 → 服务器不崩、主线程不卡**（IPC 永不阻塞主线程的关键架构性质验证通过）。
- 门禁：`pnpm check` / `pnpm test`（33+17 用例）/ `pnpm -r build` / `gradlew :core:test`（30 用例 + 真管道集成测试）/ `:paper:shadowJar` 全绿。

原型落地的最小实现（分支 prototype/spike）：

- `bridge/protocol`：WS+IPC 最小 schema 集（hello/hello_ack/ping/pong/chat ×2 + ready/game_chat/broadcast/execute_command/shutdown + *_result），解析层扁平化 transform（D-11）。
- `bridge/core`：传输接口（WsServer/IpcChannel/Logger 注入）+ CoreContext + KurobotServer 握手状态机 + Relay 假转发。
- `bridge/embedded`：Node 引导层（ws 适配器 / stdio IPC / stderr logger / stub 孙进程拉起）+ stub 协议端（零依赖）。
- `platforms/je`：`:core`（NodeIpc 客户端 + Jackson 帧编解码 + 进程管理，JUnit）+ `:paper`（薄壳 4 类）。
- `scripts/paper-start.sh|paper-stop.sh`：沙盒启停（Windows 踩坑全记录于 NOTES）。

**留给正式版的 5 个 ADR 候选**（详见 NOTES）：A 孙进程协议端模型（已验证）、B 单程握手、C 协议解析层常驻、D 帧格式统一规则、E IPC 断连的降级语义。**MVP 债务 12 项**（心跳超时/重连/Watchdog/业务空壳等）详见 NOTES 债务清单。
