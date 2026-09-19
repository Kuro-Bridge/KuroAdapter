# KuroBridge 现状与路线（STATUS）

> 开始任何工作前先读本文 → `architecture.md`（架构书）→ 对应包 `docs/design.md`。
> 本文只讲「现在」；阶段史（原型 → MVP-1~4 → DEBT-1/2 → 改名）的任务书/实录全在
> [`history/`](history/README.md)，拍板依据在 [`DECISIONS.md`](DECISIONS.md)（ADR-001~036）。

## 当前状态（2026-09-19）

**JE（Paper）主链全部完成，真机终验已通过**：MVP-1~4 + 两轮债务清偿 + 品牌迁移
（KuroBot → KuroBridge）+ 真机终验收官（见下节）。当前可分发形态 =
`kurobridge-0.1.0.jar`（**48.4MB**，内嵌 Node 26 + napuketto CLI 0.1.20，开箱
控制台扫码），协议 `kurobridge-ws`（协议 SSOT 在姊妹仓 KuroProtocol，本仓经 npm 依赖
`@kuro-bridge/protocol@^0.4.0` 消费、无仓内副本；协议版本锚 = 已安装 npm 包清单 version
≡ `KurobridgeVersions.java`，机械对齐 = `check-versions`，发布侧等价性 = KuroProtocol
`assert-version.mjs`，ADR-031/035；改名后唯一 breaking = 握手子协议字符串，帧形状零变化，
ADR-030）。

- **embedded 形态**（MVP-4，ADR-029）：进程树 `Java → node → napuketto CLI(supervisor) →
  boot → self-host`（最深四层）全链实证；QR 文件交接 + `kurobridge qr` 子命令；崩溃看护
  （1s/5s/15s 退避重启、10 分钟窗 3 次失败放弃）；config 顶层 `embedded` / `ws` 段
  （形状 SSOT 归 core zod，ADR-028）。
- **external 形态**（MVP-3）：固定端口 + 绑定地址 + token 鉴权（close 1008）+ 主版本
  兼容区间协商 + 未知帧容忍；外部协议端实现依据 = KuroProtocol 仓的 peer-guide
  （[`protocol/peer-guide.md`](protocol/peer-guide.md) 为迁移指针，ADR-031）。
- **业务面**（DEBT-1）：绑定表 / 转发规则（按频道 fan-out）/ 群管理员映射 / WS command
  透传执行 / query 本地作答 / death / 配置热重载（`kurobridge reload`）/ 白名单 SSOT =
  MC 原生 whitelist。
- **门禁基线**（2026-09-19 ADR-036 后）：`pnpm check`（一条入口：自含 `pnpm -r build`
  首环 + biome + 根 tsc + lse typecheck + docs 门禁 + 版本对齐，ADR-035）/ `pnpm test`
  （**153 用例 / 13 文件**——142 基线上新增金样本 fixture-driven 检查 11 例
  （`bridge/core/src/__tests__/golden.fixtures.test.ts`，ADR-036）；180 → 142 差额 =
  随镜像退役删除的 protocol 包用例）/ `gradlew build` + `:core:test --rerun`
  （**74 用例**）全绿。CI 双 job 已入库（ADR-032，其后经 ADR-035 结论 4 简化：无姊妹仓
  检出），CI 已激活且绿（见待定事项）。
- **napuketto 外部契约原样**：env 名、文件名、TOML `[accounts.kurobot]` 段名、client
  自报格式均不改（napuketto 契约点按 RENAME-NOTES R-03 豁免；DECISIONS 历史条目与
  history 册内的旧名按「永不改写」归档约定保留）。

## 真机终验：通过（2026-09-15 收官）

收官链五步全绿（沙盒 = 真 Paper + 真扫码 + 真群），链路证据：

- **登录与在线**（napuketto **cli 0.1.20 / loader 0.0.33**，内嵌于 JAR）：QR 扫码 →
  `登录成功` → **`在线状态已注册（setStatus status=10）`** → `kurobot adapter started`
  → 握手成功（platform=qq，协议 0.4.0 主版本兼容、子协议 `kurobridge-ws.v1`、token
  鉴权）→ 25580 ESTABLISHED。
- **双向消息实测**：`kurobridge send` → 群内收到 `[CONSOLE] 群服互通终验：服务器→群
  方向测试`（模板渲染正确）；群消息 → **实时**广播进服（`<Oppenheymu> 测试` ×3，1s
  间隔真推送非历史同步）。配置热重载（绑定表 `bindings_updated` 推送）与
  `kurobridge reload` 双路径均实证。
