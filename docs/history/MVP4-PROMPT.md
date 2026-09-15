# KuroBot MVP 阶段四任务书（无人值守）——embedded 形态：JAR 内嵌 napuketto（MVP-4）

> 本文件是一次**无人值守任务**的完整任务书。执行智能体拿到本文即视为唯一指令来源，与任何对话历史无关。
> 完成后本文件保留，作为 MVP-4 的存档。
> 前置状态：原型、MVP-1/2/3、DEBT-1/2 全部完成并验收（master；结论见 `docs/STATUS.md`）。
> 协议现状 v0.3.1。**NapukettoQQ 侧 kurobot 适配器已完成**（`@napuketto/adapter` 0.2.1 已发
> npm；其仓内镜像协议 schema 的 golden-frame 测试锁定本仓 b0809ef / 0.3.1——这就是本册
> 「目标零协议变更」的由来）。
> **范围由用户拍板（2026-09-14 开题对齐）**：
> ① **最小 Java 命令**：允许 :paper 增量（`/kurobot qr` 级别，1~2 个命令），不是零 Java。
> ② **napuketto 侧配置 SSOT = napuketto 自己的 TOML**（服主直接维护，KuroAdapter 只用
>    `NAPKETTO_CONFIG` 指路）——代价：静态 TOML 写不了动态端口，**embedded 模式强制要求
>    config 配 `ws.port` 固定端口**。
> ③ **目标零协议变更**（0.3.1 不动）；若执行期证明必须动协议，只允许 patch 0.3.2 且 NOTES
>    论证（代价：napuketto 侧 golden 锁重对齐，尽量避免）。
> ④ **QQ 宿主 Windows-only**（napuketto self-host 是 Windows 原生；Linux/wine 记债务）。

---

## 0. 边界与纪律（先读，违反即任务失败）

- **工作区**：`C:\Dev\MC-Ecosystem\KuroAdapter`。所有文件的创建/修改**只允许发生在此目录内**。
- **允许只读查阅** `C:\Dev\Bot-Dev\NapukettoQQ`（实现考据：`apps/cli/src`（boot/supervisor/
  config-template）、`packages/loader/src/host/env.ts`、`packages/adapter/src/kurobot/`、
  `docs/KUROBOT-NOTES.md`），**禁止修改该仓任何文件**——napuketto 侧行为以 npm 发布物实测
  为准，发现其缺陷只记 NOTES，不顺手修。
- **无人值守规则：禁止向用户提问。** 所有决策自行拍板，并全部记入 `docs/MVP4-NOTES.md`
  （新建，决策编号 M4-01 起；做了什么决定、为什么、放弃了哪些替代方案）。只有遇到不停止
  就无法继续的硬阻塞时才允许结束任务，结束时在 NOTES 写清阻塞点。
- **Git**：直接在 `master` 上小步提交（简体中文提交说明，每阶段至少一个提交）。**不 push、
  不改写历史**。pre-commit 钩子（lefthook：`pnpm check` + `pnpm test`）被拒就修到绿再提交。
- **GPG 注意**：仓库开了 commit 签名。若 `git commit` 超过约 2 分钟无输出，疑似 gpg-agent
  口令缓存过期挂起——**禁止 `--no-gpg-sign`**；结束任务并在 NOTES 写明已暂存的变更清单，
  交由用户交互提交。
- 不要修改 `AGENTS.md` 与 `docs/DECISIONS.md` 中既有 ADR 的结论；本阶段新决策**追加**新
  ADR（**编号从 ADR-029 起**，动笔前先读 `docs/DECISIONS.md` 末尾确认最大号——当前已知
  最大号为 ADR-028）。
- **一切构建/测试命令统一经 `mise exec -- <cmd>`**（PATH 直连的 node/java 版本不对；mise
  提供 node 26.7.0 / java 25.0.2 / gradle 9.7.0）。
- **卡住规则**：任一阶段超过约 30 分钟无实质进展 → 降级目标并记 NOTES，继续推进不原地打转。

