# KuroBot 债务清偿一决策记录（DEBT1-NOTES）

> 配套任务书：`docs/DEBT1-PROMPT.md`。本文记录债务清偿一（DEBT-1）期间的全部自主决策、
> 放弃的替代方案与阻塞记录。无人值守规则：所有决策自行拍板并记于此。
>
> **状态：任务因硬阻塞提前结束（见 D1-01）。** 阶段 0（设计先行 + 基线验证）部分完成后让行；
> 任务书保留，待 DEBT-2 会话完成并提交后**原样复跑**（复跑指引见文末）。

## 环境与基线（阶段 0，2026-09-13）

- 门禁基线全绿：`mise exec -- pnpm check` / `pnpm test`（80 用例）/ `pnpm -r build`；
  `platforms/je` 下 `mise exec -- ./gradlew.bat build`（22 任务，输出重定向文件）全绿。
- 沙盒冒烟通过：`scripts/paper-start.sh` → 插件加载 → node 拉起 → stub 握手成功
  （protocolVersion=0.2.0，channelBindings=[stub-channel]）→ stub 消息广播进游戏 →
  Done (8.731s)；`paper-stop.sh` 优雅退出。
- GPG 签名缓存状态未验证（本会话未走到提交阶段）。

## 决策记录

### D1-01 硬阻塞：检测到并行 DEBT-2 会话在同一工作区写码 → 本任务让行结束

**发现经过（时间线，2026-09-13）：**

- 本会话 16:50 前后启动，完成必读文档通读与基线验证（当时 `git status` 干净，仅
  DEBT1/DEBT2-PROMPT.md 两个未跟踪文件）。
- 17:09 起工作区出现本会话**未做过的源码改动**：`bridge/protocol/src/meta.ts`
  （PROTOCOL_VERSION 0.2.0 → 0.2.1）、`ipc.ts`（ready 帧增 `autoRestart` 可选字段）、
  `stub/peer.mjs`（0.2.1）、`NodeIpc.java`（+81 行进程退出通知）、新建
  `NodeSupervisor.java` / `KurobotVersions.java` / `NodeSupervisorTest.java` 等——内容与
  DEBT2-PROMPT.md §1.2 的 Watchdog/autoRestart/PID 逐一对应，注释明写「DEBT-2」。
- mtime 持续更新（17:09 → 17:16，每分钟级节奏）；17:14–17:19 之间对方完成其阶段 0 提交
  **2e282b9**（「docs: 债务清偿二设计先行——三包 design.md 增 DEBT-2 小节…DEBT2-PROMPT 入库」），
  HEAD 由 51051dd 前移。
- 系统进程核实：ZCode 桌面端存在多个 `app-server --stdio` 会话进程；判断为用户在并行会话中
  启动了 DEBT-2 任务书（其前言允许「若在 DEBT-1 之前执行，按实际版本基线顺延」——对方正是
  按 0.2.0 → 0.2.1 patch 顺延实施的）。
- 本会话期间一次 Edit 已因并发修改失败（core 的 design.md，对方同样在做「设计先行」小节）。

**冲突面分析：** DEBT-1 与 DEBT-2 的剩余阶段在同一批文件上全面重叠——
`server.ts`/`relay.ts`（DEBT-1 token/协商/query/command vs DEBT-2 断连一致性）、
`NodeIpc.java`（DEBT-1 execute_command 输出收集/player_death/config_reload vs DEBT-2
退出通知/看护）、`stub/peer.mjs`（DEBT-1 0.3.0 + env 钩子 vs DEBT-2 重连 10 次自杀）、
embedded bootstrap（token 注入 vs autoRestart 上报）、config schema（token/admins vs
runtime.autoRestart）、STATUS/ADR（双方都要追加结论与新编号）。两个无人值守会话在同一
未提交工作区并发写码必然互相践踏（门禁互红、提交互相裹挟、Edit 竞态）。

**依据与放弃的方案：**

- DEBT2-PROMPT 前言明示「**强烈建议按 DEBT-1 → DEBT-2 顺序执行**」——对方已逆序启动，
  顺序修复的唯一无损方式是其中一方让行；本任务书 §0 允许硬阻塞时结束并记 NOTES。
- 放弃方案 1：**并行推进**——必然双输（对方未提交工作与本阶段代码互相踩踏，且 master
  历史会把两册改动搅在一起）。
- 放弃方案 2：**等待对方完成后接力**——对方尚余阶段 3~5（预计小时级），违反「30 分钟无
  实质进展」卡住规则；且其每阶段小步提交会把本会话留在工作区的文件卷进它的提交。
