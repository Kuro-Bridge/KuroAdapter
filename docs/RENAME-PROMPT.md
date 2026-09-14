# 改名任务书（无人值守）——KuroBot → KuroBridge / @kuro-bridge（品牌迁移）

> 本文件是一次**无人值守任务**的完整任务书。执行智能体拿到本文即视为唯一指令来源，与任何对话
> 历史无关。完成后本文件保留，作为改名阶段的存档。
> 前置状态：MVP-4 已完成验收；终验期 UX 增量（MVP4-NOTES §7，M4-11/12）已在工作树**未提交**
> ——本册阶段 0 先行处理。真机终验停在「napuketto 端 kurobot 支持未发布」（发现 H），
> **本册即为其前置**：napuketto 尚未发布 kurobot 支持，正好一次换到新名发布，避免双重发布。
> **范围由用户拍板（2026-09-14 开题对齐，四项）**：
> ① npm scope `@kurobot/*` → **`@kuro-bridge/*`**（与 GitHub 组织 Kuro-Bridge 一致）。
> ② 面向用户标识统一 **`kurobridge`**：MC 命令 `/kurobridge`、数据目录 `plugins/kurobridge/`、
>    插件名 KuroBridge、Java 包 `com.kurobridge`、JAR `kurobridge-0.1.0.jar`。
> ③ WS 子协议 **`kurobot-ws.v1` → `kurobridge-ws.v1`**，协议 0.3.1 → **0.4.0**（breaking：
>    握手协商字符串变更；`.v1` 大版本不变，**帧形状零变化**）。
> ④ **含两仓联动**：本册为主册（KuroAdapter 仓执行）；§7 联动册（NapukettoQQ 仓）单独拿到
>    对方会话执行——仍遵守「单会话只写一仓」纪律。

---

## 0. 边界与纪律（先读，违反即任务失败）

- **工作区**：`C:\Dev\MC-Ecosystem\KuroAdapter`。所有文件的创建/修改**只允许发生在此目录内**。
- **允许只读查阅** `C:\Dev\Bot-Dev\NapukettoQQ`（核对联动册步骤的准确性：`apps/cli/src/config-parse.ts`、
  `packages/loader/src/host/core/assemble-protocols.ts`、`packages/adapter/src/kurobot/`），
  **禁止修改该仓任何文件**。napuketto 侧的外部契约**原样不动**（见 1.2 第 6 条）。
- **无人值守规则：禁止向用户提问。** 所有决策自行拍板，全部记入 `docs/RENAME-NOTES.md`
  （新建，决策编号 R-01 起；R-00 = 用户四拍板，开册即录）。只有不停止就无法继续的硬阻塞
  才允许结束任务，NOTES 写明阻塞点。
- **Git**：master 小步提交（简体中文说明，每阶段至少一个提交）；不 push、不改写历史。
  pre-commit（lefthook：`pnpm check` + `pnpm test`）被拒就修到绿再提交。
- **GPG 注意**：commit 若约 2 分钟无输出疑似口令缓存挂起——**禁止 `--no-gpg-sign`**；结束任务
  并在 NOTES 写明已暂存变更清单，交用户交互提交。
- **历史文档不改写**（本册特有红线）：`docs/DECISIONS.md` 既有 ADR、各 `*-PROMPT.md`、
  各 `*-NOTES.md` 为历史实录，**正文一律不改**（新旧名混读以 ADR-030 映射表为准）。
  活文档**全量替换**：`AGENTS.md`（本册例外于「不改 AGENTS.md」惯例，标题与正文必须更新）、
  `readme.md`、`docs/architecture.md`、`docs/config-schema.md`、`docs/STATUS.md`（追加结论）、
  `docs/protocol/draft-v0.1.md`、`docs/protocol/peer-guide.md`、各包 `docs/design.md`。
- **新决策追加新 ADR**：**ADR-030**（改名决策 + 新旧标识映射表 + 迁移策略）。动笔前先读
  `docs/DECISIONS.md` 末尾确认最大号（当前已知 ADR-029）。
- **一切构建/测试命令统一经 `mise exec -- <cmd>`**（mise 提供 node 26.7.0 / java 25.0.2 /
  gradle 9.7.0；PATH 直连版本不对）。
- **卡住规则**：任一阶段超过约 30 分钟无实质进展 → 降级目标并记 NOTES，继续推进不原地打转。

## 1. 目标与范围

「KuroBot」名号淘汰：GitHub 组织 **Kuro-Bridge**，主仓 **KuroAdapter**（remote 已迁）。
本册把仓内全部品牌标识一次改净——此刻无存量部署、napuketto 端未发布，是零迁移成本的
唯一窗口。改完后的状态：代码/活文档零 `kurobot` 残留（历史册与 napuketto 外部契约除外），
协议 0.4.0（kurobridge-ws.v1），全链构建绿，沙盒 stub 链路冒烟通过。

