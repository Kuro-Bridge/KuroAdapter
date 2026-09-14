# KuroBridge 现状与路线（STATUS）

> 借鉴 NapukettoQQ 的 `STATUS.md` 形态：现状 + 关键决策点 + 下一步。开始任何工作前先读本文。

## 当前状态（2026-08-10）

**设计已定稿**（见 `architecture.md` + `DECISIONS.md`），仓库为空骨架，尚未开始代码。

- 已建：`readme.md`、`AGENTS.md`、`docs/architecture.md`、`docs/DECISIONS.md`、`docs/STATUS.md`、`docs/protocol/draft-v0.1.md`、仓库骨架（biome/tsconfig/package.json 等）、`bridge/protocol` 包。

## 关键决策点（已拍板，勿再翻烧饼）

| # | 决策 | 要点 |
|---|---|---|
| 1 | 单仓 monorepo | ADR-001 |
| 2 | Java 21 | ADR-002 |
| 3 | 协议 `kurobridge-ws` + 双层版本 | ADR-003 |
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

- 协议 `kurobridge-ws` 具体消息 schema 逐字段定稿（`bridge/protocol` 下一步细化，含 zod 源）。
- 独立仓库 koishi-plugin-kurobridge 的建立时间与 Koishi 版本基线（v4 稳定版）——JE 闭环后启动。
- `platforms/be` 家族骨架已建（2026-08-11）：`lse/`（TS）+ `endstone/`（C++ 薄壳预留），实现排期在 JE 闭环后。
- `platforms/je` 的 fabric/neoforge/velocity 模块为预留骨架，接入对应服务端 API 后启用。

## 下一步实现顺序（推荐）

```
0. 仓库骨架：biome.json / tsconfig.json / package.json / pnpm-workspace.yaml /
   vitest.config.ts / .editorconfig / mise.toml / lefthook.yml / CI 空跑
   （直接借鉴 NapukettoQQ 的配置体系）
1. bridge/protocol：zod schema SSOT（@kurobridge/protocol 包）+ draft 说明同步
2. bridge/core 最小闭环：connect → hello 握手 → 心跳 → chat 收发 → 重连
   （传输层抽象，先写 Node 实现，QuickJS 适配后续）
3. platforms/je 薄壳：IPC 客户端 + 进程管理 + 事件/命令/权限桥接
4. 嵌入式打包工具（tools/embed 已删，重建）+ sandbox 沙盒联调
5. koishi-plugin-kurobridge：独立仓库（ADR-018），复用 `@kurobridge/protocol` 发布版本
6. platforms/be：lse（LSE TS 适配，复用 bridge/core）→ endstone（C++ 薄壳）另行评估
```

## 原型机结论（2026-09-13，spike 分支 prototype/spike）

> 任务书见 `docs/PROTOTYPE-PROMPT.md`，全部决策与发现见 `docs/PROTOTYPE-NOTES.md`。

**命题「Paper → Java 薄壳 → Node 子进程（IPC）→ bridge/core（WS 服务端）→ 协议端」端到端跑通——成立。** 真实 Paper 1.21.4-232 沙盒验收全过：

- 插件加载 → node 拉起 → IPC ready（stdin/stdout JSON-lines，WS 动态端口）→ stub 孙进程连入 → hello/hello_ack 握手 → 心跳协议（单测+集成验证）。
- 双向消息：`/kurobridge send` → stub 收到并打印；stub 握手后消息 → 服务器 broadcast。
- 生命周期：`stop` → shutdown 帧 → Node 自杀 → 无孤儿进程；**node 被强杀 → 服务器不崩、主线程不卡**（IPC 永不阻塞主线程的关键架构性质验证通过）。
- 门禁：`pnpm check` / `pnpm test`（33+17 用例）/ `pnpm -r build` / `gradlew :core:test`（30 用例 + 真管道集成测试）/ `:paper:shadowJar` 全绿。

原型落地的最小实现（分支 prototype/spike）：

- `bridge/protocol`：WS+IPC 最小 schema 集（hello/hello_ack/ping/pong/chat ×2 + ready/game_chat/broadcast/execute_command/shutdown + *_result），解析层扁平化 transform（D-11）。
- `bridge/core`：传输接口（WsServer/IpcChannel/Logger 注入）+ CoreContext + KurobridgeServer 握手状态机 + Relay 假转发。
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
- **业务最小闭环**：`plugins/kurobridge/config.json`（缺失生成默认、mtime 轮询热重载）→ BindingTable
  → 转发规则（未绑定频道丢弃+debug 日志、游戏事件按绑定频道逐帧 fan-out、配置变更 →
  bindings_updated 推送 + hello_ack 快照联动）。Relay 假规则已删。