- 放弃方案 3：**git worktree 隔离作业**——worktree 目录必然在任务书划定的工作区
  （`C:\Dev\MC-Ecosystem\KuroAdapter`）之外，违反 §0 红线；置于仓库内部则污染对方
  `git status` 并引发 biome/gradle 扫描混乱。

**让行时的现场快照：**

- HEAD = 2e282b9（对方的 DEBT-2 阶段 0 提交）；其下为 51051dd（MVP 阶段二结论）。
- 工作区未提交改动（除本会话两处外全部属 DEBT-2 阶段 1/2 进行中产物）：
  `stub/peer.mjs`、`protocol/src/meta.ts`、`protocol/src/messages/ipc.ts(+test)`、
  `:core` 的 EmbeddedRuntime / InboundFrame / IpcFrameCodec / NodeIpc / NodeIpcListener /
  NodeSupervisor(新) / KurobotVersions(新) / NodeSupervisorTest(新)、
  NodeIpcTest / NodeIpcBundleIntegrationTest、`:paper` 的 NodeRequestHandler。
- 本会话足迹仅两处（均无代码影响），已随 **941e5d7** 以路径限定方式入库（未卷入对方
  任何在途代码；提交时 lefthook 门禁恰为绿、GPG 签名正常）：
  `bridge/protocol/docs/design.md` 的「债务清偿一」设计小节（15 行）与本文。

## 已完成工作（阶段 0 部分，复跑可直接复用）

1. **必读文档全部通读**（STATUS / MVP1-NOTES / MVP2-NOTES / DECISIONS / 协议草稿 /
   协议与 core / embedded / je 源码与 design / Java 薄壳四类 / 沙盒脚本）。
2. **基线验证全绿**（见上）。
3. **协议 0.3.0 设计先行已定稿**：`bridge/protocol/docs/design.md`「债务清偿一（DEBT-1）」
   小节，含 10 条设计决策——版本协商改主版本兼容区间（`isProtocolVersionCompatible`
   纯函数）、未知帧容忍（两段式解析：`wireFrameSchema` 先取 type 再分发；未知请求帧回
   `<type>_result {ok:false,"unknown frame type"}`，未知事件帧 debug 忽略，均不断连；
   IPC 侧不做容忍）、hello 可选 token（close 1008）、command/query 请求族帧形、
   death/player_death 帧（字段按任务书原文 `player`/`message`，与 join/leave 的
   `playerName` 命名不一致已记录并照办）、config_reload 空体事件、
   execute_command_result 增 `output`（与 WS command_result 共用结果体）、聚合 union
   更新清单。**该小节若在工作区仍可复用；已被后续提交带走亦无碍，复跑时重写即可。**

## 阶段 1~5 未开始

> **复跑修正（2026-09-13）**：本小节已过时——阶段 1（1c32578）、阶段 2（7f0f6c7）已在
> 复跑会话完成提交，embedded bootstrap 一并随阶段 2 落地；阶段 1/2 期间未及时记入本文件
> 的决策，由阶段 5 收尾统一回填（编号顺延既有最大号）。

任务书 §3 的阶段 1（protocol 0.3.0）、阶段 2（core）、阶段 3（embedded + stub）、
阶段 4（:core/:paper）、阶段 5（沙盒验收 + 文档收尾）均未动笔，无半成品代码遗留。

## 复跑指引（DEBT-2 完成并全部提交后，原样重发 DEBT1-PROMPT 即可）

1. **版本基线**：DEBT-2 引入 ready.autoRestart 后基线为 0.2.x；DEBT-1 仍按任务书升
   **0.3.0**（minor 语义不变，autoRestart 为可选字段自然兼容）。
2. **config schema 共存**：DEBT-2 在 core 的 zod config 中加了 `runtime` 字段——DEBT-1
   扩展 `token`/`admins` 时**不得剥离**该字段（`parseConfig` 保持透传/保留语义）。
3. **stub 基线**：peer.mjs 已含 DEBT-2 的「连续重连 10 次自杀」逻辑，0.3.0 升级
   （env 钩子 + 验收交互命令）必须在其上叠加，勿回退。
4. **ADR 编号**：动手前重读 `docs/DECISIONS.md` 末尾确认最大号（DEBT-2 可能已占用
   ADR-026+；任务书本就要求先确认）。
