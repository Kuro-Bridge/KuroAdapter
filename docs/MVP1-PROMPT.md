# KuroBot MVP 阶段一任务书（无人值守）

> 本文件是一次**无人值守任务**的完整任务书。执行智能体拿到本文即视为唯一指令来源，与任何对话历史无关。
> 完成后本文件保留，作为 MVP 阶段一的存档。
> 前置状态：原型机 spike 已完成并验收（分支 `prototype/spike`，8 个提交；结论见 `docs/STATUS.md`「原型机结论」，全部决策与踩坑见 `docs/PROTOTYPE-NOTES.md`）。

---

## 0. 边界与纪律（先读，违反即任务失败）

- **工作区**：`C:\Dev\MC-Ecosystem\KuroAdapter`。所有文件的创建/修改**只允许发生在此目录内**。
- **禁止修改** `C:\Dev\Bot-Dev\` 下任何项目。
- **无人值守规则：禁止向用户提问。**所有决策自行拍板，并全部记入 `docs/MVP1-NOTES.md`（做了什么决定、为什么、放弃了哪些替代方案）。只有遇到不停止就无法继续的硬阻塞时才允许结束任务，结束时在 NOTES 里写清阻塞点。
- **Git**：阶段 0 先把 `prototype/spike` 合并进 `master`（merge commit，说明用简体中文，保留 spike 分支不删）；之后直接在 `master` 上小步提交（对齐 `.github/agents/kurobot.agent.md` 的主分支工作流）。**不 push、不改写历史**。pre-commit 钩子会跑门禁，被拒就修到绿再提交。
- 不要修改 `AGENTS.md` 与 `docs/DECISIONS.md` 中既有 ADR 的结论；本阶段的新决策一律**追加**新 ADR（编号从 ADR-022 起）。
- **一切构建/测试命令统一经 `mise exec -- <cmd>`**（PATH 直连的 node 是 24、java 是 21，不满足要求；mise 提供 node 26.7.0 / java 25.0.2 / gradle 9.7.0）。

## 1. 目标：把「业务为空壳」推进到「业务最小可用」

原型机验证了管道（「一个 JAR、两个进程、一条消息双向跑通」），本阶段补上**业务与健壮性**：

1. **ADR 落地**：原型留下的 4 个已实证候选（A~D）写入 `docs/DECISIONS.md`。
2. **协议 v0.2**：chat 帧补频道字段、补 join/leave/status/bindings_updated 事件集。
3. **core 正式化**：hello 等待超时、心跳空闲断开、IPC 请求超时、IPC 断连降级语义（候选 E）。
4. **业务最小闭环**：绑定 + 转发规则替换 `Relay` 假规则；配置 JSON 化（`plugins/kurobot/config.json`）。

### 1.1 必须守住的红线（同 AGENTS.md，违反即任务失败）

1. 消息类型一律 `import { ... } from "@kurobot/protocol"`，**禁止手写**；新消息先进 protocol 包（zod），Java 侧手写 Jackson DTO 是 ADR-008 允许的唯一例外。
2. `bridge/core` 平台无关：零 Node API。本阶段新增的**时钟/定时器、配置读写、文件监听**一律做成注入接口，Node 具体实现只出现在引导层（bridge/embedded）。
3. Java 薄壳不做业务；IPC 只走 stdin/stdout JSON-lines；kurobot 永远是 WS 服务端。
4. 依赖方向遵守 AGENTS.md 第 7 条；不复制 HuHoBot / NapCat / NapukettoQQ 代码。

### 1.2 已批准的简化（这些是本阶段的一部分，不是偷懒）

- 白名单/指令权限模型**不做**（MVP-2）。
- 多服务器互联（serverId 多实例）、富文本/图片渲染**不做**。
- tools/embed 打包链、node.exe 进 JAR **不做**（沿用原型：`KUROBOT_NODE` + `KUROBOT_BUNDLE` 环境变量加载）。
- 配置热重载机制：**文件监听**与**控制台命令触发**二选一，选实现更简单的那个，理由记 NOTES。
- 数据库**不做**，绑定/配置存 JSON。
- fast-check / 压测 **不做**。

### 1.3 明确不做（防跑偏清单，出现即算偏航）

- koishi-plugin-kurobot（独立仓库，不在本工作区）。
- lse / endstone / fabric / neoforge / velocity 接线（骨架存在即可）。
- 白名单、权限模型、群管理员映射。
- Watchdog / PID 文件 / 崩溃自动重启（MVP-2 债务）。

## 2. 动手前必读（顺序执行）

1. `AGENTS.md` —— 工程指南与硬约束
2. `docs/STATUS.md` —— 现状（含「原型机结论」小节）
3. `docs/PROTOTYPE-NOTES.md` —— **决策 D-01~D-15、ADR 候选 A~E、Windows 踩坑全记录、MVP 债务清单**（本阶段的需求来源）
4. `docs/architecture.md`（重点 §5/§6：进程模型与业务归属）、`docs/DECISIONS.md`（重点 ADR-003/004/005/008/010）
5. `docs/protocol/draft-v0.1.md` + `bridge/protocol/src/`（现实现）
6. `bridge/core`、`bridge/embedded`、`platforms/je` 各自的 `docs/design.md`（含 spike 小节）

然后：环境基线验证——`mise exec -- pnpm check && mise exec -- pnpm test` 全绿；`platforms/je` 下 `mise exec -- ./gradlew.bat build` 全绿；沙盒已就绪（`sandbox/server/paper.jar` 已下载校验，启停脚本在 `scripts/paper-start.sh` / `scripts/paper-stop.sh`，冒烟即可）。

按「设计先行」：动代码前先在各触及包的 `docs/design.md` 加「MVP 阶段一」小节，写明你要建的最小集与关键取舍。

## 3. 实现顺序（每阶段至少一个提交，全部简体中文提交说明）

```
阶段 0  合并 spike → master；追加 ADR-022~025（候选 A~D 落地，正文链接 PROTOTYPE-NOTES
        的实证段；ADR-022 必须写明回退条件：内存受限环境可合并为单进程，
        bridge/core 不动、只改 embedded 引导层）
