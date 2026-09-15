# 改名实录（RENAME-NOTES）——KuroBot → KuroBridge / @kuro-bridge

> 任务书 `docs/RENAME-PROMPT.md`（唯一指令来源）；映射表与 breaking 说明见 **ADR-030**。
> 决策编号 R-01 起（R-00 = 用户四拍板）。历史册（DECISIONS.md 既有 ADR、各 *-PROMPT.md、
> 各 *-NOTES.md）正文一律不改写。

## R-00 用户四拍板（2026-09-14 开题对齐，任务书原文）

1. npm scope `@kurobot/*` → **`@kuro-bridge/*`**（与 GitHub 组织 Kuro-Bridge 一致）。
2. 面向用户标识统一 **`kurobridge`**：MC 命令 `/kurobridge`、数据目录 `plugins/kurobridge/`、
   插件名 KuroBridge、Java 包 `com.kurobridge`、JAR `kurobridge-0.1.0.jar`。
3. WS 子协议 **`kurobot-ws.v1` → `kurobridge-ws.v1`**，协议 0.3.1 → **0.4.0**（breaking：
   握手协商字符串变更；`.v1` 大版本不变，帧形状零变化）。
4. **含两仓联动**：本册为主册（KuroAdapter 仓执行）；§7 联动册（NapukettoQQ 仓）单独拿到
   对方会话执行。

## 决策（执行者拍板）

- **R-01 映射表之外的连带改名**（与任务书 1.2 同一品牌符号族，为达成「零 kurobot 残留」目标）：
  任务书称「其余类名不含品牌」与实际不符——`:core` 的 `KurobotVersions`（协议版本展示副本）
  含品牌，随拍板改为 `KurobridgeVersions`；同理 `KurobotConfig`/`KurobotServer`（core TS 符号）、
  `[KuroBot]` 日志前缀、`SERVER_ID "kurobot-spike"`、测试 tmpdir 前缀、embed 暂存包名
  `kurobot-napuketto-bundle`、lse/endstone 包名与 CMake 工程名、`.github/agents/kurobot.agent.md`
  文件名（→ `kurobridge.agent.md`）、`koishi-plugin-kurobot`（ADR-018 预留的未来仓库名，尚未建仓，
  非 napuketto 契约）→ `koishi-plugin-kurobridge`、沙盒令牌示例值
  `kurobot-sandbox-token → kurobridge-sandbox-token`（config.json 与 napuketto.toml 两侧同步改，
  令牌值是两侧共享秘密而非 napuketto 契约）。
- **R-02 阶段边界微调**：阶段 3 批量替换按文件类型覆盖了 bridge 三包 + be 两包的
  `docs/design.md`（属阶段 5 清单子集，提前完成）；阶段 5 处理其余 8 个活文档。每阶段门禁
  独立跑绿，提交链 diff 不受影响。
- **R-03 napuketto 契约字样保护清单（本仓内合法残留）**：
  `bridge/embedded/src/napuketto.test.ts` 的日志 fixture `"…(kernel/1): kurobot adapter started"`
  （napuketto 侧内核日志原文，联动册 §7 改名后随镜像重锁）；`docs/config-schema.md` 的
  `[accounts.kurobot]` 段名三处（napuketto TOML 契约）；`bridge/protocol/src/meta.ts` v0.4.0
  版本史注释中的「kurobot-ws → kurobridge-ws」（曾用名说明句）。验收 grep 口径三者全豁免。
- **R-04 冒烟鉴权路径**：沙盒 config.json 保留 embedded 时代设的非空 token（不回退为空），
  stub 冒烟经 `KUROBRIDGE_STUB_TOKEN` 注入对齐——顺带实证 token 鉴权双向：未带 token 的首轮
  握手被 1008 auth failed 拒绝并按 1s 退避重连（旧名沙盒切换后的预期行为），注入正确 token
  后握手成功。比 MVP-3 的空 token 冒烟覆盖更全。
- **R-05 golden 锁口径（任务书 1.2.6）**：本仓帧 fixture 无 golden 文件（测试内联构造帧），
  帧形状零变化由 171 个 vitest 用例零逻辑改动背书（仅品牌字符串断言与常量更新）；
  与 napuketto 镜像的重对齐归联动册（其升级 `@kuro-bridge/protocol@0.4.0` 后重锁）。
- **R-06 环境备注**：`mise exec` 提供的 node 为 26.7.0；pnpm/corepack 进程自身报
  v24.16.0（engine WARN），与改名前各阶段完全一致，非本册引入；门禁/构建/沙盒均在此环境跑绿。
  gradlew 输出重定向文件执行（任务书 §6）；`.cmd` 纯 ASCII、`.ps1` UTF-8 BOM 经字节复核未破坏。