## 1. 目标与范围

现状：embedded 产物只有 `node.exe + index.mjs`（KuroAdapter 自身），孙进程协议端只有 stub；
「装个 JAR、扫一次码即得群服互通」的开箱即用形态缺最后一环。MVP-3 已打通 external 链路
（固定端口 / token / peer-guide），napuketto 侧适配器已就绪——本阶段把 napuketto 嵌进 JAR，
让 ADR-022 孙进程模型从 stub 换成真身。进程树变为：Java → node（kurobot WS 服务端）→
napuketto CLI（内部再自带 supervisor 子进程，最深四层）。

### 1.1 必须守住的红线（同 AGENTS.md，违反即任务失败）

1. **许可边界（ADR-014 精神，本册特有硬红线）**：进 JAR 的只有 MIT 的 npm 发布物
   （`@napuketto/*` 及其 npm 依赖）；**wrapper.node、QQ 安装包、QQNT 相关腾讯二进制绝不进
   JAR 不进仓**（napuketto 运行期自取，本册不碰其下载逻辑）；loader npm 包自带的 stub
   DLL 等闭源件仅随 npm 包原样分发（与 `npm install` 等价，不额外拷贝）。NOTES 记录完整
   嵌包清单与各自许可。
2. 消息类型一律 `import { ... } from "@kurobot/protocol"`，禁止手写；协议 SSOT 是
   `bridge/protocol` 的 zod schema。**本册目标零协议变更**。
3. `bridge/core` 平台无关（零 Node API）；logger/clock/scheduler 一律注入。**embedded 段的
   形状可归 core（SSOT 惯例），消费方在 embedded**（先例：ws 段 / ADR-028）。
4. Java 薄壳不做业务；IPC 只走 stdin/stdout JSON-lines；**kurobot 永远是 WS 服务端**。
5. 依赖方向遵守 AGENTS.md 第 7 条；新依赖只允许 `@napuketto/cli`（精确版本 pin）。
6. **workspace 跨包解析走 dist 产物**：改 `bridge/protocol` / `bridge/core` 源后必须先
   `pnpm -r build` 再 `pnpm check`/`pnpm test`。

### 1.2 已拍板的关键决策（按此实现，若有更优方案须在 NOTES 论证后仍自行拍板）

- **嵌入入口 = napuketto CLI**（`@napuketto/cli` 的 dist 入口）：它的 supervisor（子进程
  拉起/自动重启/终止转发）、QR 三呈现（PNG 文件 / URL 日志 / 终端 ASCII）、凭据持久化
  （腾讯原生层）都是现成能力，**KuroAdapter 不重造，只做拉起、stdio 捕获→logger、生命周期
  接线**。QQ 登录流程完全交给 napuketto，KuroAdapter 不解析、不干预。
- **依赖落位**：`bridge/embedded` 增依赖 `@napuketto/cli`（精确版本 pin，当前已知 0.1.17，
  以执行期 npm 实查为准）；napuketto 的运行时许可文件（MIT）随包收集，待遇对齐
  `NODE_LICENSE`。
- **config 新增顶层 `embedded` 段**（形状 SSOT 归 core zod，消费在 embedded）：建议形状
  `{ napuketto: { enabled: boolean, configPath?: string, dataDir?: string } }`——缺省无段 =
  现状不变（stub 孙进程）。字段定稿执行期拍板，并回填 `docs/config-schema.md`。
- **固定端口强制**：`enabled` 且 config 无 `ws.port` → 启动**明确 error + 不拉起
  napuketto**（快速失败语义，与 WsBindError 同族）。理由：napuketto TOML 的 `url` 是静态
  的，动态端口无法喂给它。`ws.host` 建议默认 `127.0.0.1`（本机孙进程不暴露）。