阶段 1  协议 v0.2（bridge/protocol + draft 同步）：
        - chat 双向帧各加频道字段（服务端→对端：channel+playerName+content；
          对端→服务端：channel+sender+content；broadcast 请求同步带 channel）
        - 新增 join / leave（玩家进出服）、status（tps/在线数/uptime）、
          bindings_updated（绑定变更推送）事件
        - hello_ack ok 体携带 channelBindings（对齐 ADR-004）
        - PROTOCOL_VERSION 0.1.0 → 0.2.0（注意：D-10 精确相等策略下，
          stub 的 hello 同步升版本）
阶段 2  core 正式化（bridge/core）：
        - CoreContext 增加时钟/定时器注入（保持零 Node API；阈值可配）
        - hello 等待超时（10s 未握手 → 关连接）
        - 心跳空闲检测（对端 N 秒无任何帧 → 判定断开关连接；N 可配）
        - IPC 请求超时（对齐 Java 侧 10s）
        - 断连降级（候选 E）：sendGameChat 在 IPC 断开时不再静默丢弃——
          返回可观测的失败，上层可感知（具体 API 形状自行设计，记 NOTES）
阶段 3  业务最小闭环（bridge/core/business + 引导层）：
        - ConfigStore 注入接口（core 侧）；Node 实现在 embedded 引导层：
          读 plugins/kurobot/config.json（相对子进程 cwd，即服务器根目录），
          缺失时生成默认配置并落盘
        - 绑定表 + 转发规则纯逻辑模块（vitest 全覆盖）：
          平台消息按绑定频道过滤（未绑定频道 → 丢弃并 debug 日志），
          替换 Relay 的全量转发假规则；游戏聊天 → 广播到全部绑定频道
        - 配置变更 → bindingsUpdated 推送给已握手对端
阶段 4  Java 桥接扩展（platforms/je，保持零业务）：
        - PlayerJoinEvent / PlayerQuitEvent → join / leave 帧
        - status 数据源（TPS / 在线人数 / uptime，Paper API 取数）
        - /kurobot send 在 IPC 断开时明确报错（偿还原型债务，不再假「已发送」）
        - stub 协议端同步升级到 v0.2（新帧 + hello 版本号）