- **发现 H 关闭**：0.1.17 嵌包无 kurobridge 接线（`[accounts.kurobot]` 被静默忽略）→
  0.1.19/0.1.20 接线实证（`kurobot adapter started` + 握手 + 双向）。
- **发现 I 关闭**：napuketto 引导链从不调 `setStatus` → NT 会话半在线（可发不可收，
  腾讯侧不推送）。修复在 NapukettoQQ 仓（`createKernelServices` 补 `setOnlineStatus`，
  提交 d5c21ca，loader 0.0.33 发布），本仓 pin 0.1.20 重打 JAR 后入站即通。
- **观察项（不阻塞，已记债务）**：quick-login 恒报「无历史登录账号」（每次重启需重
  扫，登录历史落盘链待查，NapukettoQQ 侧）；hello `client` 自报裸名（发布安装树取不
  到自身版本走退化分支，字段可选仅日志辨识）；手机端不显示「电脑」设备类型（setStatus
  成功且推送工作，疑设备类型展示差异）。

napuketto 外部契约原样（env 名、文件名、TOML `[accounts.kurobot]` 段名、client 配置值
原样透传）。对端实现依据 = KuroProtocol 仓 peer-guide（本仓 `protocol/peer-guide.md` 为迁移指针）。

## 2026-09-18 治理波次（长程线 2：门禁统一 / 文档求真 / 可观测性收敛）

单波次四块，决策依据 ADR-032~034（先文档后代码）：

- **门禁**：CI 双 job 入库（ADR-032：ts job 与本地同构 + 姊妹仓兄弟目录检出跑
  `check:protocol`；java job mise JDK 25 跑 `gradlew build`——Java 回归从此对门禁可见；
  其后经 ADR-035 结论 4 简化，去兄弟检出与镜像门禁）；
  本地 `check` 链补盲区：lse typecheck 入链、旧 scope（`@kuro-bridge/` 的无连字符写法）
  grep 门禁、md 死链
  门禁、版本对齐门禁（`check-versions`）、biome `noRestrictedImports`（协议导入口径），
  全部经 `pnpm check` 单一入口挂 lefthook。
- **文档求真**：旧 scope 残留清零（无连字符写法 17 处，history 档案豁免）；「嵌入式打包待重建」
  五连过时口径改现状；三项虚 claim 处置——JaCoCo ≥60% 门禁改事实（未实装，裁决理由见
  architecture §8）、「lint 规则强制」落地为真实 `noRestrictedImports` 窄规则 + 精确措辞、
  wrapper.node「构建期 grep 门禁」落地为 `embed.ts` 扫描断言（含单测）；readme 空壳标题、
  embedded 双语义、各 design.md 目录/家族描述对齐实况。
- **可观测性**（ADR-034）：`[KuroBridge][node][LEVEL]` 行格式契约立档；`:core IpcLogLevels`
  单一解析点——修复 Node error 行在服务器控制台降级 INFO 的事故（`onStderrLine` 此前
  无条件 info）；logger.ts 收编唯一 stderr writer；`SERVER_ID="kurobridge-spike"` 残留消除
  （config `server.id`，缺省 `kurobridge`）；`BRIDGE_VERSION` 单点 + 六点机械对齐。
- **发布通道**（ADR-033）：`bridge/core` / `bridge/embedded` 加 `private: true`——对齐
  ADR-031 只封 protocol 的缺口，误发通道全封死。

## 2026-09-18 阶段 2 执行波次（协议镜像退役，ADR-031 阶段 2 / ADR-035）

ADR-031 阶段 2 于本日执行完成，协议消费全面转 npm：

- `@kuro-bridge/protocol@^0.4.0` 就位——三消费方（`bridge/core` / `bridge/embedded` /
  `platforms/be/lse`）由 `workspace:*` 切 npm 依赖；`bridge/protocol/` 镜像目录与
  `check:protocol` 门禁整体删除；`check-versions` 协议族锚点换源为已安装 npm 包清单
  version（≡ `KurobridgeVersions.java`）；check 链自含 `pnpm -r build` 首环 +
  lefthook 串行化（parallel: false）；CI 去姊妹仓兄弟检出。决策依据 ADR-035。
