# KuroBridge 现状与路线（STATUS）

> 开始任何工作前先读本文 → `architecture.md`（架构书）→ 对应包 `docs/design.md`。
> 本文只讲「现在」；阶段史（原型 → MVP-1~4 → DEBT-1/2 → 改名）的任务书/实录全在
> [`history/`](history/README.md)，拍板依据在 [`DECISIONS.md`](DECISIONS.md)（ADR-001~034）。

## 当前状态（2026-09-18）

**JE（Paper）主链全部完成，真机终验已通过**：MVP-1~4 + 两轮债务清偿 + 品牌迁移
（KuroBot → KuroBridge）+ 真机终验收官（见下节）。当前可分发形态 =
`kurobridge-0.1.0.jar`（**48.4MB**，内嵌 Node 26 + napuketto CLI 0.1.20，开箱
控制台扫码），协议 `kurobridge-ws`（版本 SSOT = 姊妹仓 KuroProtocol 的 `src/meta.ts`；
改名后唯一 breaking = 握手子协议字符串，帧形状零变化，ADR-030；本仓协议副本已冻结为
只读镜像，ADR-031）。

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
- **门禁基线**（2026-09-18 治理波次后）：`pnpm check`（一条入口：biome + 根 tsc + lse
  typecheck + docs 门禁 + 版本对齐）/ `pnpm test`（**180 用例**）/ `pnpm -r build` /
  `pnpm check:protocol` / `gradlew build` + `:core:test --rerun`（**74 用例**）全绿。
  CI 双 job 已入库（ADR-032），**推送 master 后激活**（见待定事项）。
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
  `check:protocol`；java job mise JDK 25 跑 `gradlew build`——Java 回归从此对门禁可见）；
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

## 待定事项

- **CI 推送激活**：`.github/workflows/ci.yml` 已入库（ADR-032），本地 master 领先 origin
  多笔未推——推送后 CI 首跑生效；ts job 依赖姊妹仓 KuroProtocol（public，免 token），
  上游演进未同步镜像时变红属预期（resync 规程见 KuroProtocol `docs/MIRROR-RESYNC.md`）。
- **协议依赖切换（阶段 2，ADR-031）**：KuroProtocol 发布 `@kuro-bridge/protocol@0.4.0` +
  deprecate npm 0.1.0（误发旧线，2026-09-15）后，删除本仓 `bridge/protocol` 镜像与门禁，
  三消费方（core / embedded / lse）`workspace:*` → `^0.4.0`。命令清单见
  KuroProtocol `docs/DECISIONS.md` ADR-001（需账号操作，用户执行）。
- koishi-plugin-kurobridge 独立仓库（ADR-018）：官方参考对端 + 平台渲染唯一归属，
  JE 闭环后启动（Koishi v4 基线）；其协议依赖 `^0.1.0` 亦待切 `^0.4.0`（上游协作）。
- `platforms/be` 家族骨架已建：`lse/`（TS，复用 bridge/core，QuickJS 可跑是硬约束）、
  `endstone/`（C++ 薄壳预留），实现排期在 JE 闭环后。
- `platforms/je` 的 fabric/neoforge/velocity 为预留骨架，接入对应服务端 API 后启用
  （多版本策略 ADR-021：适配层按版本矩阵构建，`:core` 与 `bridge/core` 不动）。

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

## 阶段史

8 个阶段的任务书与执行实录（含逐条决策、放弃方案、沙盒实录、架构发现）全部归档于
[`history/`](history/README.md)，含提交链索引表。历史册正文不改写；册内旧路径按
history/README.md 的路径口径理解。
