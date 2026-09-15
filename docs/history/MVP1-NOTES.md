# KuroBot MVP 阶段一决策记录（MVP1-NOTES）

> 配套任务书：`docs/MVP1-PROMPT.md`。本文记录 MVP 阶段一期间的全部自主决策、放弃的替代方案、
> 架构发现与 MVP-2 债务清单。无人值守规则：所有决策自行拍板并记于此。
> 前置：原型机结论见 `docs/PROTOTYPE-NOTES.md`（决策 D-01~D-15，本文引用不重复）。

## 环境与基线（阶段 0 前，2026-09-13）

- `mise exec -- pnpm check` / `pnpm test`（33 用例）/ `pnpm -r build` / `gradlew build`（22 任务 up-to-date）全绿；沙盒 paper.jar 在位。
- 合并 `prototype/spike → master`（merge commit 1091d1f，保留分支），此后直接在 master 小步提交。
- GPG 签名缓存有效（阶段 0 验证提交成功）；若缓存过期导致提交挂起，预案是提交改 `--no-gpg-sign` 并在此记录——本次未触发。

## 决策记录

### M-01 阶段 1 的过渡性假规则：占位频道 `"spike"`

协议 v0.2 的消费方（core/server/relay）在阶段 1 必须最小适配才能保门禁绿（跨包类型联动），
但绑定表阶段 3 才落地。过渡方案：Relay 对游戏事件（game_chat/player_join/player_quit）
fan-out 到占位频道常量 `"spike"`，阶段 3 随绑定表落地移除（61a1cf2 → 5e4f542 之间短暂存在，
最终提交历史可见）。放弃方案：阶段 1 一并把绑定表做完（破坏任务书阶段划分）或给协议留
可选 channel 字段（污染 schema 语义）。

### M-02 channel 的语义边界：IPC 侧事件帧不带 channel

channel = 服务端绑定表的频道标识（对 MVP 是平台侧频道 ID，如群号字符串）。fan-out（游戏事件
→ 逐绑定频道一帧）是 **Node 侧业务**；Java 零业务不该知道频道，故 IPC `game_chat` /
`player_join` / `player_quit` 不带 channel，WS `chat`/`join`/`leave` 带发送侧 channel。
IPC `broadcast` 请求带 channel（`{channel, message}`）——对称记录消息来源，Java 侧 MVP 只
广播不区分，字段保留给未来按频道渲染（协议侧先定形，避免二次破坏兼容）。

### M-03 IPC 帧名 `player_join`/`player_quit`，WS 帧名 `join`/`leave`

对齐既有模式：IPC 帧名描述 Bukkit 事件源（`game_chat`），WS 帧名是协议事件（`chat`）。
放弃：两侧同名（namespace 本就分离，同名合法但丢掉「事件源 vs 协议事件」的信息）。

### M-04 status 的推送时机 = 玩家进出服（数据变化点）

status 是 Server→Peer 事件（无 id）。候选时机：周期上报 / 对端订阅拉取 / 事件驱动。选事件
驱动：Java 在 PlayerJoin/PlayerQuit 后各推一帧 status 快照（在线数恰好变化），全链路零定时器、
零订阅协议。周期上报与按需拉取（对端 `query` 请求）留 MVP-2（draft §4.5 的待细化项）。

### M-05 status 取数：TPS=`Bukkit.getTPS()[0]`，uptime=JVM uptime

- tps：Paper `getTPS()` 返回 [1m,5m,15m]，取 1m 均值，clamp ≥0 并保留 1 位小数（协议 nonnegative）。
- uptime：`ManagementFactory.getRuntimeMXBean().getUptime()/1000`（JDK 标准接口）——专用服的
  JVM uptime 即服务器 uptime；放弃 Paper `Server#getStartTime()`（版本可用性未证实，JDK 接口零风险）。

### M-06 hello_ack 的 channelBindings 注入形状：`ServerOptions.channelBindings: () => string[]`

闭包而非值快照——握手时实时取 BindingTable 当前值，配置变更后新握手对端自动拿新列表
（vitest 有专测）。KurobotServer 依旧零业务（它不知道绑定表的存在，只调注入的函数）。

