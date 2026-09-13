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
