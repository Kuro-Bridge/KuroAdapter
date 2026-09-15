# KuroBot MVP 阶段二任务书（无人值守）——打包闭环

> 本文件是一次**无人值守任务**的完整任务书。执行智能体拿到本文即视为唯一指令来源，与任何对话历史无关。
> 完成后本文件保留，作为 MVP 阶段二的存档。
> 前置状态：MVP 阶段一已完成并验收（master；结论见 `docs/STATUS.md`「MVP 阶段一结论」，全部决策与踩坑见 `docs/MVP1-NOTES.md`）。
> 范围由用户拍板：**打包闭环**——插件从「环境变量加载」变成「装上就能用」。

---

## 0. 边界与纪律（先读，违反即任务失败）

- **工作区**：`C:\Dev\MC-Ecosystem\KuroAdapter`。所有文件的创建/修改**只允许发生在此目录内**。
- **禁止修改** `C:\Dev\Bot-Dev\` 下任何项目。
- **无人值守规则：禁止向用户提问。** 所有决策自行拍板，并全部记入 `docs/MVP2-NOTES.md`（做了什么决定、为什么、放弃了哪些替代方案）。只有遇到不停止就无法继续的硬阻塞时才允许结束任务，结束时在 NOTES 里写清阻塞点。
- **Git**：直接在 `master` 上小步提交（简体中文提交说明，每阶段至少一个提交）。**不 push、不改写历史**。pre-commit 钩子（lefthook：`pnpm check` + `pnpm test`）被拒就修到绿再提交。
- **GPG 注意**：仓库开了 commit 签名。若 `git commit` 超过约 2 分钟无输出，疑似 gpg-agent 口令缓存过期挂起——**禁止 `--no-gpg-sign`**；结束任务并在 NOTES 写明已暂存的变更清单，交由用户交互提交。
- 不要修改 `AGENTS.md` 与 `docs/DECISIONS.md` 中既有 ADR 的结论；本阶段新决策**追加**新 ADR（编号从 ADR-026 起）。
- **一切构建/测试命令统一经 `mise exec -- <cmd>`**（PATH 直连的 node 是 24、java 是 21；mise 提供 node 26.7.0 / java 25.0.2 / gradle 9.7.0）。
- **卡住规则**：任一阶段超过约 30 分钟无实质进展 → 降级目标并记 NOTES，继续推进不原地打转。

## 1. 目标：JAR 自含运行时，装上就能用

现状：`:paper:shadowJar` 不含 Node 运行时与业务 bundle，生产加载依赖 `KUROBOT_NODE` / `KUROBOT_BUNDLE` 环境变量（原型批准的临时形态，MVP1 §1.2）。本阶段重建嵌入式打包链（架构书 §9，ADR-014「node.exe（MIT）进 JAR」）：

1. `scripts/embed` 打包工具重建：node.exe（win-x64）+ LICENSE + bridge/embedded 产物 → `:paper` 构建期资源。
2. 运行期解压加载链：JAR 内资源 → 磁盘（不可从 JAR 内直接 exec）→ 拉起 Node。
3. `pnpm build:jar` 一条命令跑通全链路。

### 1.1 必须守住的红线（同 AGENTS.md，违反即任务失败）

1. 消息类型一律 `import { ... } from "@kurobot/protocol"`，禁止手写。
2. `bridge/core` 平台无关（零 Node API）——**本阶段预期不触碰 core**；如确需，先在 design.md 说明理由。
3. Java 薄壳不做业务；IPC 只走 stdin/stdout JSON-lines；kurobot 永远是 WS 服务端。
4. 依赖方向遵守 AGENTS.md 第 7 条；不引入未指明的新依赖；不复制 HuHoBot / NapCat / NapukettoQQ 代码。

### 1.2 已批准的简化（这些是本阶段的一部分，不是偷懒）

- **只嵌 win-x64 node.exe**（版本钉 **26.7.0**，与 mise 一致）；linux/mac 多平台矩阵记后续债务。
- **stub 协议端不进 JAR**（它是测试件）：沙盒继续经 `KUROBOT_STUB_PEER` 指向仓库内 `bridge/embedded/stub/peer.mjs`；napukettoqq 协议端接入是后续阶段。
- 解压目标目录：**与 Node 侧配置目录同基**（相对服务器根的 `plugins/kurobot/bin/`，小写 kurobot——Node 读配置就是 `plugins/kurobot/config.json`；注意 paper-plugin.yml 的 name 是 `KuroBot`，getDataFolder() 在大小写敏感文件系统上会得到不同目录，此坑须在 NOTES 记录取舍）。
- `KUROBOT_NODE` / `KUROBOT_BUNDLE` **保留为开发覆盖**：环境变量优先于 JAR 解压（沙盒与 CI 可继续用 mise node）。
- 解压策略：缺文件或 sha256 与 JAR 内不符才解压（幂等，支持版本升级覆盖）。
- node.exe 下载校验：nodejs.org 官方 dist + `SHASUMS256.txt` sha256 校验；支持环境变量指定本地缓存/镜像（下载失败可换 npmmirror 等镜像，校验逻辑不变）。

### 1.3 明确不做（防跑偏清单，出现即算偏航）

- 多平台 node 三进制矩阵、运行期自动更新、自解压安装器、代码签名。
- wrapper.node / napukettoqq / 扫码登录（协议端后续阶段）。
- 白名单/权限、Watchdog/重连、koishi-plugin-kurobot（独立仓库，另有安排）。

## 2. 动手前必读（顺序执行）

1. `AGENTS.md` —— 工程指南与硬约束
2. `docs/STATUS.md` —— 现状（含「原型机结论」「MVP 阶段一结论」两小节）
3. `docs/MVP1-NOTES.md` —— M-01~M-20 决策 + 架构发现 + MVP-2 债务清单（本阶段需求来源）
4. `docs/architecture.md`（重点 §9 嵌入式打包要点、§7 目录树——embed 工具归 `scripts/`）
5. `platforms/je/docs/design.md`、`bridge/embedded/docs/design.md`、`bridge/core/docs/design.md`
6. `platforms/je/paper/build.gradle.kts`（注意已存在 kurobotBuild 任务，见 PROTOTYPE-NOTES「Shadow 9 不把 shadowJar 挂进 assemble」条目）与 `KuroBotPlugin.java`（现状的环境变量加载链）

然后：环境基线验证——`mise exec -- pnpm check && mise exec -- pnpm test` 全绿；`platforms/je` 下 `mise exec -- ./gradlew.bat build` 全绿（**输出重定向文件再读，勿用管道**）；沙盒就绪（`scripts/paper-start.sh` / `paper-stop.sh`，冒烟即可）。

按「设计先行」：动代码前先在各触及包的 `docs/design.md` 加「MVP 阶段二」小节（scripts/embed 的产物契约、:paper 的解压加载链与降级语义）。

## 3. 实现顺序（每阶段至少一个提交，全部简体中文提交说明）

```
阶段 0  设计先行（design.md 增「MVP 阶段二」小节）+ 基线验证（可并入阶段 1 提交）
阶段 1  scripts/embed.mjs（Node 脚本，只用内置依赖）：
        - 下载/校验 node-v26.7.0-win-x64.zip（sha256 对 SHASUMS256.txt；本地缓存目录须 gitignored）
        - 只取 node.exe + LICENSE → platforms/je/paper/src/main/resources/embedded/
          （产出：node.exe、index.mjs（自 bridge/embedded/dist/）、NODE_LICENSE 之类命名的许可证文件）
        - 幂等：目标已存在且 sha256 一致 → 跳过；产物的 sha256 清单落盘（供运行期比对）
        - pnpm build:jar 接线：pnpm -r build && node scripts/embed.mjs && gradlew :paper:shadowJar
        - 纯逻辑（哈希比对/路径推导）配 vitest；下载器做成可注入以便测试不发真网
