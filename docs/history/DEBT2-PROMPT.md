# KuroBot 债务清偿二任务书（无人值守）——进程健壮性与工程收尾（DEBT-2）

> 本文件是一次**无人值守任务**的完整任务书。执行智能体拿到本文即视为唯一指令来源，与任何对话历史无关。
> 完成后本文件保留，作为债务清偿二的存档。
> 前置状态：MVP 阶段一、二 + **债务清偿一（DEBT-1，见 `docs/DEBT1-PROMPT.md` / `DEBT1-NOTES.md`）已完成并验收**（master）。本任务书若在 DEBT-1 之前执行，§1.2 中「本册唯一协议变更」一条按实际版本基线顺延，其余不受影响；**但强烈建议按 DEBT-1 → DEBT-2 顺序执行**。
> 范围由用户拍板：**清偿 MVP1/MVP2 债务中「进程 + 工程」半边**——Watchdog/崩溃自动重启、PID 文件、WS 对端重连状态清理、stub 孤儿治理、build:jar 跨壳、GBK 日志、SHASUMS 严格模式、.gitattributes、升级提示。协议与业务补全（token/协商/command/query/白名单）属**债务清偿一**，本阶段不做。

---

## 0. 边界与纪律（先读，违反即任务失败）

- **工作区**：`C:\Dev\MC-Ecosystem\KuroAdapter`。所有文件的创建/修改**只允许发生在此目录内**。
- **禁止修改** `C:\Dev\Bot-Dev\` 下任何项目。
- **无人值守规则：禁止向用户提问。** 所有决策自行拍板，并全部记入 `docs/DEBT2-NOTES.md`（新建，决策编号 D2-01 起；做了什么决定、为什么、放弃了哪些替代方案）。只有遇到不停止就无法继续的硬阻塞时才允许结束任务，结束时在 NOTES 里写清阻塞点。
- **Git**：直接在 `master` 上小步提交（简体中文提交说明，每阶段至少一个提交）。**不 push、不改写历史**。pre-commit 钩子（lefthook：`pnpm check` + `pnpm test`）被拒就修到绿再提交。
- **GPG 注意**：仓库开了 commit 签名。若 `git commit` 超过约 2 分钟无输出，疑似 gpg-agent 口令缓存过期挂起——**禁止 `--no-gpg-sign`**；结束任务并在 NOTES 写明已暂存的变更清单，交由用户交互提交。
- 不要修改 `AGENTS.md` 与 `docs/DECISIONS.md` 中既有 ADR 的结论；本阶段新决策**追加**新 ADR（编号接续当前 `docs/DECISIONS.md` 最大号，DEBT-1 之后应从 ADR-029 左右起——动手前先读末尾确认）。
- **一切构建/测试命令统一经 `mise exec -- <cmd>`**（PATH 直连的 node 是 24、java 是 21；mise 提供 node 26.7.0 / java 25.0.2 / gradle 9.7.0）。
- **卡住规则**：任一阶段超过约 30 分钟无实质进展 → 降级目标并记 NOTES，继续推进不原地打转。

## 1. 目标与范围

现状：node 被强杀后 Java 只感知（stdout EOF → 通道拆除、在途请求拒绝）**不重启**（全仓无 `Process.onExit`、无重启逻辑，`platforms/je/core/.../NodeIpc.java`）；强杀 node 还会留下 stub 孤儿（Windows 无父子级联终止，stub 无限重连）；WS 对端断开后 core 的资源清理与重连一致性无测试背书；`pnpm build:jar` 的 gradle 步骤写死 `gradlew.bat`（POSIX 贡献者不可用）；cmd.exe GBK 代码页下中文构建日志乱码；embed 的 SHASUMS 回退缓存是静默信任；无 `.gitattributes`（bridge/core/package.json 曾被写成 CRLF）；bin/ 重建（升级）无显式提示。本阶段一次清偿。

### 1.1 必须守住的红线（同 AGENTS.md，违反即任务失败）

1. 消息类型一律 `import { ... } from "@kurobot/protocol"`，禁止手写。
2. `bridge/core` 平台无关（零 Node API）；logger/clock/scheduler 一律注入。
3. **Java 薄壳不做业务**：自动重启/看护是**宿主进程管理职责**（:core/:paper），不引入业务判定；IPC 只走 stdin/stdout JSON-lines；kurobot 永远是 WS 服务端。
4. 依赖方向遵守 AGENTS.md 第 7 条；不引入未指明的新依赖（包括 Job Object 的 JNI/第三方封装——本阶段不需要）；不复制 HuHoBot / NapCat / NapukettoQQ 代码。
5. **workspace 跨包解析走 dist 产物**：改 `bridge/protocol` 源后必须先 `pnpm -r build` 再 `pnpm check`/`pnpm test`。

### 1.2 已拍板的关键决策（按此实现，若有更优方案须在 NOTES 论证后仍自行拍板）

- **Watchdog（:core + :paper）**：node 进程退出 → `NodeIpc` 暴露退出通知（进程退出码 + teardown 原因，回调在既有 IPC 读取线程语义上）→ `:paper` 按退避**自动重启**：1s → 5s → 15s 三档，10 分钟窗口内累计失败 3 次 → 放弃 + SEVERE（提示手动重启路径）。重启走既有启动链（JAR 模式经 `EmbeddedRuntime` 复用 bin/——其幂等性已保证；开发覆盖模式沿用环境变量）。`onDisable` 停止看护。README 级文档：`docs/` 下 design 小节写清状态机（running → restarting → given-up）。
- **autoRestart 开关**：config.json 新字段 `runtime: { autoRestart: boolean }`（缺省 `true`）。schema 归属 core 的 zod（业务配置 SSOT 在 Node 侧），**经 `ready` 帧扩展字段 `autoRestart` 上报给 Java**（Java 只是消费宿主参数，与既有 `wsPort` 同性质——不违反「Java 不做业务」）。这是**本册唯一协议变更**：`ready` body 加可选字段，版本号按 DEBT-1 之后的基线做 **patch 级顺延**（如 0.3.0 → 0.3.1）；stub 不受影响（bootstrap 侧补上报）。stub 验收强杀场景下该值必为缺省 true，无需配置。
- **PID 文件**：node 拉起成功后 Java 写 `plugins/kurobot/node.pid`（winpid），优雅关停删除；启动时发现残留文件 → INFO 日志提示「上次可能异常退出」（**不**做跨进程互斥/防双实例——Paper 插件单实例由容器保证，NOTES 记录边界）。
- **WS 对端断开 → 重连状态一致性（bridge/core）**：补齐断连时的资源清理与状态复位（hello/idle 定时器取消、已握手状态复位、send* 送达数归零语义），并给出 vitest 证据：对端断开 → 重连 → 重新握手 → hello_ack 携带当前绑定快照 → 双向消息恢复；反复 N 轮无定时器泄漏（ManualClock/ManualScheduler 断言 pending=0）。**维持既有对端模型不重构**（单/多对端能力以现状为准，本册只做清理与一致性）。
- **stub 孤儿治理（bridge/embedded/stub/peer.mjs）**：重连失败达 **10 次连续** → 打印原因并以退出码 1 退出（宿主侧强杀 node 后 stub 不再无限重连）。同步更新受影响的集成测试预期。**Windows Job Object / 父进程死亡检测方案不做**（对测试件复杂度不值，NOTES 记录；真实对端 napukettoqq 的重连策略属其自身实现）。
- **`pnpm build:jar` 跨壳**：新建 `scripts/build-jar.mjs` 编排全链路（`pnpm -r build` → `scripts/embed.ts` → gradle `:paper:shadowJar`），按 `process.platform` 选 `gradlew.bat`（win32）或 `./gradlew`（POSIX，spawn 前 chmod +x 兜底）；package.json 的 `build:jar` 改为 `node scripts/build-jar.mjs`。原直排命令删除。
- **构建日志乱码**：`build-jar.mjs` 给 gradle 子进程注入 `JAVA_TOOL_OPTIONS`（拼接 `-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8`，保留既有值）实测效果；仍乱码则记 NOTES 降级（显示层问题不阻塞任务，不 `chcp 65001` 改用户控制台状态）。
- **SHASUMS 严格模式（scripts/embed.ts）**：默认行为不变（在线失败回退缓存）但**回退时 WARN 明示 SHASUMS 来源是缓存**；新增环境变量 `KUROBOT_NODE_DIST_STRICT=1` → 拒绝回退、直接失败（发布/CI 用）。vitest 覆盖两模式（假 dist，不发真网）。
- **.gitattributes**：仓库根新增（`* text=auto eol=lf` + 二进制例外 `*.jar`/`*.exe`/`*.png` 等显式 `binary`）；全仓排查既有 CRLF 文件归一为 LF（历史案例：bridge/core/package.json）；`git status` 干净为验收证据。
- **升级提示**：`EmbeddedRuntime` 哈希不符重建路径的 INFO 日志明确写「检测到打包内容变更（升级），已重建 plugins/kurobot/bin」；插件启动完成输出一行汇总 `[KuroBot] 就绪：插件 vX / node vY / 协议 vZ`（版本来源：插件版本、manifest nodeVersion、`PROTOCOL_VERSION`——Java 侧硬编码副本允许，NOTES 记录来源约束）。
- **:paper 单元测试政策维持**：不引 MockBukkit；仅当本册自然抽出可测纯逻辑（如退避间隔计算）时补 JUnit，不强制。

### 1.3 明确不做（防跑偏清单，出现即算偏航）

- 鉴权 token / 版本协商 / command / query / death / 白名单 / 权限（→ DEBT-1；若 DEBT-1 已合入，只做本册范围内的**不回归**验证）。
- 多平台 node 三进制矩阵（linux/macOS；目标部署平台属 MVP-3 napukettoqq 接入阶段的前置拍板，避免盲做）。
- JAR 体积优化（LZMA/分层下载，低优先延续债务）、运行期自动更新、自解压安装器。
- Windows Job Object、进程树强杀工具、跨进程互斥锁。
- napukettoqq 接入、koishi-plugin-kurobot、fabric/neoforge/velocity 接线。
- 多对端并发模型重构（本册只做断连清理与一致性，不改对端容量语义）。

## 2. 动手前必读（顺序执行）

1. `AGENTS.md` —— 工程指南与硬约束
2. `docs/STATUS.md` —— 现状（原型机/MVP 一/二/债务清偿一结论）
3. `docs/MVP1-NOTES.md`（架构发现：强杀 node 留 stub 孤儿、paper.pid 机制）与 `docs/MVP2-NOTES.md`（M2-02 镜像、M2-07 EmbeddedRuntime 归属、M2-09 bin 目录推导）
4. **若 DEBT-1 已完成**：`docs/DEBT1-NOTES.md`（协议 0.3.0 基线、stub 新 env 钩子）
5. `platforms/je/docs/design.md`、`bridge/core/docs/design.md`、`bridge/embedded/docs/design.md` + `platforms/je/core/src/main/java/com/kurobot/core/`（NodeIpc 的 teardown 链路、ProcessFactory、EmbeddedRuntime）与 `KuroBotPlugin.java`（生命周期、双模式加载）
6. `scripts/embed.ts`（EmbedOptions/缓存/SHASUMS 现状）与 `package.json` 的 build:jar

然后：环境基线验证——`mise exec -- pnpm check && mise exec -- pnpm test` 全绿（用例数以 DEBT-1 后基线为准）；`platforms/je` 下 `mise exec -- ./gradlew.bat build` 全绿（**输出重定向文件再读，勿用管道**）；沙盒冒烟（`scripts/paper-start.sh` / `paper-stop.sh`）。

按「设计先行」：动代码前先在触及包的 `docs/design.md` 增「债务清偿二（DEBT-2）」小节（看护状态机、ready.autoRestart 契约、PID 文件语义、stub 重连上限、build-jar 编排）。

## 3. 实现顺序（每阶段至少一个提交，全部简体中文提交说明）

```
阶段 0  设计先行 + 基线验证（可并入阶段 1 提交）
阶段 1  :core：NodeIpc 进程退出通知（退出码 + 原因）、看护器（退避 1s/5s/15s、
        10 分钟窗 3 次上限、given-up 终态）、PID 文件写入/清理/残留提示；
        protocol ready.autoRestart 可选字段（patch 版本顺延）+ vitest/JUnit 补齐
