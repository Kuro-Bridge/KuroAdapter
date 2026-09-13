# KuroBot 债务清偿一任务书（无人值守）——协议补全与业务指令（DEBT-1）

> 本文件是一次**无人值守任务**的完整任务书。执行智能体拿到本文即视为唯一指令来源，与任何对话历史无关。
> 完成后本文件保留，作为债务清偿一的存档。
> 前置状态：MVP 阶段一、二已完成并验收（master；结论见 `docs/STATUS.md`，决策与踩坑见 `docs/MVP1-NOTES.md` / `docs/MVP2-NOTES.md`）。
> 范围由用户拍板：**清偿 MVP1 债务中「协议 + 业务」半边**——鉴权与版本协商、command/query 请求族、death 事件、白名单/群管理员映射/指令权限、配置管理命令。进程健壮性（Watchdog/重启/孤儿）与工程收尾属**债务清偿二（DEBT2-PROMPT.md）**，本阶段不做。
> 与 DEBT-2 的顺序：**先本册后 DEBT-2**（本册集中全部协议变更，DEBT-2 几乎零协议改动，后做合并代价最小）。

---

## 0. 边界与纪律（先读，违反即任务失败）

- **工作区**：`C:\Dev\MC-Ecosystem\KuroAdapter`。所有文件的创建/修改**只允许发生在此目录内**。
- **禁止修改** `C:\Dev\Bot-Dev\` 下任何项目。
- **无人值守规则：禁止向用户提问。** 所有决策自行拍板，并全部记入 `docs/DEBT1-NOTES.md`（新建，决策编号 D1-01 起；做了什么决定、为什么、放弃了哪些替代方案）。只有遇到不停止就无法继续的硬阻塞时才允许结束任务，结束时在 NOTES 里写清阻塞点。
- **Git**：直接在 `master` 上小步提交（简体中文提交说明，每阶段至少一个提交）。**不 push、不改写历史**。pre-commit 钩子（lefthook：`pnpm check` + `pnpm test`）被拒就修到绿再提交。
- **GPG 注意**：仓库开了 commit 签名。若 `git commit` 超过约 2 分钟无输出，疑似 gpg-agent 口令缓存过期挂起——**禁止 `--no-gpg-sign`**；结束任务并在 NOTES 写明已暂存的变更清单，交由用户交互提交。
- 不要修改 `AGENTS.md` 与 `docs/DECISIONS.md` 中既有 ADR 的结论；本阶段新决策**追加**新 ADR（**编号从 ADR-026 起**，先读 `docs/DECISIONS.md` 末尾确认最大号）。
- **一切构建/测试命令统一经 `mise exec -- <cmd>`**（PATH 直连的 node 是 24、java 是 21；mise 提供 node 26.7.0 / java 25.0.2 / gradle 9.7.0）。
- **卡住规则**：任一阶段超过约 30 分钟无实质进展 → 降级目标并记 NOTES，继续推进不原地打转。

## 1. 目标与范围

现状：协议 v0.2 只有事件集 + hello/ping（`docs/protocol/draft-v0.1.md` §2 的 `command`/`query`/`death` 均未实装）；版本协商是精确相等（`bridge/core/src/server.ts:259`）；鉴权 token 未做（draft §4.1）；白名单/权限/群管理员映射为零；`kurobot.relay` 权限节点声明了但两端都没消费；写配置只能手改 JSON。本阶段一次清偿。

### 1.1 必须守住的红线（同 AGENTS.md，违反即任务失败）

1. 消息类型一律 `import { ... } from "@kurobot/protocol"`，禁止手写；协议 SSOT 是 `bridge/protocol` 的 zod schema。
2. `bridge/core` 平台无关（零 Node API）；logger/clock/scheduler 一律注入。
3. **Java 薄壳不做业务**：白名单执行走 Bukkit 原生 `whitelist` 命令（Java 只 dispatch），管理员判定、来源校验全在 core；IPC 只走 stdin/stdout JSON-lines；kurobot 永远是 WS 服务端。
4. 依赖方向遵守 AGENTS.md 第 7 条；不引入未指明的新依赖；不复制 HuHoBot / NapCat / NapukettoQQ 代码。
5. **workspace 跨包解析走 dist 产物**：改 `bridge/protocol` 源后必须先 `pnpm -r build` 再 `pnpm check`/`pnpm test`（症状：新字段在消费方「不存在」，MVP1-NOTES 架构发现）。

### 1.2 已拍板的关键决策（按此实现，若有更优方案须在 NOTES 论证后仍自行拍板）

- **协议版本 → 0.3.0**（`bridge/protocol/src/meta.ts` 的 `PROTOCOL_VERSION`）；`WS_SUBPROTOCOL = "kurobot-ws.v1"` 不动。
- **版本协商改兼容区间**：hello 校验规则从精确相等改为「**主版本号相同即兼容**」（0.2.0 对端可连 0.3.0 服务端，1.x 拒绝）；不兼容仍走既有拒绝路径（hello_ack `ok:false` + close 1002 + reason）。hello_ack 回服务端实际版本（现状如此，保持）。
- **未知帧容忍策略**（协商区间的安全网，必须做）：未识别的**请求帧**（带 uuid id）→ 回同 id 的 `*_result` 形状 `{ok:false, error:"unknown frame type"}`，不断连；未识别的**事件帧** → 忽略 + debug 日志，不断连。
- **鉴权 token**（draft §4.1 拍板）：config 新字段 `token: string`（缺省 `""` = 不鉴权，向后兼容现有沙盒配置）；hello 新增**可选**字段 `token`；服务端配置了非空 token 且 hello 未带/带错 → hello_ack `ok:false` "auth failed" + **close 1008**。不做 token 过期/轮换（本机/可信内网场景，NOTES 记录边界）。IPC 不需要 token（stdin/stdout 天然私有）。core 侧经 `CoreOptions` 新增可选 `token` 注入（遵守 exactOptionalPropertyTypes）。
- **WS `command` 请求帧**（draft §2）：header `{type:"command", id:uuid}`，body `{command: string, source: {channel: string, userId: string}}`（**source 必填**，协议端负责从群消息提取）；响应帧 `command_result`（header 带同 id），body 为既有 resultBody + 成功时 `output?: string[]`。core 收到 → 管理员校验（下条）→ 经既有 IPC `execute_command` 透传 → Java 执行。
- **群管理员映射**：config 新字段 `admins: Array<{channel, users: string[]}>`（缺省 `[]`，语义对齐 channels 的去重保序）。判定规则：`source.channel` 命中某条目且 `source.userId` 在其 `users` 内 → 放行；否则 `command_result ok:false error:"forbidden"` + warn 日志。
- **白名单的 SSOT 是 MC 原生 whitelist**（`whitelist.json`）：core 不做白名单存储/镜像；群管理员经 command 执行 `whitelist add|remove|list`，结果经 `output` 回传。NOTES 记录此取舍。
- **Java 侧命令输出收集**：`NodeRequestHandler.onExecuteCommand` 从「调度成功即 ok」升级为：以**收集型 CommandSender**（轻量实现，缓冲消息文本）+ 主线程调度执行，把命令输出行收进 `execute_command_result`（IPC body 扩展 `output`），Node 侧透传给 WS `command_result`。这是桥接职责（透传），不是业务。
- **WS `query` 请求帧**：body `{kind: "status" | "bindings"}`；响应帧 `query_result`（header 带同 id），成功体 `{ok:true, data: ...}`。**core 本地作答，零 IPC 变化**：`status` 回 core 缓存的最近一帧 status 快照（core 新增缓存；未收到过任何 status → `ok:false` "no status yet"）；`bindings` 回当前 `BindingTable.channels()`。不做 `whitelist` kind（经 command `whitelist list` 的 output 覆盖）。**status 周期上报不做**（维持 M-04 事件驱动决策，按需拉取已覆盖状态面板场景）。
- **death 事件**：IPC 新事件帧 `player_death`（body `{player, message}`，命名对齐 `player_join`/`player_quit` 的事件源语义，无 channel、无 id）；WS 新事件帧 `death`（body `{channel, player, message}`，对齐 join/leave）；:paper 新增 DeathListener（PlayerDeathEvent，deathMessage plain 序列化），Relay 按 join/leave 同样的绑定 fan-out。
- **`/kurobot reload`**：新子命令（权限 `kurobot.admin`）→ IPC 新**事件帧** `config_reload`（Java→Node，无 id，语义对齐 shutdown 的单向通知——**不做** Java→Node 请求-响应机制）→ core 重读 `ConfigStore.load` + `BindingTable.replace` → 既有 `bindings_updated` 推送路径自然生效；命令即时返回「已通知重载」。ConfigStore 接口**不加** save/write。
- **`kurobot.relay` 权限消费**：ChatListener 增加 `player.hasPermission("kurobot.relay")` 检查，false → 该玩家聊天不转发（default: true 既有声明不变，negate 即静音语义）；paper-plugin.yml 补注释说明。
- **stub 升级**（`bridge/embedded/stub/peer.mjs`）：跟进 0.3.0；新增验收钩子——`KUROBOT_STUB_PROTOCOL_VERSION`（覆盖 hello 版本，验协商拒绝）、`KUROBOT_STUB_TOKEN`（hello 带 token）、`KUROBOT_STUB_ADMIN_SOURCE`（command 的 source 覆盖）；新增交互命令供沙盒验收（发 command/query、发未知帧）。
- **配置 schema 文档**：新建 `docs/config-schema.md`（config.json 逐字段说明：channels/token/admins、默认值、示例；标注 SSOT 是 core 的 zod schema，文档只是人类说明）。
- **沙盒配置升级**：`sandbox/server/plugins/kurobot/config.json` 补 `admins`（含 stub 管理员来源）与 `token` 空值；token 非空场景在验收时临时改。

### 1.3 明确不做（防跑偏清单，出现即算偏航）

- Watchdog/崩溃重启/PID 文件/重连状态清理/stub 孤儿治理（→ DEBT-2）。
- msgContinue/msgEnd 流式回报、status 周期上报、多服务器 serverId 互联、query 的 whitelist kind。
- napukettoqq 协议端接入、wrapper.node、多平台 node 矩阵、koishi-plugin-kurobot。
- fast-check 属性测试（ADR-013 二期）、:paper 新增 MockBukkit。
- build:jar 跨壳改造与 SHASUMS 严格模式（→ DEBT-2）。

## 2. 动手前必读（顺序执行）

1. `AGENTS.md` —— 工程指南与硬约束
2. `docs/STATUS.md` —— 现状（原型机/MVP 一/二结论三节）
3. `docs/MVP1-NOTES.md`（M-01~M-20，重点 M-02 channel 语义边界、M-04 status 时机）与 `docs/MVP2-NOTES.md`（M2-01~M2-11）
4. `docs/protocol/draft-v0.1.md` §2/§3/§4（command/query/death/token 的原始设想）+ `bridge/protocol/src/`（frame.ts 的 id 规则、ws.ts/ipc.ts 现有帧）
5. `docs/architecture.md` + `bridge/core/docs/design.md`、`bridge/embedded/docs/design.md`、`platforms/je/docs/design.md`（server 状态机、Relay、NodeRequestHandler）
6. `platforms/je/paper/src/main/java/com/kurobot/`（KurobotCommand/ChatListener/ConnectionListener/NodeRequestHandler 现状）

然后：环境基线验证——`mise exec -- pnpm check && mise exec -- pnpm test`（80 用例）全绿；`platforms/je` 下 `mise exec -- ./gradlew.bat build` 全绿（**输出重定向文件再读，勿用管道**）；沙盒冒烟（`scripts/paper-start.sh` / `paper-stop.sh`）。

按「设计先行」：动代码前先在各触及包的 `docs/design.md` 增「债务清偿一（DEBT-1）」小节（协议 0.3.0 帧集、协商规则、权限模型数据流、输出收集链）。

## 3. 实现顺序（每阶段至少一个提交，全部简体中文提交说明）

```
阶段 0  设计先行 + 基线验证（可并入阶段 1 提交）
阶段 1  bridge/protocol 0.3.0：command/command_result、query/query_result、
        player_death（IPC）、death（WS）、config_reload（IPC 事件）、hello 可选 token、
        版本协商兼容规则 + 未知帧容忍策略；vitest 补齐（schema + 协商边界 + 未知帧）