5. **NodeIpc 基线**：DEBT-2 重构了退出通知/看护链路，阶段 4 的 execute_command 输出收集
   （IpcResult 增 output、Result 帧扩展）与 sendPlayerDeath/sendConfigReload 需在重构后
   的形状上实现。
6. 本会话的设计小节已随 941e5d7 入库，复跑会话可直接采用或按需改写。

---

# 复跑会话记录（2026-09-13 起，按阶段追加）

## 阶段 3（bridge/embedded + stub）

### D1-02 发现并修复：阶段 2 提交漏带协议包导出，HEAD 曾处于不自洽状态

- 阶段 2 的 `bridge/core/src/server.ts` 已 `import { helloFrame, WS_INBOUND_TYPES }
  from "@kurobot/protocol"`，但这两个导出在 `bridge/protocol/src` 的对应改动**未随
  7f0f6c7 提交**（遗留在工作区）。当时 `pnpm check` 能过纯靠本地 dist 产物恰好包含
  导出（红线 5 的「跨包解析走 dist」掩盖了源不一致）——新 clone 直接构建必红。
- 处置：两个协议文件随阶段 3 提交一并入库。教训（阶段 5 复盘用）：提交前应
  `git stash` 工作区再验一次门禁，或提交后立刻 `git status` 确认无漏网文件。
- 替代方案（放弃）：单独出 fixup 提交——本阶段尚未提交过任何内容，并入阶段 3 提交
  代价最小且提交说明可完整说明来龙去脉。

### D1-03 stub 交互命令的连接跟踪方式：connect() 内直赋 currentWs

- 半成品版本在文件末尾用「包装 connect + 再 new 一个 WebSocket」跟踪当前连接，
  实际会向服务端建立**两条**连接：被跟踪的那条无任何事件处理器，交互命令全部发到
  死套接字。改为在 `connect()` 内部直接 `currentWs = ws`，删掉包装。
- 顺带删除无引用的 `resultTypeOf`（结果帧匹配用 `endsWith("_result")` 已覆盖）。

### 其余落实情况

- **bootstrap 注入 token/admins**：已随阶段 2 提前落地（`bridge/embedded/src/index.ts`
  ——CoreContext 注入 token（reload 不刷新，改 token 需重启）、Relay 注入 AdminTable、
  降级路径 `defaultConfig()`、启动日志含鉴权/管理员状态）。
- **NodeConfigStore 新字段**：零额外改动——`writeDefault` 走 core 的 `defaultConfig()`
  （0.3.0 起自含 `token: ""` / `admins: []` / `runtime`），旧配置缺字段经 zod default
  补齐（core config.test.ts 已覆盖向后兼容），「缺省生成兼容旧配置」天然成立；
  embedded 包无单测（包策略如此，沙盒验收兜底）。
- **stub 0.3.0**：版本常量、hello 可选 token、三个任务书 env 钩子 +
  SEND_COMMAND/SEND_QUERY/SEND_UNKNOWN 自动化序列、stdin 交互命令、death/
  command_result/query_result/未知回执处理；DEBT-2 自杀逻辑原样保留。
- 门禁：`mise exec -- pnpm -r build` / `pnpm check` / `pnpm test`（138 用例）全绿；
  embedded/stub 不涉 Java，gradle 门禁留阶段 4 一并跑。

## 阶段 4（platforms/je，2026-09-13，提交 a1bac4a + 沙盒期补丁）

### D1-04 发现并修复：Paper 拒绝自定义 CommandSender 承接 vanilla 命令 → log4j 窗口捕获回退

- 任务书 §1.2 设想「收集型 CommandSender + 主线程调度」收集全部命令输出。沙盒实测：
  **Bukkit/插件命令**（version 等）成功收集；**vanilla 命令**（whitelist/say 等）100% 抛
  `IllegalArgumentException: Cannot make ... a vanilla command listener`——
  `VanillaCommandWrapper.getListener` 只认内部 Craft* sender 类型与 ProxiedNativeCommandSender
  （后者是 NMS 接口，编译依赖 paper-server，违背「paper-api 单 jar 通吃」红线）。
- 处置（双路径）：自定义 sender 先行（Bukkit 命令直接收集）；抛出上述特征异常时回退真实
  console sender 执行，vanilla 反馈必然经 `DedicatedServer.sendMessage` 落 log4j 控制台流，
  由 `VanillaFeedbackCapture`（root logger 临时 appender，只收 `Server thread` +
  attach/detach 窗口内行）收集。两条路径输出互斥不重复。