- **napuketto 拉起参数**：env `NAPKETTO_CONFIG=<configPath>`（默认
  `plugins/kurobot/napuketto.toml`）、`NAPKETTO_DATA=<dataDir>`（默认
  `plugins/kurobot/napuketto-data`，**与服主日常 napuketto 数据隔离**）；`NAPUTO_QQ_PATH`
  等其余 napuketto env 由 KuroAdapter 原样透传（不默认设置）。**stdio 必须 pipe、绝不
  inherit**——node 的 stdout 是 IPC 通道，污染即断 IPC；捕获输出统一 `[napuketto]` 前缀走
  注入 logger。
- **生命周期**：
  - 优雅关停：stop → node 先终止 napuketto（CLI 自带终止转发 + 5s 强杀）再自退；
  - 强杀 node → napuketto 树预期随 Job Object 级联死亡（DEBT-2 发现）——**四层进程树须
    复验实证**，结论记 NOTES；
  - CLI 意外退出 → node 按既有语义退出 → Java 看护器退避重启 → node 重拉 CLI（凭据在
    腾讯原生层，重启后 quick-login 自动恢复）。
- **QR 交接（零协议变更路径）**：node 监测 QR 会话（napuketto 数据目录下 `qrcode.png`
  变化 + 捕获流中的 URL 日志）→ 落地稳定路径 `plugins/kurobot/qr.png` + `qr.json`
  （`{ pngPath?, url?, detectedAt }`）——**node.pid 式运维文件先例**。:paper 新增
  `/kurobot qr`：读该状态输出 PNG 绝对路径 + URL（有则）+ 指引文案；权限与既有 `/kurobot`
  命令一致。URL 解析是 best-effort（napuketto 日志格式变更即失效，PNG 路径为主）。
  若执行期证明文件交接不可行，允许改走 IPC 帧（协议 patch 0.3.2 + napuketto 侧重对齐），
  NOTES 论证。
- **非 Windows 守卫**：`enabled` 且宿主非 Windows → 明确 error 日志 + 不拉起（债务：wine）。
- **stub 路径零改动**：dev 覆盖（`KUROBOT_BUNDLE`）与既有测试的 stub 路径不动；napuketto
  spawner 是 embedded 内新增分支。探索发现 napuketto 有 `NAPUTO_SMOKE` / `NAPUTO_PROBE`
  钩子（用途待考据）——若能提供免真登录的烟测路径，纳入无人值守验收。
- **沙盒配置（本地不入库）**：napuketto.toml 与数据目录放
  `sandbox/server/plugins/kurobot/` 下（gitignore 内）；验收配置固定端口（建议 25580，
  沿 MVP-3）+ token。

### 1.3 明确不做（防跑偏清单，出现即算偏航）

- NapukettoQQ 仓任何改动（含给它的 TOML/env 加钩子）；koishi-plugin-kurobot。
- 多平台 node 三进制矩阵、build:jar SHASUMS 严格模式转默认；wine/Linux QQ 宿主。
- QQ 验证码（滑块/短信）处理、QQ 版本升级策略、napuketto 自动更新、多账号管理面。
- TLS/wss、msgContinue/msgEnd 流式、status 周期上报、serverId 互联。
- fast-check 属性测试、:paper 新增 MockBukkit。

## 2. 动手前必读（顺序执行）

1. `AGENTS.md` —— 工程指南与硬约束
2. `docs/STATUS.md` —— 现状（六节阶段结论）
3. `docs/MVP3-NOTES.md`（ws 段/绑定失败语义/stub 钩子）+ `docs/MVP2-NOTES.md`（打包链、
   EmbeddedRuntime 解压校验）+ `docs/DEBT2-NOTES.md`（看护器退避、Job Object 级联死亡）
4. `docs/protocol/peer-guide.md`（对端视角——napuketto 就是按它实现的）
5. `bridge/embedded/docs/design.md` + `bridge/embedded/src/index.ts`（bootstrap）+
   `bridge/embedded/stub/peer.mjs`