### M-07 时钟/定时器注入：一次性定时器 + Manual 实现随包发布

- `Clock.now()` + `TimerScheduler.schedule(delayMs, cb): CancelFn`（只一次性，无周期定时器）：
  空闲检测用「每次收帧重挂一次性定时器」实现，泄漏面最小、取消语义简单。
- `ManualClock`/`ManualScheduler` 放在 `src/clock.ts` 随包发布（纯逻辑、QuickJS 安全），
  vitest 手动推进——不引入 vitest fake timers（测试宿主能力不进被测代码路径）。
- Node 实现（`NodeClock`/`NodeScheduler`，setTimeout+unref）只在 bridge/embedded——unref 保证
  超时检测不阻止进程退出（关机路径不依赖定时器）。

### M-08 空闲检测的「活跃」定义：任何入帧都算（含非法帧）

坏 JSON / 校验失败的帧也证明对端活着（连接活着≠协议正确）。hello 超时（1002）与空闲断开
（1001）用不同关闭码区分语义。握手完成即取消 hello 定时器；连接关闭统一走 onClose 清理
（握手被拒路径显式先清再关，避免真 ws 异步 close 窗口期误报超时）。

### M-09 断连降级（候选 E）的 API 形状

core 侧三层可观测信号（不再静默丢弃）：
1. `IpcChannel.isOpen`（只读健康快照，宿主实现）；
2. `Relay.ipcOpen`（含 dispose 后语义，上层/引导层可查）；
3. `KurobotServer.send*` 全部返回**送达的已握手对端数**（0 = 无人接收，调用方可记可观测日志）。

Java 侧（阶段 4）：`NodeIpc.sendGameChat` 返回 boolean（通道不可用/写出失败 → false），
`/kurobot send` 据此明确报错。放弃方案：消息排队/重连补发（MVP-2 债务）、抛异常（事件帧
尽力而为语义，异常会打断事件桥接循环）。

### M-10 IPC 请求超时：默认 10s 对齐 Java 侧，迟到响应告警忽略

`Relay.forwardToGame` 在途请求挂一次性定时器，超时以 `IpcRequestError`（reason 含「响应超时」）
拒绝；响应先到则取消定时器（vitest 断言 pendingCount=0 无泄漏）。迟到的响应 id 已不在途 →
warn「无在途请求」忽略。`ipcRequestTimeoutMs: 0` 禁用（保留无超时语义给特殊宿主）。

### M-11 配置热重载：mtime+size 轮询（2s），弃 fs.watch 与控制台命令

任务书 §1.2 二选一（文件监听 vs 控制台命令触发），选**文件监听**（实现更简单的那个）：
- 控制台命令触发需要：Java 命令注册 + 新 IPC 帧型 + core 处理分支（三处改动、跨侧协议变化）；
  文件监听只需 embedded 一处实现（零协议变化）。
- 监听实现选**轮询**而非 fs.watch：Windows/网络盘的 fs.watch 事件语义不可靠（rename/change
  错乱、编辑器原子替换丢事件），轮询（mtimeMs + size 双指标）行为可预测且可测。
- 沙盒实测：写配置后 ≤6s 内 `bindings_updated` 送达 stub（轮询 2s + 传播余量）。

### M-12 `ConfigStore.load` 异步化（`Promise<KurobotConfig>`）

Node 实现天然 fs/promises；接口直接定形异步，宿主（LSE/QuickJS）可同步实现后包 Promise 返回。
FakeConfigStore 同步构造、异步返回。bootstrap 初始 load 失败（非法 JSON/读失败）→ 记 error、
以空绑定降级运行（服务器不因配置错误失去插件），watch 后续变更在服主修复文件后自动生效。

### M-13 默认配置 `{"channels": []}`，缺失时落盘生成

`NodeConfigStore.load` 在 ENOENT 时 `mkdir -p plugins/kurobot` + `writeFile(flag:"wx")` 生成
默认配置（wx 并发安全，绝不覆盖服主手写内容）。解析用 zod（`{channels: string[]}`，频道非空
字符串，去重保序；多余字段剥离——服主加注释性字段不炸）。

### M-14 `BindingTable.replace` 的变化判定是集合语义