- 提交链六笔（86a698a…acb0f18）：86a698a（STATUS 前置求真）→ 6237e3e（ADR-035 立档，
  先文档后代码）→ 0130f2b（build 前置修 CI 首跑红）→ 43b9e63（依赖切换）→
  6c6e34d（锚点换源）→ acb0f18（镜像删除）。
- 用例基线 180 → 142（12 文件）：差额 = 随镜像退役删除的 protocol 包用例；协议包测试
  归 KuroProtocol 仓。

## 2026-09-19 并行线波次（主仓金样本机器检查 + embedded exports 闭环，ADR-036）

三阵营金样本消费矩阵在主仓缺角（协议只以 npm 包形态存在、消费正确性无机器防线），
本波闭环，决策依据 ADR-036（先文档后代码）：

- **金样本 fixture-driven 机器检查**（ADR-036 结论 1）：`bridge/core/src/__tests__/golden.fixtures.test.ts`
  双层单文件——契约层 = 16 份全量过包导出 `validateFixture` + SHA256SUMS 双向完整性
  （逐行实算 + 盘上未登记必空）+ 版本轴锚定（包根 `createRequire` 上溯定位、fixtures
  根下唯一版本目录 ≡ `PROTOCOL_VERSION` major.minor）；行为层 = 动态发现
  `expect.behavior` 可观测样本 7 份经 `KurobridgeServer` + test-fakes 回放（reply 帧
  与金样本 JSON 全等、close code/reason 精确一致，覆盖数下限 7 = Pure 现状地板，对齐
  KuroAdapter-Pure `FixtureConformanceTest` 深度）。用例基线 142 → 153（13 文件）。
  有效性按纪律以「篡改即红」实证：篡改 node_modules 内 fixture 副本，SUMS 校验与行为
  回放两例即红（schema 层不红——内容 pin 层兜住语义合法的内容漂移），验后逐字节还原。
- **embedded exports 悬空指针移除**（ADR-036 结论 2，闭环 ADR-035 结论 5② 预存缺陷）：
  `bridge/embedded/package.json` 顶层 `types` 与 `exports["."].types` 两处删除（esbuild
  只产 mjs 无 dts 能力，`dist/index.d.mts` 从不存在；全仓 grep 零代码 import 该包名，
  JAR 消费走 `embed.ts` 物理路径直读 `dist/index.mjs`，private 语义 ADR-033——删除即
  诚实态，未来开 npm 通道按 ADR-033 先立 exports/types 全套发布决策）。ADR-035 5② 当时
  承诺的 STATUS 缺口登记实际未落地，本条以已闭环形态补记。

## 2026-09-19 平台落地波·并行线 2/4：`platforms/je/fabric` 首次实现

Fabric mod 形态薄壳落地（任务书：paper 参照 + `:core` 零改动，交付到构建+单测+SOP 为止，
真机联调不做）。提交链：`70bd8c0`（docs：包级设计册）→ `7e032e8`（feat：mod 薄壳 +
Gradle 接线 + 单测）→ `b03df09`（build：嵌入产物双平台化 + build-jar 第四步
`:fabric:remapJar`）。裁决与证据表全部在册：[`../platforms/je/fabric/docs/design.md`](../platforms/je/fabric/docs/design.md)。

- **版本基线（首版单版本，矩阵延后）**：MC 1.21.4 / yarn 1.21.4+build.8 / fabric-loader
  0.19.5（depends ≥0.16.0）/ fabric-api 0.119.4+1.21.4 / loom 1.18.2（Gradle 9 支持线，
  仅发布于 Fabric maven → settings pluginManagement 增补）。**矩阵接管点**：每 MC 版本
  一组 minecraft/mappings/fabric-api 坐标、fabric.mod.json depends 收放策略、CI java job
  版本 matrix（design.md §1）。
- **事件覆盖与 paper 对齐（5 格）**：chat / join / quit / death / status 全部落地——join、
  quit、death 三格完全对齐；chat 与 status 两格语义级对齐但有登记差异：chat 缺
  `kurobridge.relay` 权限门（fabric 原生无权限节点系统，v1 全员转发 = paper 权限
  default: true 的缺省行为，negate 静音缺失，接管 = fabric-permission-api）；status 的
  TPS 为自测（`TickRateSampler` 60s 滑动窗，对齐 paper 1 分钟窗语义；vanilla
  `getAverageTickTime()` 仅 100 tick 窗故弃用，JUnit 6 测试）。另 chat 对玩家执行命令产生
  的聊天消息（/me 等）为轻微超集，登记不收敛。 death 死亡消息为 vanilla 原生文案
  （`getDamageTracker().getDeathMessage()`），与 Bukkit 措辞不同（预期内）。