6. `bridge/core/src/business/config.ts` + `transport.ts`
7. `scripts/embed.ts` + `scripts/build-jar.mjs` + `platforms/je` :core `EmbeddedRuntime`
8. `docs/config-schema.md`（本册要扩展的文档）
9. NapukettoQQ 仓只读参考：`apps/cli/src/boot.ts` / `supervisor.ts` /
   `config-template.ts`、`packages/loader/src/host/env.ts`、`docs/KUROBOT-NOTES.md`

然后：环境基线验证——`mise exec -- pnpm check && mise exec -- pnpm test`（146 用例）全绿；
`platforms/je` 下 `mise exec -- ./gradlew.bat build` 全绿（**输出重定向文件再读，勿用管道**）；
沙盒冒烟（`scripts/paper-start.sh` / `paper-stop.sh`）。

按「设计先行」：动代码前先在 `bridge/core/docs/design.md`、`bridge/embedded/docs/design.md`
增「MVP 阶段四（MVP-4）」小节（embedded 段语义、spawner 契约、打包形状、QR 交接、生命周期
矩阵、固定端口强制），并起草 ADR-029。

## 3. 实现顺序（每阶段至少一个提交，全部简体中文提交说明）

```
阶段 0  设计先行（design.md MVP-4 小节 + ADR-029 草案）+ 基线验证
        + 依赖落位（bridge/embedded pnpm add @napuketto/cli 精确版本 + 许可文件收集）
阶段 1  bridge/core：configSchema/defaultConfig 增 embedded 段 + design 回填 + vitest
阶段 2  bridge/embedded：napuketto spawner（env 组装 / stdio 捕获 / 生命周期接线 /
        固定端口强制 / 非 Windows 守卫）+ bootstrap 分支接线 + vitest（子进程命令可注入）
阶段 3  打包链：scripts/embed.ts 增 napuketto 产物收集（pnpm deploy 或等效 → 自包含
        node_modules → 单一 zip 资源 → manifest）+ :core EmbeddedRuntime 解压扩展（如需）
        + pnpm build:jar 全链路 + JAR 冒烟（拉起到 QR 层）
阶段 4  QR 状态文件（embedded）+ /kurobot qr（:paper）+ docs/config-schema.md 增 embedded 段
阶段 5  沙盒分层验收（§4 无人值守部分）+ MVP4-NOTES / STATUS「MVP 阶段四结论」
        + design 回填实际差异 + 「用户协作清单」（真扫码终验步骤，写给用户）
```

## 4. 验收清单（无人值守部分全部打勾 + 协作清单写好 = 任务完成）

1. **门禁全绿**：`mise exec -- pnpm check` / `pnpm test`（146 → 预期 160+ 用例）/
   `pnpm -r build`；`platforms/je` 下 `mise exec -- ./gradlew.bat build`（:core 65+ 用例，
   `--rerun` 真跑）。
2. **打包链**：`pnpm build:jar` 一条命令产出含 napuketto 产物的 JAR；manifest 校验覆盖新
   资源；二次启动「复用/解压 0」幂等；JAR 内**不含** wrapper.node / QQ 安装包（清单 grep
   证据）；JAR 体积实测记 NOTES（优化留债务）。
3. **无 embedded 段回归**：config 无 embedded 段 → 行为与现状逐项一致（stub 孙进程、动态
   端口、既有测试全过）。
4. **embedded 启动链（无人值守到 QR 层）**：config embedded 段 + napuketto.toml +
   `ws.port` → node 拉起 CLI → `[napuketto]` 前缀日志可见 → （真登录前的所有可验环节：
   数据目录创建、QQ 定位或下载、登录会话启动）。
5. **QR 交接**：QR 会话出现 → `plugins/kurobot/qr.png` / `qr.json` 落地且随刷新更新；
   `/kurobot qr` 输出 PNG 绝对路径 + URL（可得时）；QR 过期自动刷新链路可见。
6. **固定端口强制**：enabled 且无 ws.port → 明确 error、不拉起 napuketto；配了 ws.port →
   napuketto.toml 的 url 能连上（日志 grep 握手证据——若无人值守无法完成真登录，以
   `KUROBOT_STUB_WS_URL` 独立 stub 连同一固定端口作服务端侧证据）。
