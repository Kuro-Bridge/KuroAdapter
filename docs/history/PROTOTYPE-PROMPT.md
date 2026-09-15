# KuroBot 原型机任务书（无人值守 spike）

> 本文件是一次**无人值守任务**的完整任务书。执行智能体拿到本文即视为唯一指令来源，与任何对话历史无关。
> 完成后本文件保留，作为原型阶段的存档。

---

## 0. 边界与纪律（先读，违反即任务失败）

- **工作区**：`C:\Dev\MC-Ecosystem\KuroAdapter`。所有文件的创建/修改**只允许发生在此目录内**。
- **禁止修改** `C:\Dev\Bot-Dev\` 下任何项目（NapukettoQQ / Koishi-CE 等）。本任务不需要读它们，也不要碰。
- 例外（不算越界）：包管理器/构建工具自身的缓存与家目录（pnpm store、`~/.gradle`、mise、npm cache）。网络下载仅限 npm 依赖、Gradle 依赖、Paper 服务端 jar——下载物一律落盘到工作区内（Paper jar 放 `sandbox/`，该目录已规划为 gitignore）。
- **无人值守规则：禁止向用户提问。** 所有决策自行拍板，并全部记入 `docs/PROTOTYPE-NOTES.md`（做了什么决定、为什么、放弃了哪些替代方案）。只有遇到不停止就无法继续的硬阻塞时才允许结束任务，结束时在 NOTES 里写清阻塞点。
- **Git**：开工前从 `master` 切出分支 `prototype/spike`。小步提交（每完成一个阶段至少一次），**不 push、不合并、不改写历史、不动 master**。pre-commit 钩子会跑门禁，被拒就修到绿再提交。
- 不要修改 `AGENTS.md` 与 `docs/DECISIONS.md` 中已定稿的 ADR 结论。发现架构问题的正确动作是：绕过它完成原型，并把问题记为「ADR 候选」，留人决策。

## 1. 目标：原型机，不是 MVP

原型机只回答一个问题：**「Paper → Java 薄壳 → Node 子进程（IPC）→ bridge/core（WS 服务端）→ 协议端」这条链路端到端能不能跑通？**

原型机的判据是「架构成立」，不是「产品可用」。因此：

### 1.1 必须守住的红线（破了原型就白做）

这些是本仓库硬约束（AGENTS.md），原型阶段同样生效：

1. 消息类型一律 `import { ... } from "@kurobot/protocol"`，任何文件禁止手写。**IPC 的 JSON-lines 帧也进 `@kurobot/protocol`**（SSOT 覆盖一切消息类型）。
2. `bridge/core` 平台无关：零 Node API（`ws`/`process`/`fs`），`WsServer`/`IpcChannel`/`Logger` 全部依赖注入。Node 具体实现（`ws`、stdin/stdout）只出现在引导层（bootstrap / embedded 侧）。
3. Java 薄壳不做业务；IPC 只走 stdin/stdout JSON-lines；kurobot 永远是 WS 服务端，协议端是 client。
4. 依赖方向遵守 AGENTS.md 第 7 条。
5. **IPC 永不阻塞 Bukkit 主线程**：主线程只入队，收发走异步（可用虚拟线程），响应经 scheduler 调回主线程。这是本原型要验证的关键架构性质之一。

### 1.2 已批准的简化（这些是原型机的一部分，不是偷懒）

- Node 运行时用系统 PATH 里的 `node`，**不做** node.exe 进 JAR 的嵌入打包。
- Node bundle 从本地构建产物路径加载（环境变量或开发配置指定），**不做** JAR resources 解压、不做 tools/embed。
- 协议端 = **stub**（本仓库内一个小脚本，伪装对端），**不对接** napukettoqq / wrapper.node / 真实 QQ。
- 配置硬编码或放 `sandbox/` 下的开发用 JSON，不做配置体系。
- 子进程生命周期只保留两条：Java disable/关服 → 关 stdin → Node 自杀（stdin EOF）；Java 侧 kill 兜底。**不做** Watchdog / PID 文件 / 崩溃自动重启。
- 测试只做烟囱级：协议 schema 测试、Java IPC 编解码 JUnit、core 握手状态机 vitest。不追覆盖率门禁。
- 业务模块（绑定/白名单/权限/转发规则）只留最小占位：收到消息 → 判断"绑定了就转发"的假规则即可，目的是打通管道，不是实现业务。

### 1.3 明确不做（防跑偏清单，出现即算偏航）

- 真实 QQ / napukettoqq / wrapper.node / 扫码登录。
- tools/embed 打包链、node.exe 分发、跨平台打包矩阵。
- 完整业务实现、配置 UX、多语言、文档美化、README 重写。
- fast-check、压测、性能优化、批量帧（二期再说）。
- koishi 相关任何东西（独立仓库，且不在本工作区）。
- fabric/neoforge/velocity/lse/endstone（骨架存在即可，不接线）。

## 2. 动手前必读（顺序执行）

1. `AGENTS.md` —— 工程指南与硬约束
2. `docs/STATUS.md` —— 现状与实现顺序
3. `docs/architecture.md` —— 架构书（尤其第 5、6 节：进程模型/IPC 与业务归属）
4. `docs/DECISIONS.md` —— 21 条 ADR（重点 005/006/007/008/010/014/019）
5. `docs/protocol/draft-v0.1.md` 与 `bridge/protocol/docs/design.md`
6. `bridge/core/docs/design.md`、`bridge/embedded/docs/design.md`

然后：验证环境（`node -v`、`pnpm -v`、`java -version`、`pnpm install`、`pnpm check` 全绿作为基线）。按 AGENTS.md「设计先行」，在本次触及的各包 `docs/design.md` 里各加一节「原型阶段（spike）」，写明你实际要建的最小集（不是重写设计，是标注原型裁剪）。

## 3. 验收清单（全部打勾 = 任务完成）

端到端场景，用真 Paper 服务端在 `sandbox/` 里跑：

1. `pnpm check` ✅ `pnpm test` ✅ `pnpm -r build` ✅ `platforms/je` 下 `gradlew.bat build` ✅（shadowJar 产出）。
2. Paper（1.21.x）启动 → 日志可见：插件加载 → Node 子进程拉起 → IPC 就绪 → core 的 WS 服务端监听动态端口 → stub 对端连入 → `hello`/`hello_ack` 握手成功 → 心跳正常。日志统一加 `[KuroBot]` 前缀便于 grep。
3. **游戏 → 平台**：控制台执行 `/kurobot send <文本>`（原型专用开发命令，打上"仅原型"注释）→ stub 对端打印收到的消息。
4. **平台 → 游戏**：stub 对端握手后主动发一条消息 → Paper 控制台出现 broadcast。
5. **生命周期**：控制台 `stop` → Java 关 stdin → Node 子进程退出（`tasklist` 无孤儿 node 进程）；Node 被强杀 → 服务器不卡主线程、不崩溃（允许报错日志，验证了 IPC 异步性）。
6. `docs/PROTOTYPE-NOTES.md` 完成：全部决策记录 + 架构发现（哪些设计被证伪/摩擦大）+ ADR 候选清单 + MVP 阶段债务清单。
7. `docs/STATUS.md` 追加「原型机结论」小节（只追加，不改既有内容）。

## 4. 实现顺序（每阶段一个提交）

```
阶段 0  环境验证 + 切分支 + 建 PROTOTYPE-NOTES.md + 各 design.md 加 spike 小节
阶段 1  bridge/protocol：最小 schema 集（见 4.1）+ draft 文档同步
阶段 2  双侧并行（见 §5 subagent 策略）：
          TS：bridge/core 最小闭环（传输接口 + CoreContext + 握手状态机 + 心跳
              + chat 收发 + IPC channel 接口）+ Node 引导层（ws 适配器 + stdin/stdout IPC）
          Java：:core IPC 编解码（JSON-lines + UUID 关联，JUnit 可独立测）
              + :paper 薄壳（生命周期 + AsyncChatEvent + scheduler + /kurobot 命令）