- 放弃方案：① log4j 全量捕获不做 sender 回退（Bukkit 命令输出不经日志，会漏）；②
  ProxiedNativeCommandSender 动态代理（依赖 NMS 类型，版本锁定，红线不允许）；③ 只支持
  Bukkit 命令收集、vanilla 返回占位行（§4.5「output 含白名单内容」无法达成）。
- 验收对照：`whitelist list` → `成功，输出行 [There are 1 whitelisted player(s): FakePlayer]`。

### 其余落实情况

- :core：IpcFrameCodec 出帧增 player_death（message 允许空串）/config_reload（空体事件）；
  encodeResult 增 output（null/空不产生字段）；decodeResult 仅 execute_command_result 的
  ok 分支解析 output（broadcast_result 忽略——镜像 zod 非 strict 的 strip 语义而非拒帧）；
  IpcResult.ok() 改 default 委托 ok(List)；NodeIpc.executeCommand 返回
  `CompletableFuture<List<String>>`（未带 output 归一空列表；pending 内部类型随迁，
  broadcast 用 thenApply 保持 Void 签名）。KurobotVersions 同步 0.3.0。
- :paper：DeathListener（deathMessage null → 空串兜底）、CollectingCommandSender（控制台
  语义恒 true；name 与 ConsoleSender 对齐）、PlainText（plain 序列化器共用，deprecation
  说明随迁）、KurobotCommand reload 子命令、ChatListener kurobot.relay 检查、
  NodeRequestHandler 回执时序改「真实执行完成后 ok」。
- 测试：:core 44→65（codec 新帧/output 编码与按帧型解析/executeCommand future 三态/
  listener 回执 output 编码）；真 bundle 集成测试补 player_death 端到端；build
  `:core:test --rerun` 真跑全绿。CollectingCommandSender 的 adventure 适配按 paper-api
  1.21.4 实际签名落（extends Audience 而非 ForwardingAudience；汇聚点
  sendMessage(Identity,Component,MessageType) 为 no-op sink 必须覆写）。

## 阶段 5（沙盒端到端验收 + 文档收尾，2026-09-13）

### D1-05 无人值守验收需要「真实玩家」→ 自制离线模式假人（sandbox/fake-player.mjs）

- §4.7（游戏内 /kill → death 帧）与 §4.9（relay negate → 聊天不转发）都需玩家在线触发
  Bukkit 事件。选择自制零依赖 MC 协议假人（handshake→login→configuration→play，协议 769，
  online-mode=false 免加密）而非降级只靠集成测试证据——death/relay 的 Bukkit 事件接线
  （PlayerDeathEvent/AsyncChatEvent）没有其它覆盖面。
- 协议坑实录（1.21.4）：client_information 末位**新增 particleStatus 字段**（缺了直接
  DecoderException 被踢）；C2S play 帧号随版本漂移（0x18 被解码为 interact；chat 实测
  0x07）；chat body 的 LastSeenMessages.Update = varint offset + **固定 20 位 BitSet**
  （3 字节、无长度前缀）；configuration 态需回 finish_configuration ack / keepalive /
  select_known_packs 空表。play 态刻意不发 keepalive 响应（ID 漂移风险 > 30s 超时窗口）。
- 结论：假人一次注入即得 join/chat/death/quit 全链真实事件，成为本沙盒的长期测试资产。

### D1-06 无人值守会话承载长驻沙盒服务器：run_in_background 承载主进程

- 前台工具调用里 `paper-start.sh` 启动后，**调用结束会连带杀掉 tail|java 进程树**
  （stdin EOF → Paper 优雅停机），服务器活不过下一次工具调用——两次启动两次复现。
- 处置：`run_in_background` 任务承载 `tail -f cmd.in | java -jar paper.jar`（任务体常驻，
  跨调用存活）；关服用 TaskStop + paper-stop.sh。
- 连带踩坑：run_in_background 启动**不更新 paper.pid** → paper-stop.sh 的 alive() 查
  旧 pid 判「未在运行」静默失效 → 下次启动 world 目录锁冲突（DirectoryLock）。
  无人值守流程应以 TaskStop/端口检查为准，勿依赖 paper.pid。

### 验收实录（任务书 §4 清单）