阶段 2  :paper 运行期加载链（KuroBotPlugin）：
        - 无 KUROBOT_NODE/KUROBOT_BUNDLE 时：从 JAR 解压 embedded 资源到 plugins/kurobot/bin/
          （java.util.zip；**防 zip slip**：entry 名规范化校验；解压前 bin 内旧文件 sha256 比对，一致则跳过）
        - 解压失败 → SEVERE 日志 + 插件保持加载但无 IPC（对齐既有「开发模式」降级语义），不崩服
        - KUROBOT_STUB_PEER 语义不变：未设置且 bundle 来自 JAR 解压 → 无 stub，INFO 日志说明
        - 解压/复用/哈希不符重建均落 [KuroBot] 前缀 INFO 日志（验收靠 grep）
        - scripts/paper-start.sh 同步：不再强制导出 KUROBOT_NODE/KUROBOT_BUNDLE（保留 KUROBOT_STUB_PEER）
阶段 3  沙盒端到端验收（§4 清单）+ NOTES / STATUS 收尾 + design 回填实际差异
```

## 4. 验收清单（全部打勾 = 任务完成）

1. **门禁全绿**：`mise exec -- pnpm check` / `pnpm test` / `pnpm -r build`；`platforms/je` 下 `mise exec -- ./gradlew.bat build`，且 `:core:test --rerun` 真跑（36 用例，含真管道集成测试——本阶段不动 TS 协议，它不应变红）。
2. **一条命令全链路**：清空 `resources/embedded/` 后 `pnpm build:jar` 从零跑到 shadowJar 成功；`unzip -l` 证据：`kurobot-0.1.0.jar` 内含 `embedded/node.exe`、`embedded/index.mjs` 与许可证文件。
3. **沙盒真装路径**：不设 `KUROBOT_NODE`/`KUROBOT_BUNDLE`（仅 `KUROBOT_STUB_PEER`）→ `paper-start.sh` → 日志显示「JAR 解压 + node 拉起 + stub 握手」+ 双向消息仍通（`/kurobot send` 到 stub、stub 平台消息进游戏广播——沙盒配置已绑定 stub-channel）。
4. **幂等与自愈**：二次启动日志显示「复用，不解压」；删除 `plugins/kurobot/bin/` 后启动自动恢复。
5. `docs/MVP2-NOTES.md` 完成：全部决策记录（含放弃方案）+ 架构发现 + 债务清单更新（多平台矩阵、napukettoqq 接入等）。
6. `docs/STATUS.md` 追加「MVP 阶段二结论」小节（只追加，不改既有内容）。

## 5. subagent 使用策略

本阶段规模小，**主智能体亲自做为主**。`scripts/embed.mjs` 可派发 subagent（prompt 必须自包含，含边界约束：只写本工作区、biome 风格、零新依赖、完成后自跑 `mise exec -- pnpm check`、**不要 git commit**）。派发纪律：subagent 返回后**主智能体必须亲自复核**（跑脚本、读关键文件、亲测产物哈希），不采信口头完成（原型 D-15 / MVP1 M-17 的教训）。

## 6. Windows / Git Bash 注意事项（实测踩坑，勿重趟）

- **gradlew 输出经管道（`| tail` 等）会挂起客户端**（daemon 早已完成、客户端不退出）→ 一律重定向到文件再读（MVP1-NOTES M-18）。
- mise 的 PATH **不传导**到 Java ProcessBuilder 的可执行文件搜索——开发覆盖模式仍需绝对路径；JAR 解压出的 node 路径天然绝对，无此问题。
- Java `Path.resolve("../x")` 是纯字符串拼接，兄弟路径必须以 `getParent()` 为基准。
- zip 解压必须防 **zip slip**（entry 名规范化后校验仍在目标目录内）；node.exe 只在启动路径解压（此时必然未运行，无文件占用问题），勿加运行期覆盖逻辑。
- 强杀 node 会留下 stub 孤儿（Windows 无父子级联终止，MVP1-NOTES 架构发现）；关服一律 `scripts/paper-stop.sh`。
- Spotless 的 up-to-date 会掩盖格式违规：跨阶段首跑建议 `:core:test --rerun` 或显式 `spotlessCheck`。
- PaperMC 下载走 `fill.papermc.io`（v2 已 sunset）——类比：nodejs.org 直链 + sha256 校验为准，不要猜第三方 API。
- 验证长驻进程靠 grep 日志（`[KuroBot]` 前缀）；`logs/latest.log` 为准。

---

**一句话总结**：把「开发机环境变量驱动的原型加载」升级为「JAR 自含 Node 运行时的可分发插件」；napukettoqq 协议端接入与多平台矩阵留给后续阶段。