- **Java 桥接**：ConnectionListener（join/quit 帧 + 进出服 status 快照）、/kurobridge send 断连明确
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
  SHASUMS256.txt；直连失败走 `KUROBRIDGE_NODE_DIST_BASE` 镜像，缓存 `.cache/node-dist/`）→
  手搓最小 zip 读取器（零新依赖，stored/deflate + crc32，不支持 zip64）→ 产出
  `embedded/{node.exe, index.mjs, NODE_LICENSE, manifest.json}` 进 :paper resources。
  Node 原生 TS 剥离直接执行，vitest 10 例全程不发真网（下载器可注入）。
- **运行期解压加载链（:core EmbeddedRuntime）**：manifest sha256 幂等比对（复用/缺失/哈希
  不符三路径逐条日志）；名字校验整体前置防 zip slip（固定名读资源 + 单段白名单 +
  normalize 包含检查）；DigestInputStream 边拷边校验 + tmp 原子替换。JUnit 8 例。
- **KuroBridgePlugin 双模式**：`KUROBRIDGE_BUNDLE` 保留为开发覆盖（沙盒/CI 用 mise node）；未设 →
  JAR 解压到 `plugins/kurobridge/bin/`（与 Node 配置目录同基，规避 getDataFolder 大小写坑），
  失败 SEVERE + 无 IPC 降级不崩服。`pnpm build:jar` 一条命令全链路（gradlew.bat 接线）。
- **沙盒真装路径全过**：首装解压 3 件 → JAR 里的 node.exe 拉起 → stub 握手 → 双向消息
  （`/kurobridge send` ↔ stub 广播 `<stub-群友>` 进游戏）；二次启动「复用 3 / 解压 0」；
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
- **进程卫生**：`plugins/kurobridge/node.pid`（spawn 写 winpid / 优雅关停删 / 残留 INFO
  提示异常退出）；放弃终态下 `/kurobridge send` 明确报「自动重启已放弃」。
- **可观测**：启动就绪汇总行「就绪：插件 vX / node vY / 协议 vZ」（协议版本 :core
  硬编码副本 KurobridgeVersions）；embedded 哈希不符重建改「检测到打包内容变更（升级），
  已重建」文案。
- **重连一致性测试背书**：core 断连清理与重连快照/送达数/20 轮零泄漏 vitest 8 例
  （实现零改动——设计清理链闭合的回归证明）。
- **工程收尾**：`scripts/build-jar.mjs` 跨壳编排（Git Bash 与 cmd 双壳实测 exit=0，
  POSIX 贡献者债务关闭）；embed 严格模式 `KUROBRIDGE_NODE_DIST_STRICT=1` + 回退 WARN；
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
  缓存）/bindings 本地作答；death 按绑定 fan-out；`/kurobridge reload` → config_reload →
  复用 watch 推送路径。
- **鉴权与权限**：config 增 `token`（空 = 不鉴权向后兼容；非空 close 1008 拒绝）与
  `admins`；`kurobridge.relay` 权限消费落地（negate 即静音）。配置字段说明见
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
  接入（MVP-3）、koishi-plugin-kurobridge 仓库、多平台矩阵/SHASUMS 严格模式；新增小债
  （vanilla 输出捕获窗口语义、fake-player 无保活）见 DEBT1-NOTES 债务清单。

## MVP 阶段三结论（2026-09-13，master）

> 任务书见 `docs/MVP3-PROMPT.md`，全部决策与沙盒实录见 `docs/MVP3-NOTES.md`（M3-01~10）。

**「真实协议端无处可连、无据可依」补齐为「固定端口 + 绑定地址 + 安全基线 + 官方对端
指南」的 external 接入基座——完成。** 范围由用户拍板：只做 external 形态（napukettoqq
独立部署连入），JAR 内嵌留 MVP-4；napukettoqq 侧适配器在 NapukettoQQ 仓库另册执行，
本册产出 `docs/protocol/peer-guide.md` 是其实现 SSOT。验收清单 §4 全过：

- **协议 0.3.1（patch）**：hello 可选 `client` 自报身份串（建议 `名称/版本`），服务端仅
  连接日志辨识、不做行为分支；对 0.2.x/0.3.0 对端双向兼容。WS_SUBPROTOCOL 与主版本
  兼容协商规则不动。