### 1.1 必须守住的红线（同 AGENTS.md，违反即任务失败）

1. 消息类型一律 `import { ... } from "@kuro-bridge/protocol"`（改名后），协议 SSOT 仍是
   `bridge/protocol` 的 zod schema。**帧 schema 形状零变化**——只动 PROTOCOL_NAME /
   WS_SUBPROTOCOL 品牌字符串与 PROTOCOL_VERSION 0.3.1→0.4.0（`meta.ts`）。
2. `bridge/core` 平台无关（零 Node API）；Java 薄壳不做业务；IPC 只走 stdin/stdout
   JSON-lines；本服务端永远是 WS 服务端角色。
3. **napuketto 外部契约不动**（它是独立产品）：env `NAPKETTO_CONFIG` / `NAPKETTO_DATA` /
   `NAPUTO_QQ_PATH`、文件名 `napuketto.toml`、TOML 段名 `[accounts.kurobot]`、对端自报
   `client = "napukettoqq/..."`、`@napuketto/*` 包名与 pin 值（仍 0.1.17，版本变化归联动册）。
4. workspace 跨包解析走 dist 产物：改名涉及 workspace 包名链接，**先 `pnpm install` 重链，
   再 `pnpm -r build`，然后才 `pnpm check` / `pnpm test`**。
5. 红线 grep 基线不变：wrapper.node / QQ 安装包 / QQNT 腾讯二进制零命中（嵌包内容原样，
   本册不碰 scripts/embed.ts 的收集逻辑，只改其品牌字符串与 env 名）。

### 1.2 已拍板决策（按此实现；更优方案须 NOTES 论证后仍自行拍板）

1. **npm scope**：`@kurobot/protocol|bridge-core|bridge-embedded` →
   `@kuro-bridge/protocol|bridge-core|bridge-embedded`（各 package.json name + 全部 import +
   tsconfig/测试引用 + 文档）；根 `package.json` name `kurobot` → `kurobridge`（private）。
   **版本策略**：protocol 0.0.0（workspace 占位）保持机制不动，发布版本以 `meta.ts` 的
   PROTOCOL_VERSION 为 SSOT（沿用现状），0.4.0 待发布（协作清单）；其余包版本不动。
2. **用户标识 kurobridge**：`rootProject.name = "kurobridge"`；Java 包目录
   `com/kurobot → com/kurobridge`；类名 `KuroBotPlugin → KuroBridgePlugin`、
   `KurobotCommand → KurobridgeCommand`（其余类名不含品牌，仅包路径变）；
   paper-plugin.yml `name: KuroBridge` + `main: com.kurobridge.KuroBridgePlugin` +
   权限 `kurobridge.admin` / `kurobridge.relay`；命令注册与用法文案 `/kurobot → /kurobridge`；
   JAR 产物 `kurobridge-0.1.0.jar`，`paper-start.sh` 拷贝为 `plugins/kurobridge.jar`。
3. **数据目录/路径**：`plugins/kurobot/` → `plugins/kurobridge/` 全部出现点（embedded 默认
   configPath/dataDir、Java EmbeddedRuntime/qr.json/node.pid 路径、哨兵文件
   `.kurobot-install.json → .kurobridge-install.json`、paper-qr.ps1 的 qr.png 路径）。
   **迁移策略：不做自动迁移**（无存量部署）；sandbox/ 整体在 gitignore 内，本地把
   `sandbox/server/plugins/kurobot/` 改名为 `plugins/kurobridge/`（config.json 与
   napuketto.toml 内容平移，注意 napuketto-data 数据目录随目录改名后凭据/锁仍有效，
   instance.lock 按 pid+cmdline 自愈）。旧目录直接删除。
4. **env 前缀**：`KUROBOT_* → KUROBRIDGE_*` 全部（`KUROBRIDGE_STUB_PEER` / `KUROBRIDGE_NODE` /
   `KUROBRIDGE_BUNDLE` / `KUROBRIDGE_NPM_REGISTRY` / `KUROBRIDGE_NODE_DIST_STRICT` /
   `KUROBRIDGE_NODE_DIST_BASE` / `KUROBRIDGE_NK_TEST_PASS`）——同步所有脚本（.sh/.ps1/.cmd/
   embed.ts）与文档中的注入示例。
5. **线协议**：`PROTOCOL_NAME = "kurobridge-ws"`、`WS_SUBPROTOCOL = "kurobridge-ws.v1"`
   （`.v1` 不变——大版本语义保持，握手拒绝逻辑不变）；`PROTOCOL_VERSION = "0.4.0"`。
   不做双名字兼容（无存量对端）；stub/peer.mjs 与 ws-server 测试同步。