阶段 3  stub 协议端 + 引导层组装（Node 拉起 stub，见 4.2）+ TS↔Java 真管道联调（可先无 Paper：
          用 Java 集成测试直接拉 node 子进程验证 IPC 环）
阶段 4  sandbox Paper 服务端搭建 + 端到端验收（跑 §3 清单）
阶段 5  收尾：NOTES/STATUS 更新、清理临时代码、最终报告
```

### 4.1 阶段 1 的最小 schema 集（可增不可减，命名对齐 draft-v0.1.md）

- WS 侧：`hello` / `hello_ack`（含 `protocolVersion` 能力协商）、心跳 ping/pong、游戏→平台聊天事件、平台→游戏聊天。
- IPC 侧：`ready`（Node→Java，携带 WS 端口）、游戏聊天事件（Java→Node）、`broadcast` 请求（Node→Java）、`executeCommand` 请求（Node→Java）、关机通知。UUID 请求-响应 + 事件推送两种帧型（ADR-010）。
- Java 侧按 schema 手写 Jackson DTO（ADR-008：不做代码生成）。

### 4.2 embedded 引导模型（本原型顺手回答一个悬案）

架构文档未定「内嵌协议端与 core 同进程还是子进程」。原型采用**最简方案并记录为 ADR 候选**：Node 引导层（embedded bootstrap）先向 Java 完成 IPC 握手、`listen(0)` 拿到端口后，**作为子进程拉起 stub 协议端**（端口经 argv 传入）。这样 Java 只管一个子进程，生命周期级联天然成立（Java→node→stub），且协议端与 external 模式的 Koishi 走完全相同的 WS client 路径——架构同构性得以验证。

## 5. subagent 使用策略（要求积极使用）

主智能体持有：协议 schema 定稿、跨侧集成、全部验收。其余尽量派发。**每个 subagent 的 prompt 必须自包含**，且必须包含边界约束（只写本工作区、遵守 biome 代码风格、不引入未指明的新依赖、完成后自跑 `pnpm check` 或对应测试）。

适合派发（可并行）：

1. **Java IPC 编解码**（`:core`）：JSON-lines 帧读写、UUID 请求-响应关联、子进程拉起/销毁，配 JUnit。独立可测，与 TS 侧无耦合（schema 已定稿）。
2. **Java 薄壳**（`:paper`）：插件生命周期、`AsyncChatEvent` 监听与异步派发、scheduler 回主线程、`/kurobot` 命令注册。
3. **Node 侧**：`ws` 适配器 + stdin/stdout IPC 实现 + bootstrap 组装。
4. **stub 协议端**：小脚本，握手、心跳应答、收发打印。
5. **sandbox 搭建**：经 papermc API 下载 Paper 1.21.x 至 `sandbox/`、自动接受 EULA、写启动/停止脚本与日志约定。可最早派发，与编码并行。

派发纪律：subagent 返回后**主智能体必须亲自复核**（跑 check/测试/编译，读关键文件），不采信口头完成；发现不合红线直接打回重做。

## 6. Windows / Git Bash 注意事项

- Java 构建用 `gradlew.bat`（AGENTS.md 规定）。
- 长驻进程（Paper、node）放后台运行并重定向日志到 `sandbox/` 下的文件，验证靠 grep 日志，不要靠盯终端。
- 路径含空格/反斜杠时注意引号；Gradle/Java 输出编码问题以日志文件为准。
- **卡住规则**：任一阶段超过约 30 分钟无实质进展 → 降级目标并记录（例：Paper 起不来 → 先用 Java 集成测试模拟 Bukkit 侧完成 IPC 环验证；`AsyncChatEvent` API 对不上 → 用最低版本 API + 注释标注）。降级后继续推进，不要原地打转。

---

**一句话总结**：造一台能跑的样机，验证「一个 JAR、两个进程、一条消息双向跑通」；所有取巧都要留下记录，所有发现都写给下一个阶段的自己。