- **config 增顶层 `ws` 段**（形状 SSOT 归 core zod schema，消费在 embedded——监听参数
  是宿主事务，`WsServer` 接口不感知，ADR-028）：整段缺省 = 动态端口 + 全部接口（现状
  不变）；`port` 固定端口 / `host` 绑定地址 / 只配 host = 动态端口 + 指定地址。
- **NodeWsServer 参数化 + 绑定失败语义**：构造收 `{host?, port?, logger?}`；EADDRINUSE
  经 ws 库 error 事件异步到达（实测构造不抛）→ 一次性 error 监听 + listening 事件竞态
  收口，reject `WsBindError`（含端口与原因）→ bootstrap error 日志 + 非零退出；重启
  收敛于 Java 看护器退避（1s/5s/15s，10 分钟窗 3 次放弃），不新增重试机制。安全基线：
  ws 段 + 空 token → 启动 WARN 不阻断。
- **stub 独立连入模式**：`KUROBRIDGE_STUB_WS_URL`（独立进程模拟 external 对端）/
  `KUROBRIDGE_STUB_CLIENT`（hello 自报身份）；双独立 stub 并存、广播双方可达无串扰。
- **docs/protocol/peer-guide.md（新建）**：外部协议端唯一实现依据——连接与子协议、
  握手/协商/鉴权（1002/1008 区分）、心跳、重连策略（退避 + 反模式点名）、逐帧字段表
  （对照 zod 现源）、业务约定（channel=群号 / admins userId=QQ 号 / 富文本降级）、
  安全基线（token 必配 / TLS 隧道）、完整时序示例、版本演进速查。
- 沙盒验收证据全采集（固定端口/绑定失败/空 token WARN/client 展示/双对端/DEBT-1 四项
  回归），实录表见 MVP3-NOTES。附带发现：Windows 通配与特定地址绑定可并存（绑定失败
  复现须同地址形态）；fake-player 补 teleport confirm 修复玩家半生成僵死态（本地资产）。

门禁终态：`pnpm check` / `pnpm test`（146 用例）/ `pnpm -r build` / `gradlew build` +
`:core:test --rerun`（:core 65 用例）全绿。提交链：b0809ef（协议 0.3.1 + 设计先行）→
9d06bbd（ws 段 + 参数化）→ 4a834d4（stub + 冒烟）→ a8ee695（peer-guide）→ 本册收尾。
下一步：napukettoqq 侧 kurobridge 适配器任务书（以 peer-guide.md 为 SSOT，NapukettoQQ
仓库执行）；MVP-4（embedded 形态）与本册债务清单续排。

## MVP 阶段四结论（2026-09-14，master）

> 任务书见 `docs/MVP4-PROMPT.md`，全部决策与沙盒实录见 `docs/MVP4-NOTES.md`（M4-01~10）。

**「开箱即用」最后一环落地：JAR 内嵌真 QQ 协议端——embedded 形态完成。** ADR-022 孙进程
从 stub 换成 napuketto 真身，进程树 `Java → node → napuketto CLI(supervisor) → boot →
self-host`（最深四层）全链实证；协议 0.3.1 一字未动、napuketto 仓零改动。验收清单 §4
无人值守部分全过（实录表见 MVP4-NOTES §4）：

- **config 增顶层 `embedded` 段**（形状 SSOT 归 core zod，ADR-028 先例）：
  `{ napuketto: { enabled, configPath?, dataDir? } }`；整段缺省 = 现状不变。
  **固定端口强制**：enabled 且无 `ws.port` → 明确 error + exit(1)（WsBindError 同族，
  看护器退避收敛）；非 Windows 宿主 → error + 不拉起（Node 继续纯 WS 服务端）。
- **napuketto spawner**（bridge/embedded，全依赖可注入）：env 只注入
  `NAPKETTO_CONFIG`/`NAPKETTO_DATA`（napuketto TOML 是其侧 SSOT，KuroAdapter 只指路）、
  stdio 全 pipe 逐行捕获 `[napuketto]` 前缀按级别分流、守卫纯函数化
  （`decideNapukettoLaunch`）。生命周期：优雅关停 = `taskkill /T /F` 树杀（考据：boot 层
  无信号处理器，napuketto 自家 stop 同款）→ 5s 有界等待；CLI 意外退出 → node exit(1) →
  看护器退避重启 → 重拉 CLI（凭据原生层 quick-login 自恢复）。