| # | 项 | 结果 | 证据（grep console.log / 测试） |
|---|---|---|---|
| 1 | 门禁全绿 | ✅ | pnpm check/test 138 用例；pnpm -r build；gradlew build + :core:test --rerun 65 用例 |
| 2 | 版本协商 | ✅ | `hello 版本=1.0.0` → `握手被拒：protocol version mismatch` + `未握手连接关闭` + 持续重连（1002 由 server.test.ts 断言）；`0.2.0` → `握手成功 protocolVersion=0.3.0` |
| 3 | token | ✅ | `鉴权 token：已启用`；无 token → `握手被拒：auth failed`；错误 token → 同拒；正确 token → `握手成功`；空 token 会话全放行（会话 A） |
| 4 | 未知帧容忍 | ✅ | 请求帧 → `回执 unknown frame type` + 连接保持；事件帧 → `收到未知事件帧 stub_unknown_event，忽略` + 连接保持 |
| 5 | command 双向 | ✅ | 管理员 `whitelist list` → `成功，输出行 [There are 1 whitelisted player(s): FakePlayer]`；guest → `失败（error=forbidden）` + `非管理员来源执行命令被拒绝：...userId=stub-guest` warn |
| 6 | query | ✅ | `query: bindings 结果：成功，data=["stub-channel"]`；join 后 `query: status 结果：成功，data={"tps":20,"onlinePlayers":1,...}`；join 前 status → `失败（error=no status yet)`（设计预期） |
| 7 | death 事件 | ✅ | 假人被僵尸击杀（survival 自然事件）→ `收到死亡：[stub-channel] FakePlayer FakePlayer was slain by Zombie`；:core 集成测试 player_death 端到端 |
| 8 | reload | ✅ | `已通知重载` → `收到配置重载通知（config_reload）` → `绑定表已更新：[stub-channel, stub-channel-2]` → stub `收到绑定变更` → 变更后消息进游戏 |
| 9 | relay 权限 | ✅ | default true：`收到游戏聊天：<FakePlayer> ...`；permissions.yml negate false：join/status 正常推送而聊天 0 帧转发 |
| 10 | 回归 | ✅ | 双向消息/绑定 fan-out/热重载/JAR 解压升级重建/优雅关停链（`收到关机通知`→`stdin EOF`→stub 退出）均有会话证据；DEBT-2 看护不在本册范围 |
| 11 | 文档收尾 | ✅ | 本表 + STATUS「债务清偿一结论」+ docs/config-schema.md + design 回填 |

### 债务清单（遗留与延续项）

- **msgContinue/msgEnd 流式回报**、**status 周期上报**（M-04 决策维持，按需 query 已覆盖
  状态面板）、**多服务器 serverId 互联**、**napukettoqq 协议端接入**（MVP-3）、
  **koishi-plugin-kurobot 独立仓库**、**多平台 node 矩阵 / build:jar SHASUMS 严格模式**
  ——全部延续至 MVP-3 及后续。
- 新增小债：① `whitelist list` 输出行依赖 log4j 捕获，vanilla 命令输出为「主线程窗口内
  日志行」语义，多命令并发时理论上可能混入同窗口日志行（当前单命令串行可接受）；②
  CollectingCommandSender 对非 Paper 1.21.x 的 sendMessage 变体集合未经矩阵验证（多版本
  策略下随适配层重验）；③ sandbox/fake-player.mjs 的 play 态保活未实现，仅适合短窗验收。

### 阶段 1/2 决策欠账回填（当时未记入本文件，从提交/设计提取）

阶段 1（1c32578）与阶段 2（7f0f6c7）期间的实际决策均已固化于
`bridge/protocol/docs/design.md` 与 `bridge/core/docs/design.md` 的「债务清偿一（DEBT-1）」
小节及提交说明，要点摘录（编号顺延既有最大号，非当时实时编号）：

- 版本协商改主版本兼容区间（`isProtocolVersionCompatible` 纯函数），不兼容走既有拒绝
  路径（hello_ack ok:false + close 1002）；未知帧容忍采用两段式解析（wireFrameSchema 先取
  type：未知请求回 `<type>_result unknown frame type`、未知响应不回执防乒乓、未知事件
  debug 忽略，均不断连）；IPC 侧不做容忍（受控对端）。
- token 校验在协商通过后进行（close 1008）；token 进程生命周期内固定，reload 不刷新。
- query 本地作答（sendStatus 顺带缓存最近一帧；bindings 回实时快照；无缓存回
  no status yet）；command 走 AdminTable 判定 + IPC 透传；player_death 按绑定 fan-out；
  config_reload 重读复用 watch 路径（读取失败保留旧值）。
- execute_command_result 与 WS command_result 共用结果体（output 仅 ok 分支、空输出
  不产生字段）；death 帧字段按任务书原文 `player`/`message`（与 join/leave 的
  playerName 不一致已记录并照办）。