## 提交链

d9028de（阶段 0：M4-11/12 旧名隔离提交）→ ebdc1e6（阶段 1：ADR-030 + 本册建册）→
264bae5（阶段 2：协议层 + workspace 重链）→ c1262ec（阶段 3：TS 全量 + 脚本）→
460a717（阶段 4：Java 侧）→ 4a29d33（阶段 5：活文档）→ 本册收尾提交（阶段 6/7 实录回填）。

## 验收实录（任务书 §4 对照）

| # | 验收项 | 结果 |
|---|---|---|
| 1 | 门禁 | ✅ `pnpm check`（biome+tsc）/ `pnpm test`（171 用例）/ `pnpm -r build` 全绿（阶段 2~5 每阶段跑，pre-commit 逐提交复跑）；`gradlew spotlessApply build :core:test --rerun` 绿（阶段 4，日志 exit=0） |
| 2 | 残留 grep | ✅ 全仓 `grep -ri kurobot`（排除 node_modules/dist/sandbox/build 与历史册）仅 3 处 = R-03 契约豁免清单（napuketto 日志 fixture / [accounts.kurobot] 段名 / meta.ts 曾用名句），除此之外 0 命中 |
| 3 | 协议 | ✅ meta.ts：`PROTOCOL_NAME "kurobridge-ws"` / `WS_SUBPROTOCOL "kurobridge-ws.v1"` / `PROTOCOL_VERSION "0.4.0"`；帧 schema 零变化（R-05 口径：171 用例零逻辑改动；Java 侧 `KurobridgeVersions` 副本同步 0.4.0） |
| 4 | 打包 | ✅ `pnpm build:jar` 产出 `kurobridge-0.1.0.jar`（48,468,050 B，对照旧名 JAR 48,467,667 B，差 383 B = 品牌字符串/清单/类名；napuketto.zip sha256 `fb18fc76…` 与 MVP-4 基线逐字节一致 = 嵌包内容零变化）；红线 grep 零命中（zip 内仅基线内 `7z.dll` + napuketto 自研 stub `QQNT.dll`，无 wrapper.node/QQ 安装包/QQNT 腾讯二进制） |
| 5 | 沙盒冒烟 | ✅ stub 链（`KUROBRIDGE_STUB_PEER` 注入 + `KUROBRIDGE_STUB_TOKEN`，R-04）：`kurobridge-ws.v1` 子协议协商 → hello 握手成功（serverId=kurobridge-spike / 协议 0.4.0）→ 就绪行「插件 v0.1.0 / node v26.7.0 / 协议 v0.4.0」→ stub 消息进游戏；`/kurobridge send`（已发送 + stub 收到游戏聊天）/ `reload`（已通知重载 + config_reload 链路）/ `qr`（优雅报未启用）三子命令可用；stop 优雅关停，node.exe 零残留、java 进程退出 |
| 6 | 历史 | ✅ `git diff d9028de..HEAD -- 历史册` 仅 DECISIONS.md 追加 ADR-030（+44 行 append-only），各 PROMPT/NOTES 零改动；ADR-030 含完整新旧标识映射表 |
| 7 | 协作清单 | ✅ 见下节 |

## 用户协作清单（无人值守不可达项，按序执行）

1. **npm 发布**：在 npm 创建 org `kuro-bridge`，发布 `@kuro-bridge/protocol@0.4.0`
   （workspace 版本机制不动，对外版本以 meta.ts 为 SSOT；如需可在旧包上
   `npm deprecate @kurobot/protocol` 指向新包）。
2. **执行联动册**：整段拷贝 `docs/RENAME-PROMPT.md` §7 到 NapukettoQQ 仓会话执行
   （依赖切换 / 子协议字符串 / 镜像重对齐 / 品牌命名自决 / 发布）。
3. **联动回本仓收尾**：真链路互通复验（napuketto 连入 `kurobridge-ws.v1`，hello 自报
   `client=napukettoqq/x`，群消息双向）→ 关闭发现 H（napuketto 端 kurobot 支持未发布）
   → 终验收尾（MVP4-NOTES §6 协作清单 + 本册关闭）。沙盒已就位：
   `sandbox/server/plugins/kurobridge/`（napuketto-data 凭据已平移保留，预期 quick-login
   免扫码；`[accounts.kurobot]` 段名与 token 已对齐 config.json）。