6. **golden 锁口径**：帧形状零变化，帧 fixture 若含品牌字符串则同步；与 napuketto 镜像的
   重对齐（其升级到 @kuro-bridge/protocol 0.4.0 后重锁）归联动册，本册在 NOTES 记录口径。

### 1.3 明确不做（防跑偏清单，出现即算偏航）

- 不改写历史文档（0 节清单）；不动 git 历史；不 push。
- 不发布 npm、不创建 npm org（用户协作清单，见 §4）。
- 不动 napuketto 外部契约（1.1 第 3 条）；不修改 NapukettoQQ 仓任何文件。
- 不做新旧名双识别/兼容层/自动迁移（无存量，one-name-only）。
- 不碰协议帧 schema 形状与 IPC 帧格式；不重写 ADR/NOTES 历史正文。

## 2. 动手前必读（顺序执行）

1. `AGENTS.md` → `docs/STATUS.md` → 本册全文 → `docs/DECISIONS.md` 末尾（确认 ADR-030 编号）。
2. `docs/MVP4-NOTES.md` §7（工作树现存 M4-11/12 增量的上下文——阶段 0 要先提交它们）。
3. `git status` 核对工作树：应只有 MVP4-NOTES §7 所列改动（napuketto.ts/test、KurobotCommand.java、
   scripts/paper-*.cmd|ps1 新增、embedded design、MVP4-NOTES）。多了就先弄清来源再动手。

## 3. 实现顺序（每阶段至少一个提交，全部简体中文提交说明）

- **阶段 0（前置隔离）**：把工作树现存 M4-11/12 增量**用改名前的旧名原样单独提交**（提交说明：
  `feat: 终验期 UX 增量 —— 捕获流折叠 ASCII 二维码 / kurobot qr 年龄提示 / 沙盒 PowerShell 一键脚本（M4-11/12）`）。
  目的：改名提交链从干净树开始，diff 纯粹。
- **阶段 1（设计先行）**：ADR-030 入库（DECISIONS.md 追加）：动机（组织迁移）、四拍板、
  **新旧标识映射表**（本文 1.2 的表）、迁移策略、napuketto 外部契约不动清单、协议 0.4.0
  breaking 说明。RENAME-NOTES.md 建册录 R-00。
- **阶段 2（协议层）**：bridge/protocol（meta.ts 常量 + package.json name/scope + 各文件头注）、
  core/embedded 的依赖名与 import、**`pnpm install` 重链 workspace** → `pnpm -r build` →
  门禁绿。stub/peer.mjs 同步（含 `KUROBRIDGE_STUB_*`）。
- **阶段 3（TS 全量 + 脚本）**：默认路径 `plugins/kurobridge`、哨兵文件名、env 前缀、
  scripts/embed.ts|embed.test.ts、paper-*.sh|.ps1|.cmd（**.cmd 保持纯 ASCII、.ps1 保持 UTF-8 BOM**，
  改名不得破坏既有编码约定）、全部测试引用。`pnpm check` / `pnpm test` / `pnpm -r build` 全绿。
- **阶段 4（Java 侧）**：settings.gradle.kts、包目录与类名、paper-plugin.yml、命令注册、
  路径常量；`gradlew spotlessApply build` 全绿（含 :core:test --rerun）。
- **阶段 5（活文档全量替换）**：AGENTS.md / readme.md / architecture.md / config-schema.md /
  protocol 两篇 / 各包 design.md——替换品牌名与新标识，历史册不动；文档内出现「旧名」仅允许
  两处：ADR-030 映射表、以及「曾用名」说明句。
- **阶段 6（沙盒重建 + 打包冒烟）**：`sandbox/server/plugins/kurobot` → `kurobridge` 目录平移
  （napuketto.toml 的 `[accounts.kurobot]` 段名**保持原样**——napuketto 契约）；`pnpm build:jar`
  产出 `kurobridge-0.1.0.jar`（嵌包内容与体积应与 48.5MB 基线一致）；paper-start 冒烟：
  **关闭 embedded 段走 stub 链**（napuketto 端尚不认 kurobridge-ws，真链路互通归协作清单）→
  握手成功 + `/kurobridge` 命令可用 + paper-stop 无孤儿。红线的嵌包清单 grep 复验（§3.5 of MVP4-NOTES 基线）。
- **阶段 7（收尾）**：RENAME-NOTES 决策补全 + STATUS.md 追加「改名阶段结论」+ 验收表 + §4 协作清单。