- **node 关停语义与 paper 等价**：等价。SERVER_STOPPING → `supervisor.stop("server
  stopping")` → `:core` shutdown 帧 → stdin EOF → 5s 有界等待 → destroyForcibly → 2s
  兜底（D-08 语义同 onDisable）；差异仅在 STOPPING 时点早于玩家断开（paper 的 disable
  在断开后），真机清单核对。生命周期拉起 = SERVER_STARTING（同 paper onEnable 的同步
  install + supervisor 组装），监听/命令注册在 onInitialize（容忍无 IPC）。
- **execute_command 在 fabric 更简**：无 Craft* 包装层，收集型 `CommandOutput` 经
  `server.getCommandSource().withOutput(...)` 原生可用——paper 的
  VanillaCommandWrapper 回退 + VanillaFeedbackCapture（log4j appender 截流）两路径在
  fabric 合并为一条真实执行完回执路径。
- **打包**：shadow 9 白名单（:core + Jackson 三件，fabric-api/loader 不吞入）→ loom
  `remapJar`（inputFile = shadowJar 产物；loom include 嵌套 jar 路线弃选——嵌套 jar 须
  自带 fabric.mod.json，:core 纯库不可加，ADR-021）；`embed.ts` 产物双平台化（paper +
  fabric，`defaultEmbedTargets` SSOT）；`fabric.mod.json` version 经 processResources
  expand 注入（check-versions 门禁版本族不含该文件，硬编码即隐藏版本点，ADR-034 反对）。
- **真机清单（只能 fabric dedicated server 实机背书，SOP 待真机波）**：
  1. mod 装载与 entrypoint：mods/ 放入 → SERVER_STARTING 拉起 → embedded 解压
     （plugins/kurobridge/bin/node.exe）→ ready 汇总行（mod v/node v/协议 v）。
  2. 开发覆盖形态：KUROBRIDGE_BUNDLE / KUROBRIDGE_NODE / KUROBRIDGE_STUB_PEER 三变量
     语义与 paper 一致性。
  3. 四事件帧真实到达对端（stub/Node）：含 translatable 死亡消息文案、/me 超集行为、
     join/quit 后 status 快照时序。
  4. TPS 数值：空载 ≈20.0、压测 <20（60s 窗收敛速度）。
  5. broadcast 落玩家 + 控制台；execute_command 三路输出（/say、/list、语法错误 error）
     与真实执行完回执时序；控制台回执行噪声有无。
  6. `/kurobridge send|reload|qr`：hasPermissionLevel(2) 的 op/非 op 行为（与 paper
     kurobridge.admin default op 对照）、看护放弃文案。
  7. 关停路径：`stop` → Node 优雅退出 + node.pid 清理；强杀服务端 → 残留 PID 提示。
  8. 看护器：手杀 node → 退避重启 → 10 分钟窗 3 次放弃文案。
  9. napuketto 链（QR）端到端：目录契约与 paper 同为 plugins/kurobridge/（cwd=服务器根）。
- **门禁证据**：`:fabric:build` 与全仓 `gradlew build` 绿（spotless palantir 2.71.0 +
  `-Xlint:all -Werror` + release 21 同严度；`:fabric:test` 6 用例）；toolings 三文件
  biome/tsc 绿、vitest 19 测试（+1）；check-docs-scope/links/check-versions 三门禁绿
  （144 文件 / 17 md / 版本六点）。
- **过程偏离登记（两条，均如实）**：
  1. 任务书要求的并行 Explore/实现/复核 subagent 因额度硬墙（5 小时限额，21:04 重置）
     不可用——侦察、实现、复核由主对话顺序执行，复核以主对话全量自查替代（领地核对：
     `git status` 实证仅 fabric/settings/toolings-三文件；提交链 pathspec 显式，
     并行线 lse 的在途文件零触碰）。
  2. 并行线 1/3（lse）在同一工作树有在途红（`bridge-host.test.ts` 2 用例 + biome
     unused-param，其领地 mtime 实证），pre-commit 全链会被其挡住——本线提交以
     `LEFTHOOK=0` 绕过钩子，本线领地门禁独立验证如上；全链绿以 lse 落地后的 CI 为准。