重排/重复写入不算变化（不触发 bindings_updated 推送），增删才算——避免无意义的推送与日志
噪声。内部保序（配置书写顺序即 hello_ack 上报顺序）。

### M-15 集成测试的 cwd 注入：ProcessFactory 第三参 + @TempDir 预置绑定

绑定表落地后，Java 集成测试（真 node+bundle+stub）必须让子进程读到「绑定 stub-channel」的
配置，否则 stub 消息被默认空绑定丢弃、用例必挂。方案：`ProcessFactory.start(command, extraEnv,
workingDirectory)` 第三参 + `NodeIpc.setWorkingDirectory`（包内可见，start 前调用）+ 测试
@TempDir 写 `plugins/kurobot/config.json`。生产路径不受影响（缺省继承 cwd = 服务器根）。

### M-16 stub 收到含自己频道的 bindings_updated 后补发一条平台消息

沙盒验收配套行为（不改就无法在不重启的情况下验证「写绑定 → 平台消息进游戏」——stub 只在
握手后发一条消息）。行为：`bindings_updated.channelBindings` 含 `stub-channel` → 再发一条
「绑定已生效」消息 → 绑定已生效则广播进游戏。这是 stub（测试件）的验收脚本化，不是生产行为。

### M-17 subagent 派发与复核（阶段 4）

Java 桥接扩展派发给 subagent（自包含 prompt：边界/风格/踩坑/验证要求）。其产出主侧复核：
git status 确认改动范围 → 逐文件读 diff（ConnectionListener/NodeIpc/KurobotCommand/集成测试）
→ 亲自重跑 `gradlew build :core:test --rerun`（36 用例）+ `pnpm check/test`（70 用例）确认。
subagent 报告了两处自主决策（新发送方法统一返回 boolean；spotlessApply 附带修复阶段 3 的
格式遗留），复核均认可。原型教训（D-15）的复核环节本次执行到位。

### M-18 gradlew 输出经管道会挂起客户端（Windows 坑）

`mise exec -- ./gradlew.bat build 2>&1 | tail -8` 在 daemon 完成构建后客户端不退出（挂 30+ 分钟，
daemon 日志显示 12:44:35 已 BUILD SUCCESSFUL）。改用输出重定向到文件再读，稳定复现零次。
已列入「Windows 注意事项」经验。

### M-19 join/leave 的降级验收（任务书 §4.4 预授权）

沙盒无真实玩家，join/leave 端到端降级为：core 侧 fan-out + 转发 stub 的 vitest 证据
（relay.test.ts 2 例）+ Java 侧编译与全部测试绿（含集成测试的 player_join→stub stderr 断言）。
**真实玩家进服的人工冒烟留给用户**（进一次服/退一次服，观察群里 join/leave 消息与 status 推送）。

### M-20 阶段 5 未写 MVP2-PROMPT

任务书未要求且 MVP-2 范围（白名单/权限模型/Watchdog/打包）是用户级决策，不代拍。MVP-2 债务
清单（下文）即下一份任务书的输入。

## 架构发现（随做随记）

- **workspace 跨包解析走 dist 产物**：`@kurobot/*` 的 exports 指向 `dist/`，改 protocol 源后必须
  先 `pnpm -r build` 才能过 `pnpm check`/`pnpm test`（症状：新字段在消费方测试里「不存在」）。
  vitest.config 的「只测包内纯函数」注释与实际不符（core 测试 import @kurobot/protocol），
  属于既有认知偏差，已在此记录。
- **强杀 node 会留下 stub 孤儿**（Windows 无父子级联终止）：场景 d 实测——node 被 taskkill 后
  stub 继续按退避重连。正常关机路径（shutdown 帧级联）无此问题。孤儿 stub 无害（只重连空端口）
  但属进程卫生债，MVP-2 候选（父进程死亡检测 / Job Object / stub 侧心跳超时自杀）。
- **paper.pid 机制确认**：`/proc/$!/winpid` 拿到的就是 pipeline 里 java 的 winpid（实测 452 =
  java.exe paper.jar），stop 脚本判活正常；早前一次 tasklist grep 失误是中文代码页输出格式问题，
  与脚本无关。沙盒 java 是 PATH 的 Adoptium 21（Paper 1.21.4 运行时基线，与 target 21 匹配）。
