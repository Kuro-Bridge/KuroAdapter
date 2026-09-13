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

## MVP 阶段一结论（2026-09-13，master）

> 任务书见 `docs/MVP1-PROMPT.md`，全部决策与沙盒实录见 `docs/MVP1-NOTES.md`。

**「业务为空壳」推进到「业务最小可用」——完成。** 四个已实证候选转正为 ADR-022~025（孙进程协议端 /
单程握手 / 协议解析层 transform / 统一帧格式与 id 规则），ADR-022 含单进程回退条件。验收清单全过：

- **协议 v0.2**：chat/broadcast 携带 channel、hello_ack 携带 channelBindings（ADR-004 落地）、
  新增 join/leave/status/bindings_updated 事件（WS+IPC 同步）、PROTOCOL_VERSION 0.2.0。
- **core 正式化**：Clock/TimerScheduler 注入（core 仍零 Node API）；hello 等待超时（10s/1002）、
  心跳空闲检测（30s 可配/1001，任何入帧重置）均有 vitest 证据；IPC 请求超时（10s 对齐 Java）；
  断连降级候选 E 落地（`IpcChannel.isOpen`/`Relay.ipcOpen`/send* 返回送达数，Java 侧
  sendGameChat 返回 boolean）。
- **业务最小闭环**：`plugins/kurobot/config.json`（缺失生成默认、mtime 轮询热重载）→ BindingTable
  → 转发规则（未绑定频道丢弃+debug 日志、游戏事件按绑定频道逐帧 fan-out、配置变更 →
  bindings_updated 推送 + hello_ack 快照联动）。Relay 假规则已删。
- **Java 桥接**：ConnectionListener（join/quit 帧 + 进出服 status 快照）、/kurobot send 断连明确
  报错（原型债务偿还）。阶段 4 首次实践 subagent 派发 + 主侧复核流程。
- **沙盒端到端 a-e 全过**（实录表见 MVP1-NOTES）：空绑定丢弃有因 / 写绑定消息进游戏+双向通 /
  配置变更 ≤6s 推送 / 强杀 node 服务器不崩+send 明确报错 / stop 级联关机无孤儿。
- **join/leave 降级验收**（§4.4 预授权）：vitest + 集成测试证据齐，真实玩家冒烟留给用户。

门禁终态：`pnpm check` / `pnpm test`（70 用例）/ `pnpm -r build` / `gradlew build`（:core 36 用例，
含真管道集成测试）全绿。MVP-2 债务（白名单/权限、Watchdog、tools/embed、重连、协议 command/query
族等）见 MVP1-NOTES 清单——未写 MVP2-PROMPT（范围属用户决策）。

## MVP 阶段二结论（2026-09-13，master）

> 任务书见 `docs/MVP2-PROMPT.md`，全部决策与沙盒实录见 `docs/MVP2-NOTES.md`。

**「环境变量加载的原型形态」升级为「JAR 自含 Node 运行时的可分发插件」——完成。**
验收清单 §4.1~§4.6 全过：

- **打包链重建（scripts/embed.ts）**：node-v26.7.0-win-x64 官方 dist 下载（sha256 对
  SHASUMS256.txt；直连失败走 `KUROBOT_NODE_DIST_BASE` 镜像，缓存 `.cache/node-dist/`）→
  手搓最小 zip 读取器（零新依赖，stored/deflate + crc32，不支持 zip64）→ 产出
  `embedded/{node.exe, index.mjs, NODE_LICENSE, manifest.json}` 进 :paper resources。
  Node 原生 TS 剥离直接执行，vitest 10 例全程不发真网（下载器可注入）。
- **运行期解压加载链（:core EmbeddedRuntime）**：manifest sha256 幂等比对（复用/缺失/哈希
  不符三路径逐条日志）；名字校验整体前置防 zip slip（固定名读资源 + 单段白名单 +
  normalize 包含检查）；DigestInputStream 边拷边校验 + tmp 原子替换。JUnit 8 例。
- **KuroBotPlugin 双模式**：`KUROBOT_BUNDLE` 保留为开发覆盖（沙盒/CI 用 mise node）；未设 →
  JAR 解压到 `plugins/kurobot/bin/`（与 Node 配置目录同基，规避 getDataFolder 大小写坑），
  失败 SEVERE + 无 IPC 降级不崩服。`pnpm build:jar` 一条命令全链路（gradlew.bat 接线）。
- **沙盒真装路径全过**：首装解压 3 件 → JAR 里的 node.exe 拉起 → stub 握手 → 双向消息
  （`/kurobot send` ↔ stub 广播 `<stub-群友>` 进游戏）；二次启动「复用 3 / 解压 0」；
  删 bin/ 自动恢复。三轮优雅关停无孤儿。
- 门禁终态：`pnpm check` / `pnpm test`（80 用例）/ `pnpm -r build` / `gradlew build`
  （:core 44 用例）全绿；`unzip -l` 证据：JAR（41MB）内含 embedded 四件。

napukettoqq 协议端接入与多平台 node 矩阵留给后续阶段（债务清单见 MVP2-NOTES）。

## 债务清偿二结论（2026-09-13，master）

> 任务书见 `docs/DEBT2-PROMPT.md`，全部决策与沙盒实录见 `docs/DEBT2-NOTES.md`。
> 前置说明：DEBT-1 未执行（并行会话让行，仅文档入库），协议变更按预案以实际基线
> 0.2.0 → 0.2.1 patch 顺延；DEBT-1 复跑时继续 0.2.1 → 0.3.0。

**「node 死了就死、构建只能 Windows」收尾为「崩溃自愈、进程卫生、双壳构建、行尾无忧」
的健壮基座——完成。** 验收清单 §4.1~§4.11 全过（实录表见 DEBT2-NOTES）：