阶段 2  bridge/core：token 校验（close 1008）、协商落地、query 本地作答（status 缓存）、
        command 管理员判定 + IPC 透传 + output 透传、death fan-out、config_reload 处理
        （复用 watch 路径）；config schema 扩展（token/admins，缺省向后兼容）+ vitest
阶段 3  bridge/embedded + stub：bootstrap 注入 token、NodeConfigStore 新字段（缺省生成
        兼容旧配置）、stub 0.3.0 + env 钩子 + 验收交互命令
阶段 4  :core/:paper：IPC player_death 接收与转发、execute_command 输出收集
        （收集型 CommandSender + 主线程调度）、/kurobot reload + config_reload 发送、
        ChatListener kurobot.relay 检查；JUnit 补齐
阶段 5  沙盒端到端验收（§4 清单）+ docs/config-schema.md + DEBT1-NOTES / STATUS 收尾
        + design 回填实际差异
```

## 4. 验收清单（全部打勾 = 任务完成）

1. **门禁全绿**：`mise exec -- pnpm check` / `pnpm test`（用例数只增不减，80 → 预期 100+）/ `pnpm -r build`；`platforms/je` 下 `mise exec -- ./gradlew.bat build`（:core 44 → 预期 50+ 用例，`--rerun` 真跑）。
2. **版本协商**：stub 经 `KUROBOT_STUB_PROTOCOL_VERSION=1.0.0` 连入 → hello_ack `ok:false` + close 1002（日志 grep 证据）；`0.2.0` 连 0.3.0 服务端 → 兼容可握手。
3. **token**：config 配非空 token → 无 token stub 拒绝（close 1008）；`KUROBOT_STUB_TOKEN` 正确 → 握手成功；token 为空 → 全放行（向后兼容）。
4. **未知帧容忍**：stub 发未知事件帧 → 不断连、debug 日志；发未知请求帧 → 收到 `ok:false` 结果帧且连接保持。
5. **command 双向**：stub 以管理员 source 发 `whitelist list` → 收到 `command_result ok:true` 且 output 含白名单内容；非管理员 source → `ok:false "forbidden"` + 服务端 warn 日志。
6. **query**：stub query status（TPS/在线数/uptime 快照）与 query bindings（`["stub-channel"]`）均返回正确 data。
7. **death 事件**：游戏内执行 `/kill` → stub 收到 `death` 帧（绑定频道 fan-out）。
8. **reload**：游戏控制台 `/kurobot reload` → 日志显示重载 → 改配置后 bindings_updated 推送路径复用生效。
9. **relay 权限**：negate `kurobot.relay` 的测试玩家聊天不被转发（沙盒验证或集成测试证据）。
10. **回归**：MVP1/2 既有验收路径不回归（双向消息、热重载、JAR 解压加载、优雅关停无孤儿——孤儿治理属 DEBT-2，不在本册验收）。
11. `docs/DEBT1-NOTES.md` 完成：决策 D1-xx（含放弃方案）+ 架构发现 + 债务清单更新（msgContinue、周期上报、serverId、napukettoqq 等延续项）。`docs/STATUS.md` 追加「债务清偿一结论」小节（只追加，不改既有内容）。

## 5. subagent 使用策略

protocol + core 可整体主做（帧集联动强，拆派反而碎）；stub 升级与 Java 输出收集可各派一个 subagent（prompt 必须自包含，含边界约束：只写本工作区、biome 风格、零新依赖、`import type`、完成后自跑 `mise exec -- pnpm check`、**不要 git commit**）。派发纪律：subagent 返回后**主智能体必须亲自复核**（读关键文件、跑门禁、亲测行为），不采信口头完成（原型 D-15 / MVP1 M-17 教训）。

## 6. Windows / Git Bash 注意事项（实测踩坑，勿重趟）

- **gradlew 输出经管道会挂起**（MVP1-NOTES M-18）→ 一律重定向文件再读；Spotless up-to-date 掩盖格式违规 → 跨阶段首跑 `:core:test --rerun`。
- node dist 直连失败走 `KUROBOT_NODE_DIST_BASE=https://npmmirror.com/mirrors/node`（缓存 `.cache/node-dist/`）——跑 `pnpm build:jar` 时需要。
- mise 的 PATH **不传导**到 Java ProcessBuilder——开发覆盖模式仍需绝对路径（沙盒 paper-start.sh 已处理）。
- 验证长驻进程靠 grep 日志（`[KuroBot]` 前缀；`logs/latest.log` 为准）；关服一律 `scripts/paper-stop.sh`。
- 改 protocol 源后忘 `pnpm -r build` → 消费方「字段不存在」假红（§1.1 红线 5）。
- 强杀 node 会留 stub 孤儿（本阶段不治理，验收时知晓即可）；sandbox 配置改完记得还原基线。

---

**一句话总结**：把「只有事件集的 v0.2」升级为「带鉴权、兼容协商、请求-响应族与权限模型的 v0.3.0」，白名单与管理员映射走通第一块真实业务；进程健壮性留给 DEBT-2。