阶段 2  :paper：接线看护（重启走既有启动链、onDisable 停看护、SEVERE 放弃提示）、
        启动完成汇总 INFO、bin 重建升级提示
阶段 3  bridge/core 断连清理与重连一致性（vitest：重连握手/快照/送达数/定时器零泄漏）
        + bridge/embedded：bootstrap 上报 autoRestart + stub 重连 10 次自杀 + 测试预期同步
阶段 4  工程收尾：scripts/build-jar.mjs 跨壳编排 + UTF-8 日志尝试、embed 严格模式
        （KUROBOT_NODE_DIST_STRICT + WARN）、.gitattributes + 全仓 LF 归一
阶段 5  沙盒端到端验收（§4 清单）+ DEBT2-NOTES / STATUS 收尾 + design 回填实际差异
```

## 4. 验收清单（全部打勾 = 任务完成）

1. **门禁全绿**：`mise exec -- pnpm check` / `pnpm test`（用例数只增不减）/ `pnpm -r build`；`platforms/je` 下 `mise exec -- ./gradlew.bat build`（`--rerun` 真跑，:core 用例数只增不减）。
2. **崩溃自动重启**：沙盒运行中 `taskkill` 强杀 node → 日志证据链「退出通知 → 退避重启 → node 重新拉起 → stub 重连 → 双向消息恢复」；`plugins/kurobot/node.pid` 更新为新 pid。
3. **放弃终态**：连续失败 3 次（注入假 ProcessFactory 或坏 node 路径复现）→ SEVERE 放弃日志、服务器不崩、`/kurobot send` 明确报错；`runtime.autoRestart: false` 时强杀后不重启（仅退出通知日志）。
4. **优雅关停回归**：`paper-stop.sh` → node.pid 删除、看护停止、无重启尝试、无进程残留（含 stub——本轮天然优雅路径）。
5. **stub 孤儿自愈**：强杀 node → 孤儿 stub 连续重连 10 次失败后自行退出（进程清单核查：无 stub 残留）。
6. **重连一致性**：vitest 证据——对端断开/重连多轮后握手、绑定快照、send 送达数正确、定时器 pending=0 零泄漏。
7. **一条命令双壳**：Git Bash 与 cmd 各跑一次 `pnpm build:jar` 从零成功（POSIX 贡献者债务关闭）；构建日志 UTF-8 可读或 NOTES 记录降级。
8. **SHASUMS 严格模式**：`KUROBOT_NODE_DIST_STRICT=1` + 在线 SHASUMS 失败（假 dist 注入）→ 直接失败；不带该变量 → 回退缓存 + WARN 来源；默认路径行为不变。
9. **.gitattributes**：落地且 `git ls-files --eol` 无 CRLF 工作区文件残留；`pnpm check` 全绿。
10. **升级提示**：篡改 `plugins/kurobot/bin/manifest.json` 中一文件 → 启动日志出现「检测到打包内容变更（升级），已重建」+「就绪：插件/node/协议」汇总行。
11. **回归**：DEBT-1（若已合入：token/command/query/death/reload）与 MVP1/2 验收路径不回归。
12. `docs/DEBT2-NOTES.md` 完成：决策 D2-xx（含放弃方案）+ 架构发现 + 债务清单更新（多平台矩阵、JAR 体积、msgContinue、serverId、napukettoqq 等延续项）；`docs/STATUS.md` 追加「债务清偿二结论」小节（只追加，不改既有内容）。

## 5. subagent 使用策略

看护器（:core/:paper 生命周期联动强）与断连一致性（core 状态机）**主智能体亲自做**；工程收尾四件（build-jar.mjs / embed 严格模式 / .gitattributes / stub 自杀）互相独立，可派发 subagent（prompt 必须自包含，含边界约束：只写本工作区、biome 风格、零新依赖、完成后自跑 `mise exec -- pnpm check`、**不要 git commit**）。派发纪律：subagent 返回后**主智能体必须亲自复核**（读关键文件、跑门禁、亲测行为），不采信口头完成（原型 D-15 / MVP1 M-17 教训）。

## 6. Windows / Git Bash 注意事项（实测踩坑，勿重趟）

- **gradlew 输出经管道会挂起**（MVP1-NOTES M-18）→ 一律重定向文件再读；Spotless up-to-date 掩盖格式违规 → 跨阶段首跑 `:core:test --rerun`。
- **强杀 node 会留 stub 孤儿**（Windows 无父子级联终止）——本册治理前，中间态验收知晓即可；关服一律 `scripts/paper-stop.sh`。
- node dist 直连失败走 `KUROBOT_NODE_DIST_BASE=https://npmmirror.com/mirrors/node`（缓存 `.cache/node-dist/`）——跑 `pnpm build:jar` / embed 测试时需要。
- mise 的 PATH **不传导**到 Java ProcessBuilder——开发覆盖模式仍需绝对路径（沙盒 paper-start.sh 已处理）。
- Java `Path.resolve("../x")` 是纯字符串拼接，兄弟路径必须以 `getParent()` 为基准（M2-09）。
- `.gitattributes` 提交前先 `git add --renormalize .` 评估波及面，避免与功能提交混在一起（单独一个提交）。
- 验证长驻进程靠 grep 日志（`[KuroBot]` 前缀；`logs/latest.log` 为准）；taskkill 强杀目标以 `node.pid` 为准，勿误杀 mise node。
- cmd.exe GBK 代码页：中间态日志乱码属显示层，不阻塞判断（以英文 token grep 为主）。

---

**一句话总结**：把「node 死了就死、对端断了靠运气、构建只能 Windows」的 MVP 形态收尾成「崩溃自愈、进程卫生、双壳构建、行尾无忧」的健壮基座；之后 MVP-3（napukettoqq 接入 + 多平台矩阵）开题。