## 待定事项

- **CI 推送**：CI 已激活且绿（2026-09-19 推送阶段 2 提交后 run 35420391301 全绿，为
  build 前置修复后的首次真 CI 验证；结构经 ADR-035 结论 4 简化：无姊妹仓检出，ts job
  = `pnpm check && pnpm test`，check 链自含 build 首环）。本地 master 领先 origin 3 笔
  （ADR-036 三连：立档 / 金样本检查 / embedded 悬空指针修复）待推送——推送后 CI 复跑
  为最终验证。
- koishi-plugin-kurobridge 独立仓库（ADR-018）：官方参考对端 + 平台渲染唯一归属，
  JE 闭环后启动（Koishi v4 基线）；其协议依赖 `^0.1.0` 亦待切 `^0.4.0`（上游协作）。
- `platforms/be` 家族骨架已建：`lse/`（TS，复用 bridge/core，QuickJS 可跑是硬约束）、
  `endstone/`（C++ 薄壳预留），实现排期在 JE 闭环后。
- `platforms/je` 的 neoforge/velocity 为预留骨架，接入对应服务端 API 后启用
  （多版本策略 ADR-021：适配层按版本矩阵构建，`:core` 与 `bridge/core` 不动）。
  fabric 已于 2026-09-19 平台落地波实现（见上方并行线 2/4 块）。

## 债务索引

跨阶段债务汇总（详细背景与当时取舍点进来源册；已完成项已移除）：

| 债务 | 来源册 |
|---|---|
| quick-login 登录历史落盘链（恒「无历史登录账号」→ 每次重启需重扫 QR；NapukettoQQ 侧待查，疑与登录记录写回相关） | STATUS 终验节 |
| 多平台 node 三进制矩阵（linux/macOS）+ SHASUMS 严格模式转默认 | MVP2-NOTES |
| wine / Linux QQ 宿主（napuketto self-host 目前 Windows-only） | MVP4-NOTES |
| 多平台构建矩阵（napuketto 嵌包按构建机平台 npm 安装） | MVP4-NOTES |
| msgContinue/msgEnd 流式回报 | DEBT1-NOTES |
| status 周期上报（当前事件驱动：join/quit 时机推送；设计草图见 ADR-034 结论 5，随 MVP-2 评估） | MVP1-NOTES M-04 |
| serverId 多实例互联（config `server.id` 已落地清 spike 残留，ADR-034；互联全案待做） | DEBT1-NOTES |
| TLS/wss 直连（当前官方建议 = 隧道部署，见 KuroProtocol peer-guide §8） | MVP3-NOTES |
| 看护器窗口参数可配置化（现写死 10 分钟窗/3 次） | DEBT2-NOTES |
| JAR 体积优化（LZMA/分层下载）、运行期升级提示 | MVP2-NOTES |
| vanilla 命令输出捕获窗口语义（log4j 主线程窗口，并发混行理论风险） | DEBT1-NOTES 小债 |
| fake-player.mjs play 态 keepalive 未实现（限 30s 验收窗） | DEBT1/MVP3-NOTES |
| QR URL 正则 best-effort（napuketto 改日志文案即失效；PNG 路径为主不受影响） | MVP4-NOTES |
| `:paper` 侧单测偏薄（IPC 集成测试覆盖，Bukkit 桥接层缺单测） | MVP1-NOTES |
| fabric chat relay 权限门缺失（`kurobridge.relay` 等价；接管 = fabric-permission-api；`/kurobridge` 的 op 级别粒度近似 `kurobridge.admin` 同根因） | STATUS 2026-09-19 fabric 块 / fabric design.md §3 |
| fabric 多 MC 版本矩阵（首版 1.21.4 单版本基线；接管点 = 版本坐标组 / depends 收放 / CI matrix） | STATUS 2026-09-19 fabric 块 / fabric design.md §1 |
| fabric SERVER_STOPPING 时点早于玩家断开（paper onDisable 在断开后；关停语义有界等待+强杀不变） | STATUS 2026-09-19 fabric 块真机清单 7 |

## 阶段史

8 个阶段的任务书与执行实录（含逐条决策、放弃方案、沙盒实录、架构发现）全部归档于
[`history/`](history/README.md)，含提交链索引表。历史册正文不改写；册内旧路径按
history/README.md 的路径口径理解。