7. **生命周期矩阵**：stop → napuketto 树优雅退出 + 无孤儿（四层进程树逐一验证，
   MSYS pid 坑注意 winpid）；强杀 node → napuketto 树级联死亡复验（Job Object 对更深树
   是否仍成立）；CLI 意外退出 → 看护器退避重启 → node 重拉 CLI。
8. **红线回归**：stub 路径零改动证据（既有 stub 测试不修改仍绿）；`bridge/core` 仍零
   Node API（grep 证据）。
9. **文档收尾**：`docs/MVP4-NOTES.md`（决策 M4-xx 含放弃方案 + 嵌包清单与许可 + 债务清单
   更新）+ `docs/STATUS.md` 追加「MVP 阶段四结论」（只追加不改旧）+ 各 design.md 回填 +
   `docs/config-schema.md` 增 embedded 段 + ADR-029 定稿。
10. **用户协作清单**（写进 MVP4-NOTES 末尾，执行者不执行）：真机扫码 → 登录成功 →
    hello `client` 自报可见 → 真实群消息 ↔ 游戏双向（模板渲染效果主观确认）；`/kurobot qr`
    实操体验；（可选）指向既有 `.napuketto` 数据目录的 quick-login 冒烟。

## 5. subagent 使用策略

本册跨 TS / 打包 / Java / 沙盒，允许适度派发（如 :paper 命令、文档初稿、napuketto 行为
考据）。prompt 必须自包含（含边界约束：只写本工作区、biome 风格、`import type`、完成后
自跑 `mise exec -- pnpm check`、**不要 git commit**）；subagent 返回后主智能体必须亲自
复核（读文件、跑门禁、亲测行为），不采信口头完成。打包链与 spawner 等跨包联动紧的部分
建议主做。

## 6. Windows / Git Bash 注意事项（实测踩坑，勿重趟）

- **改 TS 后跑沙盒必须 `pnpm build:jar`**——插件 JAR 内嵌构建期产物，旧 JAR 会让新逻辑
  看似「没生效」（MVP-3 教训）。
- napuketto 首启可能下载 QQ 安装包（~313MB，网络敏感）——沙盒优先让 `NAPUTO_QQ_PATH`
  指向本机已有 QQ（考据该 env 确切行为后用）；**instance.lock**：同一账号数据目录单实例，
  沙盒数据目录务必与服主日常 napuketto 隔离。
- pnpm 仓的 node_modules 是 symlink——打包收集必须真实文件（`pnpm deploy` 或等效），
  别把 symlink 打进 zip。
- **无人值守跑沙盒服务器必须 `run_in_background` 承载主进程**；该方式不更新 paper.pid，
  关停以 TaskStop + 端口检查为准（DEBT1-NOTES D1-06）。
- gradlew 输出经管道会挂起 → 重定向文件再读；Spotless up-to-date 掩盖格式违规 → 跨阶段
  首跑 `:core:test --rerun`。
- mise 的 PATH 不传导到 Java ProcessBuilder（沙盒 paper-start.sh 已处理）；验证长驻进程
  靠 grep 日志（`[KuroBot]` 前缀，`logs/latest.log` 为准）；MSYS pid ≠ Windows pid；
  异步测试的日志基线快照必须先于触发动作。
- node dist 下载直连易失败 → `KUROBOT_NODE_DIST_BASE=https://npmmirror.com/mirrors/node`；
  npm 安装 @napuketto/* 慢/失败时切 npmmirror registry（装完核对 integrity）。
- sandbox 配置改完记得还原基线；端口占用测试用完记得释放。

---

**一句话总结**：给插件装上「开箱即用」的最后一环——JAR 里带一个真 QQ 协议端，服主填一个
TOML、扫一次码，群服互通即通；协议 0.3.1 一字不动，napuketto 侧零改动。