- **打包链**：embed.ts 增 napuketto 嵌包收集（npm 真实文件树 → 零依赖 zip writer →
  单一 `napuketto.zip` 7.6MB + `NAPUKETTO_LICENSES` 124KB 许可聚合，版本 SSOT =
  bridge/embedded package.json 精确 pin）；EmbeddedRuntime 增哨兵幂等展开
  （`.kurobridge-install.json` 记 zip sha256，升级重建，zip slip 防护）。
  JAR 41MB → **48.5MB**；红线 grep：wrapper.node / QQ 安装包零命中（嵌包清单与许可
  全表见 MVP4-NOTES §3）。
- **QR 文件交接（零协议变更）**：node 轮询 napuketto 数据目录 `cache/qrcode.png`
  （mtime+size，多账号取最新）+ 捕获流固定文案 URL 正则 → 原子写 `plugins/kurobridge/
  qr.png` + `qr.json`；`:paper` 增 `kurobridge qr` 子命令只读展示（零 IPC）。QR 过期自动
  刷新链路实测可见。
- **沙盒实录**：无 embedded 段回归（stub/动态端口/关停无孤儿）→ 固定端口快速失败
  （退避 3 次放弃、napuketto 未拉起）→ embedded 启动链（`[napuketto]` 日志、QQ 定位
  零下载、QR 生成、四层树实证）→ 生命周期矩阵（stop 树杀零孤儿 / 强杀 node T+1s
  四层级联死（DEBT-2 发现复验）/ CLI 意外退出看护器重启 / instance.lock 残留自愈）。
- **架构发现**：napuketto 自身 autoRestart 在登录超时后自愈重启 boot（嵌入层无感）；
  NAPUTO_SMOKE/PROBE 均需真登录，无免登录烟测路径（无人值守验收止于 QR 层）。

门禁终态：`pnpm check` / `pnpm test`（167 用例）/ `pnpm -r build` / `gradlew build` +
`:core:test --rerun`（:core 69 用例）全绿。真机扫码终验步骤见 MVP4-NOTES §6 协作清单。
下一步：koishi-plugin-kurobridge 独立仓库启动、platforms/be（LSE/Endstone）、债务清单
（wine 宿主、多平台构建矩阵等）续排。

## 改名阶段结论（2026-09-14，master）

> 任务书 `docs/RENAME-PROMPT.md`，决策与验收实录见 `docs/RENAME-NOTES.md`（R-00~06），
> 映射表见 **ADR-030**。历史册正文未改写，新旧名混读以 ADR-030 映射表为准。

**品牌迁移 KuroBot → KuroBridge 一次改净——完成。** 每阶段至少一提交、门禁逐阶段绿，
提交链 d9028de → ebdc1e6 → 264bae5 → c1262ec → 460a717 → 4a29d33 → 收尾提交：

- **协议 0.4.0（唯一 breaking = 握手子协议字符串）**：`kurobridge-ws` / `kurobridge-ws.v1` /
  0.4.0（ADR-030）；帧形状零变化（171 用例零逻辑改动背书）；`.v1` 大版本语义与主版本兼容
  区间协商规则不动。
- **全链标识换新**：npm scope `@kuro-bridge/*`（workspace 重链后构建绿）、用户标识
  `kurobridge`（`/kurobridge` 命令、`plugins/kurobridge/`、插件名 KuroBridge、Java 包
  `com.kurobridge`、JAR `kurobridge-0.1.0.jar`、哨兵 `.kurobridge-install.json`）、env 前缀
  `KUROBRIDGE_*`。napuketto 外部契约原样（env/文件名/`[accounts.kurobot]` 段/client 自报/
  `@napuketto/*` pin 0.1.17）。
- **验收全过**：门禁（TS 171 用例 + gradle `:core:test --rerun`）、残留 grep（仅 3 处契约
  豁免，见 RENAME-NOTES R-03）、打包（嵌包与 48.5MB 基线逐字节同源）、沙盒 stub 冒烟
  （子协议协商 + token 鉴权 + 三子命令 + 无孤儿关停）。
- **待协作**：npm 建 org 发布 `@kuro-bridge/protocol@0.4.0` → NapukettoQQ 联动册
  （RENAME-PROMPT §7）→ 真链路互通复验并关闭发现 H。此刻 napuketto 端尚未发布 kurobot
  支持（MVP4-NOTES 发现 H），正好以新名一次性发布，避免双重发布。