阶段 5  沙盒端到端验收（§4 清单）+ NOTES / STATUS 收尾 + design 文档回填实际差异
```

## 4. 验收清单（全部打勾 = 任务完成）

1. **门禁全绿**：`mise exec -- pnpm check` / `pnpm test`（业务与超时新用例在内）/ `pnpm -r build`；`platforms/je` 下 `mise exec -- ./gradlew.bat build`（`:core` JUnit + 真管道集成测试同步更新到 v0.2 帧）。
2. **超时行为有 vitest 证据**：假对端连入后不发 hello → 超时被关；握手后停发心跳帧 → 空闲阈值判定断开。
3. **沙盒端到端**（真 Paper，`scripts/paper-start.sh` 启动，日志 grep 验证，统一 `[KuroBot]` 前缀）：
   - a. 默认配置（绑定列表为空）→ stub 平台消息**不进游戏**，日志说明原因；
   - b. 配置写入绑定（stub 频道）→ 平台消息进游戏 broadcast；游戏侧 `/kurobot send` 正常到达 stub；
   - c. 触发配置变更 → stub 收到 `bindings_updated`；
   - d. 强杀 node → 服务器不崩不卡（原型已验证的性质不回退），`/kurobot send` 回复明确错误；
   - e. `stop` → 级联关机，无孤儿进程。
4. **join/leave 允许降级验收**：沙盒无真实玩家，端到端难以触发——验收标准降级为「core 侧收到 join/leave 帧并转发 stub 有 vitest 证据 + Java 侧编译与既有测试全绿」，真实玩家进服的人工冒烟留给用户，在 NOTES 记录该降级。
5. `docs/MVP1-NOTES.md` 完成：全部决策记录 + 架构发现 + MVP-2 债务清单（含未做项：白名单/权限、Watchdog、tools/embed）。
6. `docs/STATUS.md` 追加「MVP 阶段一结论」小节（只追加，不改既有内容）。

## 5. subagent 使用策略（要求积极使用）

主智能体持有：ADR 文本定稿、协议 schema 定稿、跨侧集成、全部验收。其余尽量派发。**每个 subagent 的 prompt 必须自包含**，且必须包含边界约束（只写本工作区、遵守 biome/Palantir 代码风格、不引入未指明的新依赖、完成后自跑 `mise exec -- pnpm check` 或对应测试、**不要 git commit**——由主智能体统一提交）。

适合派发（可并行）：

1. **Java 桥接扩展**（阶段 4）：join/leave/status/命令报错，独立可测。
2. **stub 协议端升级**（阶段 4）：v0.2 帧 + 版本号。
3. **协议 schema 扩展**（阶段 1）若需要并行：先由主智能体定字段再派发。

派发纪律：subagent 返回后**主智能体必须亲自复核**（跑 check/测试/编译，读关键文件），不采信口头完成；发现不合红线直接打回重做。原型阶段的教训：subagent 自称跑过构建但实际没跑通（PROTOTYPE-NOTES D-15），复核环节不可省。

## 6. Windows / Git Bash 注意事项（原型实测踩坑，勿重趟）

以下全部有实录，详见 `docs/PROTOTYPE-NOTES.md`「架构发现」：

- Java 构建用 `gradlew.bat` 且必须 `mise exec --`；Spotless palantir 已钉 2.71.0（JDK 25 兼容线），勿动。
- `-Xlint:all -Werror`：避免一切 deprecated API；try-with-resources 资源未在体内引用也会炸。
- mise 的 PATH **不传导**到 Java ProcessBuilder 的可执行文件搜索——Java 拉起 node 必须显式绝对路径（沙盒脚本已处理，勿改回）。
- Java `Path.resolve("../x")` 是纯字符串拼接，兄弟路径必须以 `getParent()` 为基准。
- `tail -f cmd.in` stdin 注入：启动前必须清空 cmd.in + 清杀遗留 tail.exe（脚本已处理）。
- MSYS pid 跨会话不可靠，判活用 winpid + `tasklist //FI`（脚本已处理）。
- PaperMC 下载走 `fill.papermc.io`（v2 已 sunset）。
- Paper 1.21.4 只有 `PlainComponentSerializer`（@Deprecated，局部压制），没有 plaintext 模块。
- Shadow 9 不把 shadowJar 挂进 `assemble`，fat jar 用 `:paper:shadowJar`。
- 长驻进程放后台 + 日志重定向，验证靠 grep 日志；**卡住规则**：任一阶段超过约 30 分钟无实质进展 → 降级目标并记 NOTES，继续推进不原地打转。

---

**一句话总结**：把原型管道升级成有绑定规则、有超时健壮性、有配置的最小可用业务；四个已实证的架构候选在此转正为 ADR，剩下的复杂度（权限/Watchdog/打包）留给 MVP-2。