- **进程看护闭环**：:core `NodeIpc` 进程退出通知（exitCode + cause，优雅关停不通知；
  非优雅拆除就地 destroyForcibly 防双进程 + 调度器释放）+ 新 `NodeSupervisor` 看护器
  （1s/5s/15s 退避重启、10 分钟窗累计 3 次失败 → SEVERE 放弃终态、autoRestart=false
  只通知不重启）；:paper onDisable 停看护，重启经 factory 重建实例。
- **协议 0.2.1（唯一变更）**：ready 帧可选字段 `autoRestart`（Node 业务配置 SSOT，
  Java 消费宿主参数）；config schema 增 `runtime.autoRestart`（缺省 true）。
- **进程卫生**：`plugins/kurobot/node.pid`（spawn 写 winpid / 优雅关停删 / 残留 INFO
  提示异常退出）；放弃终态下 `/kurobot send` 明确报「自动重启已放弃」。
- **可观测**：启动就绪汇总行「就绪：插件 vX / node vY / 协议 vZ」（协议版本 :core
  硬编码副本 KurobotVersions）；embedded 哈希不符重建改「检测到打包内容变更（升级），
  已重建」文案。
- **重连一致性测试背书**：core 断连清理与重连快照/送达数/20 轮零泄漏 vitest 8 例
  （实现零改动——设计清理链闭合的回归证明）。
- **工程收尾**：`scripts/build-jar.mjs` 跨壳编排（Git Bash 与 cmd 双壳实测 exit=0，
  POSIX 贡献者债务关闭）；embed 严格模式 `KUROBOT_NODE_DIST_STRICT=1` + 回退 WARN；
  `.gitattributes` 补二进制例外（renormalize 零波及）。
- **重要架构发现**：Node 26（libuv）在 Windows 上子进程随父级联死亡——「强杀 node 留
  stub 孤儿」前提不再成立；stub 重连 10 次自杀保留为纵深防御（独立验证 10 次失败
  → 打印原因 → 退出码 1）。另：MSYS pid 坑、异步测试快照竞态、spotless up-to-date
  三坑实录见 DEBT2-NOTES 架构发现 B/C/D。

门禁终态：`pnpm check` / `pnpm test`（93 用例）/ `pnpm -r build` / `gradlew build` +
`:core:test --rerun`（:core 57 用例）全绿。下一步：MVP-3（napukettoqq 接入 + 多平台
矩阵）开题；DEBT-1（协议/业务补全）按其 NOTES 指引复跑。

## 债务清偿一结论（2026-09-13，master）

任务书 `docs/DEBT1-PROMPT.md` 全阶段（0~5）执行完毕，决策与验收实录见
`docs/DEBT1-NOTES.md`（D1-01~06 + 阶段 1/2 决策回填 + §4 验收表）。提交链：
1c32578（协议 0.3.0）→ 7f0f6c7（core 业务）→ 2959eee（embedded/stub）→ 4450012（阶段 4
设计先行）→ a1bac4a（:core/:paper）→ 本册收尾提交。

- **协议 0.3.0**：WS 帧集增 command/command_result、query/query_result、death；
  IPC 增 player_death、config_reload、execute_command_result 可选 output；hello 可选
  token；版本协商改主版本兼容区间（0.2.x 对端可连 0.3.0 服务端，1.x 拒绝）+ 未知帧
  两段式容忍（未知请求回执 unknown frame type、未知事件 debug 忽略，均不断连）。
- **业务闭环第一块**：群管理员映射（admins）+ WS command → 管理员判定 → IPC
  execute_command 透传 → Java 收集型 sender 执行 → 输出行回传 command_result；白名单
  SSOT 维持 MC 原生 whitelist.json（经 command 的 output 覆盖）；query status（最近一帧
  缓存）/bindings 本地作答；death 按绑定 fan-out；`/kurobot reload` → config_reload →
  复用 watch 推送路径。
- **鉴权与权限**：config 增 `token`（空 = 不鉴权向后兼容；非空 close 1008 拒绝）与
  `admins`；`kurobot.relay` 权限消费落地（negate 即静音）。配置字段说明见
  `docs/config-schema.md`（SSOT 是 core zod schema）。
- **重要架构发现（D1-04）**：Paper 的 VanillaCommandWrapper 拒绝自定义 CommandSender
  承接 vanilla 命令——双路径方案：Bukkit 命令直接收集；vanilla 命令回退真实 console
  sender 执行、输出由 log4j 主线程窗口捕获（VanillaFeedbackCapture）。放弃 NMS 代理
  （违背单 jar 通吃红线）。
- **测试资产（D1-05）**：`sandbox/fake-player.mjs` 离线模式假人（协议 769，零依赖）——
  无人值守注入真实 join/chat/death/quit 事件；1.21.4 协议坑实录（client_information
  particleStatus、C2S 帧号漂移、LastSeenMessages.Update 固定 BitSet）。
- **验收**：§4.1~§4.11 全过（实录表见 DEBT1-NOTES）。门禁终态：`pnpm check` /
  `pnpm test`（138 用例）/ `pnpm -r build` / `gradlew build` + `:core:test --rerun`
  （:core 65 用例）全绿。
- **遗留债务**：msgContinue/msgEnd 流式、status 周期上报、serverId 互联、napukettoqq
  接入（MVP-3）、koishi-plugin-kurobot 仓库、多平台矩阵/SHASUMS 严格模式；新增小债
  （vanilla 输出捕获窗口语义、fake-player 无保活）见 DEBT1-NOTES 债务清单。