## 4. 验收清单（无人值守部分全部打勾 + 协作清单写好 = 任务完成）

| # | 验收项 | 要求 |
|---|---|---|
| 1 | 门禁 | `pnpm check` / `pnpm test` / `pnpm -r build`；`gradlew build` + `:core:test --rerun` 全绿 |
| 2 | 残留 grep | 活文档与代码 `grep -ri kurobot`（排除 `docs/DECISIONS.md`、各 `*-PROMPT.md`、`*-NOTES.md`、`napuketto*` 契约词、node_modules/dist）应为 **0 命中**；ADR-030 映射表除外 |
| 3 | 协议 | meta.ts：`kurobridge-ws` / `kurobridge-ws.v1` / `0.4.0`；帧 schema 与 0.3.1 逐字段一致（golden fixture 对比，仅品牌字符串差异） |
| 4 | 打包 | `pnpm build:jar` 产出 `kurobridge-0.1.0.jar`；嵌包清单/体积与 MVP-4 基线一致（napuketto.zip 7.6MB 原样）；红线 grep 零命中 |
| 5 | 沙盒冒烟 | stub 链握手成功（KUROBRIDGE_STUB_PEER 注入）；`/kurobridge` 命令三子命令可用；stop 无孤儿 |
| 6 | 历史 | 历史册正文零改动（`git diff` 核对）；ADR-030 含映射表 |
| 7 | 协作清单（写入 RENAME-NOTES） | ①用户在 npm 创建 org `kuro-bridge` 并发布 `@kuro-bridge/protocol@0.4.0`（如需可 `npm deprecate @kurobot/protocol` 指新包）；②执行 §7 联动册（NapukettoQQ 会话）；③联动完成后回本仓：真链路互通复验（握手 client=napukettoqq/x + 群消息双向）+ 发现 H 关闭 + 终验收尾 |

## 5. subagent 使用策略

机械替换（阶段 3/5 的批量改名）可派 subagent 执行，但**主侧必须逐文件复核 diff + 亲自跑门禁**；
Java 包目录移动、协议常量、golden fixture 属高风险点，主侧亲手改。

## 6. Windows / Git Bash 注意事项（实测踩坑，勿重趟）

- 一律 `mise exec -- <cmd>`；`bash scripts/*.sh` 仅 Git Bash（PowerShell 裸 `bash` = WSL）。
- `.cmd` 脚本纯 ASCII（cmd.exe 按 GBK 解析）；`.ps1` 必须 UTF-8 **带 BOM**（PS 5.1 把无 BOM
  当 ANSI）。改名时保持这两个约定。
- `gradlew` 输出重定向到文件，勿走管道（后台子进程继承 stdout 会卡死调用）。
- spotless 对 Java 改名后的格式可能报违规：`gradlew spotlessApply` 后再 build。
- biome 对批量替换后的行宽可能报格式错：`pnpm fix` 后再 check。
- 大规模 import 改名后若类型解析失败：先 `pnpm install`（workspace 链接按包名建立）再 build。

## 7. 联动册：NapukettoQQ 仓（整段拷贝到对方仓会话执行；本仓会话不执行本节）

> 前置：本册已合入 master；用户已发布 `@kuro-bridge/protocol@0.4.0`。
> 工作区：`C:\Dev\Bot-Dev\NapukettoQQ`；KuroAdapter 仓只读。

1. 依赖切换：`@napuketto/adapter`（及 kernel 等若引用）的 `@kurobot/protocol` →
   `@kuro-bridge/protocol@0.4.0`。
2. 子协议字符串：客户端握手 `kurobot-ws.v1` → `kurobridge-ws.v1`（全仓 grep 确认无遗漏）。
3. 镜像重对齐：`packages/adapter/src/kurobot/schema.ts` 按 0.4.0 SSOT 重新生成/校验，
   golden-frame 测试重锁（帧形状应零差异，仅版本号与品牌字符串）。
4. 品牌命名（该仓自决，建议跟随）：目录 `packages/adapter/src/kurobot/ → kurobridge/`、
   TOML 段 `[accounts.kurobot] → [accounts.kurobridge]`、`client` 自报串**保持
   `napukettoqq/x` 不变**（napuketto 自己的身份标识）。若改 TOML 段名 → 回 KuroAdapter 仓
   小提交同步 `sandbox/server/plugins/kurobridge/napuketto.toml` 与文档。
5. 版本 bump + 构建 + 测试 + 发布（publish 需用户凭据时转协作清单）。
6. 联动验收：KuroAdapter 沙盒（embedded 形态）真链路——napuketto 连入 `kurobridge-ws.v1`、
   hello 自报、群消息双向；通过后双仓各自 NOTES 关闭发现 H / 终验条目。