- **NodeConfigStore 轮询在 NTFS 的 mtime 精度足够**：mtimeMs+size 双指标，实测 6s 内感知变更；
  编辑器原子替换的空窗（stat 抛错）按「下轮再试」处理，不误报。
- **spotless 的 up-to-date 会掩盖格式违规**：阶段 3 的两处格式问题（ProcessFactory 签名换行、
  集成测试 writeString 换行）在当次构建被跳过，阶段 4 subagent 首跑 spotlessJavaCheck 才暴露。
  教训：跨阶段改动后首跑建议带 `--rerun` 或至少 `spotlessCheck` 显式跑一次。

## 沙盒端到端验收实录（2026-09-13，任务书 §4.3）

| 项 | 结果 | 证据（sandbox/server/logs/latest.log） |
|---|---|---|
| a. 默认空绑定 | ✅ | 「配置缺失，已生成默认配置」+「当前绑定频道：[]」+ stub 握手（channelBindings=[]）+「平台消息来自未绑定频道 stub-channel，丢弃」；全 log 无 stub 消息广播 |
| b. 写入绑定 | ✅ | 13:55:00「绑定表已更新：[stub-channel]」→ stub 收 bindings_updated → 补发消息 → `[Server thread/INFO] <stub-群友> 绑定已生效，这是变更后的第一条消息`（游戏 broadcast）；`kurobot send` → 「已发送」+ stub「收到游戏聊天：[stub-channel] <CONSOLE> …」 |
| c. 配置变更推送 | ✅ | 「检测到配置变更」→「绑定表已更新」→ stub「收到绑定变更：[stub-channel]」（写盘后 ≤6s） |
| d. 强杀 node | ✅ | taskkill node(10408) 后服务器继续响应命令；`/kurobot send` →「发送失败：Node IPC 通道不可用，消息已丢弃」（不再假「已发送」）。另证：IPC 已死状态下 stop 也能干净关服（「Node IPC 已关闭：plugin disable」） |
| e. stop 级联 | ✅ | 「收到关机通知：plugin disable」→「收到 Java 关机通知，退出」→「stdin EOF，退出」→「stub 协议端退出」→ 全进程清单核查：无 paper java / 无 kurobot node / 无 stub 残留 |

## MVP-2 债务清单（含任务书明示的未做项）

- **白名单 / 指令权限模型 / 群管理员映射**（MVP-2 主体，任务书 §1.2/§1.3）。
- **Watchdog / PID 文件 / 崩溃自动重启**（任务书 §1.3；强杀 node 后 stub 孤儿问题同属此类）。
- **tools/embed 打包链 / node.exe 进 JAR**（沿用 KUROBOT_NODE/KUROBOT_BUNDLE 环境变量加载）。
- **重连**：WS 对端断开后 core 不感知重建（stub 自带简退避重连）；Node 死后 Java 侧不重启。
- **协议版本协商仍是精确相等**（D-10），无 semver 兼容区间；鉴权 token 未做（draft §4.1）。
- **msgContinue / msgEnd 流式回报、query 请求族、command 指令族**（draft §2/§3 未实装）。
- **status 周期上报 / 按需拉取**（M-04 只做了进出服时机）；**death 事件**未做。
- **execute_command 的业务入口**：IPC 帧型与 Java 执行路径已通，但无触发方（协议端 command 族未实装）。
- **富文本/图片渲染**（归属 koishi-plugin-kurobot 独立仓库）；**多服务器 serverId 互联**。
- **配置管理命令**（写配置仍靠手改 JSON；轮询自动生效）；配置文件无 schema 文档（只有 zod 校验）。
- **Java :paper 无单元测试**（Bukkit 侧依赖沙盒验收兜底，原型既有债务）；`kurobot.relay` 权限仍未消费。
- **le/fabric/neoforge/velocity 接线**（骨架在，任务书 §1.3 明示不做）。
- **CRLF 隐患**：bridge/core/package.json 曾被脚本写成 CRLF（已修 LF）；CI 侧无 .gitattributes 强制——建议 MVP-2 加。
