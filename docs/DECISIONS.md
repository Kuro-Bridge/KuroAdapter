# KuroBridge 决策记录（DECISIONS）

> 借鉴 NapukettoQQ 的 `DECISIONS.md` 形态。每项决策记录背景 → 选项 → 结论 → 理由。编号按时间序，永不改写历史。
>
> 2026-09-15 归档注：条目中引用的 `docs/*-PROMPT.md` / `*-NOTES.md` / `docs/protocol/draft-v0.1.md` 已移入 `docs/history/`（路径口径见其 README.md）；条目正文未改。

---

## ADR-001 单仓 monorepo（2026-08-10）

- **背景**：协议 SSOT 需要 Java/TS 两端同步；嵌入式打包跨 `bridge/embedded` 与 `platforms/je`。
- **选项**：单仓 / 双仓（je 与 bridge 分离）。
- **结论**：**单仓**。
- **理由**：改协议源 + 两端消费方一个 PR 原子完成；跨仓 CI 联动成本高；协议防漂移门禁单仓内一行命令。代价是权限粒度粗，对个人开源项目可接受。

## ADR-002 Java 版本 21（2026-08-10）

- **结论**：Java 21 LTS。Paper 1.20.5+ 已是 Java 21 时代；虚拟线程对 WS 长连接有价值。

## ADR-003 协议命名与双层版本（2026-08-10）

- **结论**：协议代号 `kurobot-ws`。
- **版本机制**：WS 子协议 `Sec-WebSocket-Protocol: kurobot-ws.v1` 声明大版本（不兼容变化，握手期直接拒绝对端）；`hello` 消息内 `protocolVersion`（语义化 `0.1.0`）做小版本/能力协商。
- **理由**：比单纯握手协商更早暴露不兼容；对端（Koishi 侧）报错更友好。

## ADR-004 绑定频道列表随 hello 上报 + bindingsUpdated（2026-08-10）

- **结论**：`hello` 携带 `channelBindings`（对端无需读 kurobot 配置即可自动发现频道）；协议保留 `bindingsUpdated` 增量事件，服主运行期改配置时通知对端。

## ADR-005 业务核心移入 Node，Java 薄壳化（2026-08-10，架构关键变更）

- **背景**：开发者是 TS 开发者、未写过 Java；Paper 插件硬约束是 JVM 语言，但 kurobot 反正要内嵌 Node。
- **结论**：绑定/白名单/权限/转发规则等业务全部移入 `bridge/core`（TS）；Java 退化为 Bukkit 桥接薄壳（事件/命令/权限/IPC/进程管理，~几百行模板代码）。
- **理由**：开发量 90% 落在 TS；早期「业务在 Java config」结论作废。

## ADR-006 external 模式也拉 Node（2026-08-10）

- **结论**：两种模式都拉起内嵌 Node 跑 `bridge/core`（WS 服务端在 Node 里）；external 仅表示「不附带协议端」。
- **理由**：业务核心在 Node，external 也必须拉；两种模式的差异只剩协议端是否随 JAR 附带，架构复杂度反而下降。

## ADR-007 bridge/core 平台无关化（2026-08-10）

- **结论**：`bridge/core` 禁止 Node API（`ws`/`process`/`fs`/`pino`），传输层与 logger 为可注入接口，target ES2020 → Node / Koishi / LSE(QuickJS) 三端可跑。
- **理由**：JE/BE 双端复用同一套协议层；QuickJS 无 tslib/装饰器，`erasableSyntaxOnly` 保证产物可直接跑。

## ADR-008 协议 SSOT 用 zod（TypeBox → zod）（2026-08-10）

- **背景**：TypeBox 的核心价值是「schema → JSON Schema → 其他语言代码生成」。架构演进后 Java 走 JSON-lines IPC，不再需要协议 POJO。
- **结论**：SSOT 用 **zod**。schema 即产物（`z.infer`），无生成步骤；`safeParse()` 直接做协议层运行时验证；零依赖纯 JS，QuickJS 可跑；防漂移门禁从「生成检查」变为 lint（禁止手写消息类型）。
- **连带**：`gen-protocol` 只出 TS 类型，不再生成 Java POJO。

## ADR-009 多语言单仓不引入 nx/turbo（2026-08-10）

- **结论**：pnpm workspace 管 TS、Gradle 独立构建、根 `package.json` 只做编排；不引入 nx/turbo。
- **理由**：仅 5-6 个 TS 包，turbo 缓存收益是负资产；唯一跨语言桥 `tools/embed`（已删待重建）用构建顺序硬约束保证。

## ADR-010 Java↔Node IPC 用 stdin/stdout JSON-lines（2026-08-10）

- **结论**：Java 薄壳 ↔ Node 子进程走 stdin/stdout JSON-lines，零端口零配置；UUID 请求-响应 + 事件推送。
- **理由**：消灭本地端口冲突；Node 对外 WS 用动态端口 `listen(0)`，僵尸进程不再占端口。

## ADR-011 Java 第一版不上 Error Prone / NullAway（2026-08-10）

- **结论**：Java 薄壳第一版只上 `-Xlint:all -Werror` + Spotless(Palantir) + JUnit 5 + JaCoCo 存在性门禁（≥60%）。
- **理由**：几百行模板代码配 NullAway 性价比低；规范重心全押 TS 侧。薄壳定型演进后再评估。

## ADR-012 LSE TS 化（2026-08-10）

- **结论**：`platforms/be`（LeviLamina）用 TS 开发，经官方 `@levimc-lse/types` + `@levimc-lse/scaffold` 编译为 JS 后加载；复用 `bridge/core`。
- **理由**：LSE 原生 JS（QuickJS）不跑 TS，但官方把「TS → 编译 JS → LSE 加载」做成标准开发方式；开发者是 TS 开发者。

## ADR-013 测试栈（2026-08-10）

- **结论**：TS 侧 **vitest** 一统（protocol/core/embedded），coverage 用 v8 provider（core 设阈值，壳层放宽）；Java 侧 JUnit 5。**fast-check（property-based）列为二期 backlog**。
- **理由**：开发者熟练 vitest；property-based 对协议编解码/握手状态机有价值但不阻塞一期。

## ADR-014 嵌入式打包沿用 Napuketto 许可证方案（2026-08-10）

- **结论**：`node.exe`（MIT）进 JAR；`wrapper.node`（腾讯闭源）不进 JAR，运行期从 QQ 安装目录发现拷贝；stub 闭源件走 release 附带；动态端口；stdin EOF 自杀 + PID 文件 + Watchdog + 崩溃兜底。

## ADR-015 工具链升级：Node 26 + Java 25（2026-08-11）

- **背景**：Node 26 已是 Current（2026-10 进 LTS，@types/node 26 已在用）；Java 25 为 LTS（2025-09 发布）。
- **结论**：
  - Node 升 **26**（开发/CI 运行时）。
  - Java 工具链升 **25**，但 **Gradle 编译字节码 target 保持 21**（`-release 21`）——Paper 服务端运行时以 Java 21 为基线，target 21 保证插件在大多数服务端可加载，同时享受 25 工具链的编译期检查。
- **不引入 Bun 运行时**（ADR-016）。

## ADR-016 运行时不用 Bun（2026-08-11）

- **结论**：**Bun 不能替换 Node 作为 kurobot 的运行时**。
- **理由**：
  1. **napukettoqq 协议端**依赖 `wrapper.node`（腾讯闭源 NAPI 模块），必须由 Node 进程 `process.dlopen` 加载——Bun 的 Node-API 兼容层未经验证，闭源模块是高风险赌注。
  2. **Koishi 生态**绑定 Node（adapter 全家桶的 fs/net/worker 等边缘 API 在 Bun 下有差异，插件生态未验证）。
  3. **嵌入式运行时**打进 JAR 分发，Node 体积/兼容性经过验证；Bun 的 Windows 支持仍非一等公民。
  4. LSE 是 **QuickJS**——`bridge/core` 平台无关（ADR-007）已经保证了跨端，Bun 改变不了这一点，也没有收益。
- **Bun 的合理用途**（本项目不需要）：纯工具脚本 / dev 服务器——pnpm + Node 已满足。

## ADR-017 剔除 CI/CD（2026-08-11）

- **背景**：开发者从未使用过 CI/CD；单人开发、本地命令（`pnpm check` / `pnpm test`）与 CI 内容完全一致。
- **结论**：**删除 `.github/workflows/ci.yml`**，暂不引入 CI/CD；质量门禁由本地 lefthook（pre-commit）+ `pnpm check` 承担。
- **理由**：单人单机开发，CI 只是"多一道自动化保险"；协议防漂移门禁（ADR-008 的 lint 规则）本地同样生效。成本不为零（写一次不用管，但出了故障要排），收益当前不明显。
- **回退条件**：多人协作 / 开源贡献者介入 / 需要干净机器构建验证时，按 ADR-001 的构建顺序恢复（TS 构建 → 嵌入式打包 → gradle :paper:shadowJar）。

## ADR-018 koishi 插件独立仓库（2026-08-11）

- **背景**：koishi-plugin-kurobot 作为 `kurobot-ws` 的官方参考对端（external 形态），需要**独立发布 npm** 供任意 Koishi 实例 load；它是公开契约的对外实现，外部团队可对照协议实现自己的对端，我们无需关心其实现。
- **结论**：**`bridge/koishi` 从本仓库剔除**；koishi-plugin-kurobot 在**独立仓库**开发，依赖 `@kurobot/protocol` 的**发布版本**（非 workspace link）。
- **理由**：与协议「公开契约、对端只认协议」的设计（ADR-003）一致；独立版本节奏（不随 kurobot 主仓库发版）；`@kurobot/protocol` 本身也需独立发布 npm 作为公开契约。
- **连带**：本仓库 `bridge/` 只含 protocol/core/embedded；平台渲染（富文本/颜色码/长度收敛）全部发生在独立仓库，本仓库不涉及。
- **回退条件**：如独立仓库维护成本过高（协议同步频繁），可改回子模块/workspace 方式，但协议包仍须独立发布。

## ADR-019 platforms/je 多模块化（2026-08-11）

- **背景**：MC 服务端多样（Paper / Fabric / Velocity 等），每个都需要一个适配插件；薄壳的核心逻辑（IPC 客户端 / Node 子进程管理 / JSON-lines 解析）与具体服务端 API 无关。
- **结论**：`platforms/je` 改为 **Gradle 多模块**：`:core`（纯逻辑，零 Bukkit API，可独立测试）+ `:paper`（Paper 适配，依赖 `:core`）+ 预留服务端模块骨架（`fabric`/`velocity` 等）。**一个服务端 = 一个模块，共享 `:core`**，命名不带 kurobot 前缀（目录已处于 kurobot 项目内，冗余）。
- **理由**：未来新增服务端只是加模块，不动 `:core`；`:core` 平台无关可独立测试（对齐 TS 侧 `bridge/core` 平台无关的设计 ADR-007）；共享薄壳核心避免多服务端重复实现。
- **实施**：2026-08-11 完成 `:core` + `:paper` 拆分，shadowJar 产物 `kurobot-0.1.0.jar`。

## ADR-020 BE 服务端家族：LSE + Endstone C++ 薄壳，剔除 Nukkit（2026-08-11）

- **背景**：2026 年 BE 服务端生态实况——LeviLamina（LSE 脚本）是主流插件路线，Endstone（C++/Python）是另一支活跃生态；Nukkit 确认非主流（Wiki 插件加载器列表无它）。开发者会 C++。
- **结论**：
  - `platforms/be` 重组为 **BE 服务端家族**：`lse/`（LeviLamina，TS，维持 ADR-012）+ `endstone/`（Endstone，**C++ 薄壳**，预留骨架）。
  - **Endstone 走 C++ 薄壳**（非 Python）：C++ 只做事件桥接 + 内嵌 Node 子进程管理 + JSON-lines IPC，业务仍走 `bridge/core`——与 Java 薄壳完全同构，复用全部业务。
  - **剔除 Nukkit 模块**（非主流，避免误导）。
- **理由**：Endstone 生态存在且有价值（C++ 技术栈匹配开发者能力）；薄壳模式（ADR-005 同款）让 C++/Java 薄壳共享同一 `bridge/core` 业务核心，无需为各服务端重复实现业务。
- **连带**：`platforms/` 划分标准 = 技术栈 + 客户端（je=Java 服务端 / be=BE 服务端家族，家族内按具体平台分）。
- **回退条件**：如 Endstone 生态萎缩，可删除 `endstone/` 骨架（成本为零）。

## ADR-021 JE 多版本兼容策略（2026-08-11）

- **背景**：MC Java 服务端版本众多，Paper/Fabric/NeoForge 的版本兼容机制差异巨大。
- **结论**：
  - **`:core` 完全版本无关**（零 MC API）——多版本兼容的护城河，改 MC 版本时 `:core` 一行不动，只重编适配层。
  - **Paper/Bukkit 系**：单 jar 通吃（API 向后兼容，`api-version` 声明最低版本，低版本编译高版本运行）。
  - **Fabric/NeoForge（mod 加载器）**：每个 MC 版本一个独立构建（**版本矩阵**），`fabric.mod.json` / `mods.toml` 声明版本范围，按需生成 `kurobot-<mcver>.jar`。
  - **Velocity（代理）**：API 稳定，单 jar 通吃 3.x。
- **理由**：薄壳架构（ADR-005）天然支持——适配层绑定版本，业务核心（bridge/core + :core）版本无关，避免为每个版本重复实现业务。
- **实施**：2026-08-11 新增 `neoforge/` 预留模块（ModDevGradle，尚未接入）。

## ADR-022 内嵌协议端以孙进程形态由 Node 引导层拉起（2026-09-13，原型候选 A 转正）

- **背景**：embedded 形态下协议端（napukettoqq）与业务核心（bridge/core）同在 Node 世界，有两种宿主形态：与 core 同进程，或独立进程。原架构书未定稿。
- **选项**：
  1. 协议端与 core 同进程（一个 Node 进程干所有事）。
  2. 协议端为**孙进程**：Java 只拉起 Node 引导层（bridge/embedded，内含 core + WS 服务端），引导层 `listen(0)` 拿动态端口后再以子进程拉起协议端（端口经 argv 注入）。
- **结论**：**选 2（孙进程）**。Java 永远只管一个子进程（生命周期级联 Java→node→协议端）；协议端走与 external 完全相同的 WS client 路径——「embedded / external 只是打包差异，不是架构差异」（架构书 §1）在进程拓扑上同样成立。
- **实证**（`docs/PROTOTYPE-NOTES.md` D-05、「架构发现」TS 链路烟囱与端到端两段）：孙进程生命周期级联（正常关机 shutdown 帧先杀孙进程再退出、stdin EOF 兜底、无孤儿进程）与「协议端 = 普通 WS 对端」在真实 Paper 1.21.4 沙盒验证通过。
- **理由**：
  - 协议端崩溃不拖垮业务核心（进程隔离），反之亦然；
  - 协议端不必感知 IPC 与 core 内部结构，只实现 WS 客户端，未来替换为 napukettoqq 零架构改动；
  - Java 侧进程管理复杂度不随协议端数量增长。
- **回退条件**：内存受限环境（协议端 + core 两个进程开销不可接受时）可合并为单进程——`bridge/core` 一行不动，只改 `bridge/embedded` 引导层把协议端从 `spawn` 改为同进程 import 加载。

## ADR-023 握手收敛为单程 hello + hello_ack（2026-09-13，原型候选 B 转正）

- **背景**：draft-v0.1 §1 原设计双向 `hello`（Server→Peer 注册 + Peer→Server 注册），语义重叠。
- **选项**：保留双向 hello / 收敛为单程握手。
- **结论**：**单程握手**——Peer 连入 → 发 `hello`（请求，带 id：peerId/platform/version/protocolVersion）→ Server 校验 → 回同 id 的 `hello_ack`（携带 serverId/version/protocolVersion 的 ok 体，或 error 体 + 关连接 1002）。废除 Server 侧主动 `hello`。
- **实证**（`docs/PROTOTYPE-NOTES.md` D-01）：原型按此实现，握手/版本不匹配拒绝/重复 hello 忽略均有单测与沙盒验证。
- **理由**：请求-响应模型与 UUID 关联机制（ADR-003/010）天然对齐，少一种帧型；服务端身份信息并入 ack body，不损失能力。正式版若需服务端主动注册可再拆出。
- **连带**：`docs/protocol/draft-v0.1.md` §1 的双向 hello 语义作废，以 §5.1（单程握手）为准。

## ADR-024 协议包常驻「解析层」：线格式 → 扁平消息 transform（2026-09-13，原型候选 C 转正）

- **背景**：帧线格式为嵌套 `{ header: { type, id? }, body } }`（ADR-003/D-04），但 TS 对嵌套判别（`frame.header.type`）无法收窄 union（TS 7/tsgo 实测，见 `docs/PROTOTYPE-NOTES.md` D-11），消费方需逐分支二次 `safeParse` 才能拿到精确类型。
- **选项**：
  1. 消费方逐分支二次 `safeParse`（重复解析、运行时多一次全量校验）。
  2. 把 `type` 提到线格式帧顶层（改变已定稿的帧结构，Java 侧连带改动）。
  3. **协议包内做 transform**：解析层把线格式摊平为 `{ type, id?, body }` 扁平消息，出帧统一走 `encodeFrame`。
- **结论**：**选 3**，并作为常驻设计（协议解析层的雏形）：`bridge/protocol` 的帧 schema 在 `.transform()` 内完成「线格式 → 扁平消息」，线格式不变（Java 侧零影响）；消费方 `msg.type === "hello"` 原生收窄，出帧一律 `encodeFrame(message)`。
- **实证**（`docs/PROTOTYPE-NOTES.md` D-11 与「架构发现」首段）：原型期已按此实现全部 schema 与两侧消费方；zod v4 对「泛型 body 对象输出 + transform」的推断缺陷用两个助手函数内的结构断言吸收（`frame as { header: …; body: … }`），断言不出助手函数。
- **理由**：SSOT「线格式 = 消费格式」的代价被吸收在协议包内，消费方零感知；消息增多后该层即「协议解析层」，承担未来字段演进/兼容处理的唯一改动点。

## ADR-025 WS 与 IPC 统一帧格式与 id 规则，`*_result` 显式响应帧型（2026-09-13，原型候选 D 转正）

- **背景**：Java↔Node IPC（ADR-010）需要自己的消息格式；WS 侧已有 `{ header: { type, id? }, body }`。
- **选项**：IPC 自定义格式 / 完全复用 WS 帧格式。
- **结论**：**完全复用**：同一帧格式，仅 type 命名空间不同（IPC 侧 snake_case 事件/请求名）。id 规则统一：**事件帧无 id（携带 id 即校验失败，尽早暴露方向用错），请求/响应帧 id 必填（UUID 关联）**。IPC 请求-响应用显式 `*_result` 帧型（`broadcast` → `broadcast_result`，同 id），不用通用 `result` 帧。
- **实证**（`docs/PROTOTYPE-NOTES.md` D-03/D-04）：原型两侧（zod schema + Java Jackson DTO 镜像）按此实现，编解码/严格拒绝/请求-响应关联均有单测与真管道集成测试。
- **理由**：一套帧 schema、一套编解码心智模型、Java 侧一套 Jackson DTO；显式响应帧型让每条响应有自己的 body schema，判别信息不重复、类型收敛，两侧都不需要二次分发。放弃的「单一 `ipc_result` 帧 + body 内嵌 type」方案存在判别信息重复。

## ADR-026 协议版本协商改「主版本兼容区间」+ WS 未知帧容忍（2026-09-13，DEBT-1）

- **背景**：D-10 的精确相等协商要求对端与服端版本逐位一致，每加一个可选字段就强迫全体对端同步升级（0.2.1 的 ready.autoRestart 已经历一次）。0.3.0 引入请求族与鉴权后，若维持精确相等，「服务端先升、对端渐次跟进」的渐进演进不可行。
- **选项**：
  1. 维持精确相等。
  2. **主版本号相同即兼容**（次/补丁位自由浮动，0.2.0 对端可连 0.3.0 服务端，1.x 拒绝）。
  3. 不校验版本。
- **结论**：**选 2**。协议包导出纯函数 `isProtocolVersionCompatible(peerVersion, serverVersion)`（解析 `^\d+\.\d+\.\d+$` 比主版本；任一解析失败 = 不兼容），不兼容仍走既有拒绝路径（hello_ack `ok:false` + close 1002 + reason）。兼容区间的安全网是 **WS 侧未知帧容忍**（IPC 侧不做——Java 与 Node 同仓同版 lockstep，未知帧 = 版本错位 bug，保持 warn + 丢弃响亮暴露）：未识别的**请求帧**（带 uuid id）→ 回同 id 的 `<type>_result` 体 `{ok:false, error:"unknown frame type"}`，不断连；未识别的**事件帧** → 忽略 + debug 日志。补充规则：未知 type 以 `_result` 结尾（对端回了我们不认识的响应）视为响应帧**不回执**、仅 debug 忽略——否则「响应回执响应」会构成乒乓循环。
- **理由**：语义化版本的本意即「主版本 = 破坏性变更」；0.x 阶段主版本不动、小版本持续演进，精确相等会把 0.x 变成事实上的 1.0 门槛。容忍策略让服务端可以先于对端携带新能力而不炸旧对端。
- **回退条件**：同一主版本内出现不兼容演进的现实压力（如字段语义反转）时，回退精确相等或改为 hello 携带能力开关列表（features[]）。

## ADR-027 白名单 SSOT 归 MC 原生 whitelist（2026-09-13，DEBT-1）

- **背景**：群服互通的典型诉求「群管理员在群里加白名单」。白名单数据放 core 自建存储，还是直接用 MC 原生 whitelist？
- **选项**：
  1. core 自建白名单表（config 或独立存储），改动时镜像到 MC（写 whitelist.json 或回放原生命令）。
  2. **SSOT = MC 原生 whitelist（whitelist.json）**：core 不做存储/镜像；群管理员经 WS `command` → IPC `execute_command` → Java dispatch `whitelist add|remove|list`，输出行经 `execute_command_result.output` 回传。
- **结论**：**选 2**。
- **理由**：MC 的 whitelist.json 是服主已熟悉的事实标准（Vanilla/Paper 全生态兼容，`/whitelist on|off`、与 op 联动等语义免费获得）；双写镜像必然产生漂移（服主手改原生表 vs core 表互不知情）；core 平台无关约束（ADR-007）下读 whitelist.json 反而是平台耦合（BE 平台路径/格式各异）。输出回传链（收集型 CommandSender）让 `list`/`add` 结果原样可观测，业务价值不损失。
- **回退条件**：出现「跨服务器共享白名单 / 群内可视化编辑白名单」等 core 必须持有数据的诉求时，再引入 core 白名单表 + 与原生表的单向同步。

## ADR-028 external 接入基座：config.ws 监听段 + 绑定失败收敛于看护器 + 空 token WARN（2026-09-13，MVP-3）

- **背景**：kurobot-ws 服务端此前只会 `listen(0)` 动态端口（embedded 孙进程形态够用）；external 形态（napukettoqq 独立部署、经配置端口主动连入，MVP-3 拍板只做该形态）需要固定端口 + 可选绑定地址 + 更强的安全基线。
- **选项**（监听配置的归属）：
  1. 配置只放 embedded（消费方所在地）。
  2. **形状进 core configSchema（SSOT），消费在 embedded 引导层**。
  3. 配置进 Java 薄壳。
- **结论**：**选 2**。WS 监听参数是宿主事务（红线 2）：`KurobotServer`/`WsServer` 接口不感知 host/port，`start()` 返回实际端口的契约不变，ready 帧照报实际端口；core 只新增顶层可选段 `ws: {host?, port?}` 的 zod 形状（整段缺省 = 动态端口 + 全部接口，现状不变；只配 host = 动态端口 + 指定地址，合法）。绑定失败（含异步 EADDRINUSE——实测 ws 库经 `error` 事件异步到达、构造不抛）→ 明确 error 日志（含端口与原因）+ Node 非零退出，**不新增重试机制**：Java 看护器 1s/5s/15s 退避、10 分钟窗 3 次放弃（DEBT-2）自然覆盖长期端口冲突。安全基线：config 含 ws 段且 token 为空 → 启动 WARN 不阻断（保持空 token 向后兼容语义）。
- **理由**：SSOT 单一来源避免 config-schema 文档与双实现漂移；Java 零感知（选 3 会把 WS 监听细节漏进桥接薄壳，违背红线 2/3）；绑定失败收敛于既有看护器语义，避免第二套重试状态机与「服务端自旋重绑」的风暴风险。
- **协议增量**：0.3.0 → 0.3.1（patch），hello 可选 `client` 自报身份串（建议 `名称/版本`），仅连接日志辨识、不做行为分支；0.2.x/0.3.0 对端双向兼容（可选字段 + 剥离未知键）。

## ADR-029 embedded 形态内嵌 napuketto CLI：嵌包边界 + 固定端口强制 + 文件式 QR 交接 + taskkill 树杀（2026-09-14，MVP-4）

- **背景**：ADR-022 的孙进程协议端至今只有 stub；「装个 JAR、扫一次码即得群服互通」缺最后一环。napuketto 侧 kurobot 适配器已完成（`@napuketto/adapter` 0.2.1，golden 锁本仓协议 0.3.1 @ b0809ef）。
- **选项**（嵌入入口）：
  1. KuroAdapter 自造 supervisor：直接拉起 `@napuketto/loader` self-host，自管 QQ 登录/重启/凭据。
  2. **嵌入 `@napuketto/cli`（dist 入口）**：supervisor、QR 三呈现、凭据持久化全部现成；KuroAdapter 只做拉起、stdio 捕获→logger、生命周期接线。
- **结论**：**选 2**。协议 0.3.1 一字不动（目标零协议变更）；QQ 登录流程完全交给 napuketto，KuroAdapter 不解析不干预。
- **嵌包边界（ADR-014 特化）**：进 JAR 的只有 MIT 的 npm 发布物（`@napuketto/*` 及其 npm 依赖，含 loader 包自带的**自研** stub QQNT.dll 与 7zip 资产 LGPL——与 `npm install` 等价的原样分发）；**wrapper.node、QQ 安装包、QQNT 腾讯二进制绝不进 JAR 不进仓**（napuketto 运行期自取）。
- **config 顶层可选 `embedded` 段**（形状 SSOT 归 core zod，消费在 embedded——先例 ADR-028）：`{ napuketto: { enabled, configPath?, dataDir? } }`；整段缺省 = 现状（stub/external 形态不变）。
- **固定端口强制**：`enabled` 且 config 无 `ws.port` → 明确 error + Node 非零退出（WsBindError 同族：napuketto TOML 的 `url` 是静态的，动态端口无法喂给它）；重启收敛于 Java 看护器退避（DEBT-2）。非 Windows 宿主 → 明确 error + 不拉起（Node 继续以纯 WS 服务端运行，external 对端不受影响；wine 记债务）。
- **QR 文件交接（零协议变更路径）**：Node 轮询 napuketto 数据目录 `*/cache/qrcode.png` 变化 + 捕获流中固定格式 URL 日志 → 落地 `plugins/kurobot/qr.png` + `qr.json`（node.pid 式运维文件先例）；`:paper` 增 `/kurobot qr` 只读展示。URL 解析 best-effort，PNG 为主。放弃 IPC 帧方案（要动协议 0.3.2 + napuketto 侧 golden 重对齐，代价不成比例）。
- **生命周期（Windows）**：优雅关停 = `taskkill /PID <cli> /T /F` 树杀（考据：napuketto boot 层无信号处理器、全链无父死检测，`child.kill()` 强杀 supervisor 必留 self-host 孤儿持 instance.lock——napuketto 自家 `napuketto stop` 同款树杀）→ 有界等待 → Node 自退；CLI 意外退出 → Node error + 非零退出 → Java 看护器退避重启 → 重拉 CLI（凭据在腾讯原生层，quick-login 自动恢复）。强杀 Node → CLI 树预期随 Node 26 Job Object 级联死亡（DEBT-2 发现，四层树复验记 NOTES）。
- **理由**：选 1 要重造登录会话/重启/凭据三块 napuketto 已稳定的能力，且更贴近腾讯原生层（KuroAdapter 的职责边界失守）；CLI 入口让 napuketto 侧零改动、npm 版本升级即收益。taskkill 树杀是对 napuketto 进程模型的如实适配而非「不优雅」——其自带 stop 命令同款，凭据与锁均有残留自愈设计。
- **回退条件**：napuketto 提供真正的受控关停 API（信号处理/退出钩子）时，可换优雅信号路径；文件式 QR 交接失效（napuketto 改日志/路径格式）时优先仍保 PNG 路径，URL 解析独立降级。

## ADR-030 品牌迁移 KuroBot → KuroBridge：标识映射 + 协议 0.4.0 + one-name-only 零迁移（2026-09-14，改名册）

> 任务书 `docs/RENAME-PROMPT.md`；执行决策与实录见 `docs/RENAME-NOTES.md`（R-01 起）。
> 本 ADR 是新旧名混读的唯一权威映射（历史册正文不改写，混读以此表为准）。

- **背景**：GitHub 组织已迁 **Kuro-Bridge**（主仓 KuroAdapter，remote 已迁）；「KuroBot」名号淘汰。
  此刻无存量部署、napuketto 端 kurobot 支持尚未发布（MVP4-NOTES 发现 H）——是零迁移成本、
  避免双重发布的唯一窗口。
- **用户四拍板（2026-09-14 开题对齐）**：①npm scope `@kurobot/*` → `@kuro-bridge/*`；②用户标识
  统一 `kurobridge`；③线协议 `kurobot-ws.v1` → `kurobridge-ws.v1`，协议 0.3.1 → 0.4.0；④含两仓
  联动（本仓主册 + NapukettoQQ 联动册，单会话只写一仓）。
- **新旧标识映射表**：

  | 维度 | 旧 | 新 |
  |---|---|---|
  | npm scope | `@kurobot/protocol` / `@kurobot/bridge-core` / `@kurobot/bridge-embedded` | `@kuro-bridge/protocol` / `@kuro-bridge/bridge-core` / `@kuro-bridge/bridge-embedded` |
  | 根包名 | `kurobot` | `kurobridge`（private，platforms/be/lse 同名根包同理） |
  | MC 命令 | `/kurobot send\|reload\|qr` | `/kurobridge send\|reload\|qr` |
  | 数据目录 | `plugins/kurobot/` | `plugins/kurobridge/` |
  | 插件名 | `KuroBot` | `KuroBridge` |
  | Java 包 | `com.kurobot`（`com.kurobot.core` / `com.kurobot.paper`） | `com.kurobridge`（`com.kurobridge.core` / `com.kurobridge.paper`） |
  | Java 类 | `KuroBotPlugin` / `KurobotCommand` / `KurobotVersions` | `KuroBridgePlugin` / `KurobridgeCommand` / `KurobridgeVersions` |
  | TS 类 | `KurobotServer` | `KurobridgeServer`（core 内部符号，非线协议） |
  | JAR | `kurobot-0.1.0.jar` / `plugins/kurobot.jar` | `kurobridge-0.1.0.jar` / `plugins/kurobridge.jar` |
  | 哨兵文件 | `.kurobot-install.json` | `.kurobridge-install.json` |
  | env 前缀 | `KUROBOT_STUB_PEER` / `KUROBOT_NODE` / `KUROBOT_BUNDLE` / `KUROBOT_NPM_REGISTRY` / `KUROBOT_NODE_DIST_STRICT` / `KUROBOT_NODE_DIST_BASE` / `KUROBOT_NK_TEST_PASS` / `KUROBOT_STUB_WS_URL` / `KUROBOT_STUB_CLIENT` | 同名换 `KUROBRIDGE_` 前缀 |
  | 线协议 | `PROTOCOL_NAME "kurobot-ws"` / `WS_SUBPROTOCOL "kurobot-ws.v1"` | `"kurobridge-ws"` / `"kurobridge-ws.v1"`（`.v1` 大版本语义不变） |
  | 协议版本 | 0.3.1 | **0.4.0** |
  | 沙盒令牌示例值 | `kurobot-sandbox-token` | `kurobridge-sandbox-token`（config.json 与 napuketto.toml 两侧同步） |

- **协议 0.4.0 breaking 说明**：唯一 breaking 是握手协商字符串 `Sec-WebSocket-Protocol` 与
  `PROTOCOL_NAME` 品牌变更（旧对端 `kurobot-ws.v1` 直接握手拒绝，语义不变）；`.v1` 大版本不变，
  **帧 schema 形状零变化**（golden fixture 仅品牌字符串差异）；hello.protocolVersion 主版本兼容
  区间规则不动（0.2.x/0.3.x 对端在版本号维度仍兼容，但子协议字符串已换 → 实际不可连，即
  one-name-only）。不做双名兼容、不做自动迁移（无存量部署）。
- **迁移策略**：无存量部署 → 不做任何自动迁移；sandbox/ 本地目录 `plugins/kurobot/` 整体改名
  `plugins/kurobridge/`（config.json / napuketto.toml 内容平移，napuketto-data 凭据与
  instance.lock 按 pid+cmdline 自愈）。
- **napuketto 外部契约不动清单**（独立产品，归联动册/上游）：env `NAPKETTO_CONFIG` /
  `NAPKETTO_DATA` / `NAPUTO_QQ_PATH`；文件名 `napuketto.toml`；TOML 段名 `[accounts.kurobot]`；
  对端自报 `client = "napukettoqq/..."`；`@napuketto/*` 包名与 pin（0.1.17，版本变化归联动册）。
- **版本策略**：protocol 包 workspace 版本 0.0.0 机制不动；对外版本 SSOT = `meta.ts`
  PROTOCOL_VERSION（0.4.0 待用户在 npm org 建立后发布，协作清单）。

## ADR-031 协议 SSOT 移交 KuroProtocol：仓内副本冻结为只读镜像（2026-09-16）

> 完整决策档案（问题全景、方案对比、事故记录、阶段 2 命令清单）在姊妹仓
> **KuroProtocol** `docs/DECISIONS.md` ADR-001；本条记录主仓侧的决策与执行。

- **背景**：2026-09-15 拆仓后本仓文档仍自称 `bridge/protocol` 为协议 SSOT（本文件 ADR-008/030
  的历史口径），与根 README、KuroProtocol、KuroAdapter-Pure 的指认冲突；且 npm
  `@kuro-bridge/protocol@0.1.0`（2026-09-15）实际从本仓副本发布，包版本轴与内嵌协议版本
  （0.4.0）错位、exports 缺 require（对端被迫 alwaysBundle 绕行）——「唯一来源」名存实亡。
- **选项**：立删副本改 npm 依赖（被发布条件阻塞）／立删改 `link:` 跨仓路径（耦合放大）／
  **冻结副本为只读镜像 + 一致性门禁**／只改文档（无效）。论证见 KuroProtocol ADR-001。
- **结论**：
  1. **协议 SSOT = 姊妹仓 KuroProtocol**（`src/` zod schema；版本 SSOT = 其 `src/meta.ts`）。
     本仓 `bridge/protocol/` 冻结为**只读镜像**：镜像范围 = src/ 下 8 个 TS 文件，须与
     KuroProtocol/src 字节级一致，由 `pnpm check:protocol`（lefthook pre-commit）强制。
     协议演进的唯一合法路径 = KuroProtocol 四件套同改（schema + peer-guide + fixtures +
     changelog）→ 同步本仓镜像 → 门禁绿。本仓 ADR-008/030 中「SSOT 在本仓」的历史口径
     以本条为准（历史条目不改写）。
  2. 悬案处置：工作区遗留的未提交 bump（0.0.0 → 0.1.0，npm 0.1.0 发布产物）回滚 **0.0.0**
     并加 `private: true`——镜像包版本退出所有版本轴，发布通道封死（发布只能从 KuroProtocol 出）。
  3. `docs/protocol/peer-guide.md` 退位为迁移指针（权威 = KuroProtocol/docs/peer-guide.md），
     正文不再于本仓维护（原正文停留 0.3.1 时点且版本行漂移）。
  4. 阶段 2（待办）：KuroProtocol 发布 0.4.0 + deprecate npm 0.1.0 后，删除本仓镜像与门禁，
     `bridge/core` / `bridge/embedded` / `platforms/be/lse` 三消费方由 `workspace:*` 切
     `^0.4.0`（命令清单见 KuroProtocol ADR-001；ADR-018 的「依赖发布版本」原则由此补全）。
- **理由**：单点权威唯一可编辑来源需要机械强制而非口头声明；镜像冻结保留构建链零改动
  （workspace 解析、esbuild/tsdown 顺序全不动），门禁把「在主仓改协议」从惯例违规变成
  pre-commit 红灯。
- **回退条件**：阶段 2 完成前若 KuroProtocol 工作区形态解除（如 CI 需要单仓自包含），
  可回退本 ADR（revert 对应提交，恢复副本为权威）；阶段 2 完成后回退无意义。

> 注（2026-09-18）：镜像文件数随 KuroProtocol bb9f936 同步增至 9 个（新增 `fixtures.ts`），门禁语义不变。
> 注（2026-09-18）：结论 4 的阶段 2 已于本日执行完成（三消费方依赖切 `^0.4.0`、镜像目录
> `bridge/protocol/` 与 `check:protocol` 门禁删除、`check-versions` 协议族锚点换源为已安装
> npm 包清单 version），实施裁决与提交链见 ADR-035。

## ADR-032 恢复 CI：TS + Java 双 job（2026-09-18）

- **背景**：ADR-017 剔除 CI 的前提（单人单机、本地命令与 CI 内容一致）已不成立：全部
  门禁只存在于开发者本机的 lefthook pre-commit——换机、漏装 hook 或 `--no-verify` 即
  裸奔；`gradlew build`（Java 侧回归）不在任何自动化链，TS 门禁对 Java 回归不可见；
  `platforms/be/lse` 有独立 tsconfig 但没有任何脚本对它跑 typecheck。姊妹仓
  KuroProtocol 已立同构 CI（2026-09-17），满足 ADR-017 的回退条件（需要干净机器构建
  验证 / 并行长程开发）。
- **结论**：新增 `.github/workflows/ci.yml`，双 job：
  1. **ts job**：检出本仓 + **姊妹仓 KuroProtocol 为兄弟目录**（`check-protocol-mirror.mjs`
     以 `../KuroProtocol` 定位 SSOT；两仓均 public，免 token）→ `pnpm install
     --frozen-lockfile` → `pnpm check && pnpm test && pnpm -r build && pnpm check:protocol`
     （与本地 pre-commit 同构；check 链含 lse typecheck 与 docs 门禁）。
  2. **java job**：检出本仓 → mise（root `mise.toml`：java 25 / node 26）→ `platforms/je`
     下 `./gradlew build`（含 `:core` 全部 JUnit 用例、Spotless、`-Xlint:all -Werror`）。
     Java 回归从此对全仓门禁可见。
- **语义注记**：CI 对 KuroProtocol 取其默认分支 HEAD——上游协议演进而镜像未同步时 CI
  变红**属预期**（与本地 pre-commit 同语义：红 = 提醒按 KuroProtocol
  `docs/MIRROR-RESYNC.md` 同步镜像），不是误报。
- **理由**：门禁的价值在不可绕过；pre-commit 是约定级，CI 是机器级。本仓门禁口径
  （ADR-031 起）是「一条命令 + 处处同构」，CI 复用同一命令链而非另立脚本，无第二权威。
- **回退条件**：删 workflow 文件即回到 ADR-017 状态。

> 注（2026-09-18）：CI 结构其后经 ADR-035 结论 4 简化——去姊妹仓兄弟检出与镜像门禁
> （上文 CI 描述为历史口径），ts job 链 = `pnpm check && pnpm test`（check 自含 build 首环）。

## ADR-033 封死 bridge/core 与 bridge/embedded 的 npm 发布通道（2026-09-18）

- **背景**：ADR-031 的悬案处置只封了 protocol 包（版本回滚 0.0.0 + `private: true`）。
  `bridge/core` / `bridge/embedded` 的 package.json **无 `private`**——`npm publish` 通道
  敞开，且两包版本轴停留在无维护语义的 0.0.0。本仓对外分发面唯一 = Paper JAR（embed
  打包）+ 协议 npm（只从 KuroProtocol 出）；core/embedded 若被误发，将复刻 0.1.0 误发
  事故（ADR-031 背景）并制造第二分发面。
- **选项**：加 `private: true` 封死 / 维持现状作为未来消费伏笔 / 正式发布维护。
- **结论**：两包 package.json 加 `"private": true`（对齐根包与 `platforms/be/lse` 根包
  的既有做法，ADR-030）。
- **理由**：敞开的发布通道是事故面不是能力——决策可逆（新 ADR 推翻本条再摘除），误发
  不可逆。若未来需要以 npm 包消费 `bridge-core`（如 KuroAdapter-Pure 线），正确路径是
  先立发布决策（版本轴、exports、types 全套）再开通道，而不是留一个无人维护版本轴的
  敞口。
- **回退条件**：出现明确的 npm 消费方时，新 ADR 推翻本条。

## ADR-034 可观测性收敛：行格式契约、级别映射单一解析点、server.id / 版本单点（2026-09-18）

- **背景**：可观测性口径散乱——(1) Node 侧 stderr 有两份字节级相同的 writer
  （`bridge/embedded/src/index.ts` 的 `log()` 与 `src/logger.ts`）；(2) Java 中继两路
  降级：`KuroBridgePlugin.relayIpcLog` 只识别 3 个前缀，`NodeRequestHandler.onStderrLine`
  更把 Node 子进程全部 stderr（含 `[KuroBridge][node][error]`）无条件按 INFO 中继——
  WS 绑定失败、napuketto 意外退出等 error 级日志在服务器控制台全部显示为 INFO；
  (3) `SERVER_ID = "kurobridge-spike"`（原型残留）与 `VERSION = "0.1.0"` 硬编码在
  index.ts，经 hello_ack 上报对端；"0.1.0" 另有 root package.json / paper-plugin.yml /
  gradle（两处）共四处手写，无机械对齐。
- **结论**：
  1. **Node 侧行格式契约（唯一家族）**：`[KuroBridge][node][LEVEL] message`，
     `LEVEL ∈ {debug, info, warn, error}`（小写）。唯一 writer =
     `bridge/embedded/src/logger.ts`（`index.ts` 的本地 `log()` 废除收编）。napuketto
     原始行以 `[napuketto] <原样>` 作为 message 体包进该家族（现状保持），级别字样
     正则补 `FATAL → error`。**例外登记**：stub 假对端的 `[KuroBridge][stub]`（无
     LEVEL 段）保持原样——开发期 `KUROBRIDGE_STUB_PEER` 工件，不属运行期契约面。
  2. **Java 侧级别映射（单一解析点）**：`:core` 新增平台无关工具类
     `IpcLogLevels.parse(String) -> java.util.logging.Level`，`relayIpcLog` 与
     `onStderrLine` 一律走它。映射表：`[KuroBridge][node][error]` → SEVERE、
     `[warn]` → WARNING、`[info]` → INFO、`[debug]` → FINE；`[NodeIpc]`/`[NodeSupervisor]`
     的 `[WARN]` → WARNING、`[SEVERE]` → SEVERE；未识别前缀 → INFO（保守默认，不丢行）。
  3. **server.id（消除 spike 残留）**：config 顶层可选段 `server: { id?: string }`
     （形状 SSOT 归 core zod，先例 ADR-028/029），缺省 `"kurobridge"`；embedded 引导层
     注入 `CoreContext.serverId`（hello_ack 上报）。`SERVER_ID` 常量删除。
     「serverId 多实例互联」全案仍是债务（STATUS 索引），本条只清残留。
  4. **版本单点 + 机械对齐**：`bridge/embedded/src/version.ts` 导出
     `BRIDGE_VERSION = "0.1.0"`——hello_ack version 的唯一上报源（`VERSION` 常量
     删除；bridge/embedded package.json 版本轴 0.0.0 → 0.1.0 对齐）。新增零依赖门禁
     `toolings/gates/check-versions.mjs`（挂 check 链）断言两族一致：六点 "0.1.0"
     （root package.json / bridge/embedded package.json / src/version.ts /
     paper-plugin.yml / platforms/je/build.gradle.kts 两处）＋ 协议两份
     （`bridge/protocol/src/meta.ts` ≡ `KurobridgeVersions.java` 的 PROTOCOL_VERSION）。
  5. **status 周期上报（债务设计草图，不实施）**：事件驱动（join/quit 即时推送）保留，
     叠加周期兜底——Java 侧定时器（默认 30s，`runtime` 段可调）经 IPC 事件帧推 status
     快照（在线数 / TPS），core 广播给已绑定对端；协议增量走 KuroProtocol 四件套
     （新事件帧 + peer-guide + fixtures + changelog）。排期随 MVP-2 评估。
- **理由**：行格式先立契约再收编，Java 侧不再各自猜前缀（一处解析、一处测试，`:core`
  平台无关可测）；版本与身份的「单点常量 + 机械对齐」优于运行期读 package.json
  （esbuild 单文件 bundle + JAR 嵌入布局不含 package.json，读取脆弱）与构建期注入
  （生成文件引入新漂移面）——对齐失败在 check 链红灯，而非运行期缺省。
- **回退条件**：行格式如需演进（加时间戳/结构化字段），修订本条契约表并同步
  `IpcLogLevels` 与 logger.ts（两侧同改 + 测试），不允许局部漂移。

## ADR-035 门禁链 build 前置 + 协议镜像退役实施裁决（ADR-031 阶段 2）（2026-09-18）

- **背景**：CI 首跑（run 35358367694，commit 86a698a）TS job 红：`pnpm check` 爆
  34 条错误——TS2307 ×20（`@kuro-bridge/protocol` 8 + `@kuro-bridge/bridge-core` 12）、
  TS7006 ×14（全部级联）。根因实证：全仓无 tsconfig paths / project references，
  workspace 包类型解析走 node_modules symlink → 包 exports.types → `dist/index.d.mts`，
  而 `**/dist/` 全部 gitignored；CI 门禁链 `check → test → build → check:protocol`
  在 install 后无任何构建步骤。本地复现实锤：隐藏 `bridge/core/dist` 与
  `bridge/protocol/dist` 后 `pnpm check` 复现同样 34 条、首错逐字一致——check
  链（与 test：vitest 对两包有运行时值导入，走 exports.import → dist/index.mjs）
  隐式依赖 gitignored 陈旧构建物。同时 ADR-031 阶段 2 窗口开启：
  `@kuro-bridge/protocol@0.4.0` 已发布（npm dist-tag latest，2026-09-18T11:17Z）、
  0.1.0 已 deprecate、tag v0.4.0 已推。本 ADR 裁决修复与退役的全部门禁口径，先文档后代码。
- **结论**：
  1. **链序：build 内聚 check 首环**。根 `check` script 改为
     `pnpm -r build && biome check . && tsc --noEmit && tsc --noEmit -p platforms/be/lse
     && pnpm check:docs && pnpm check:versions`；CI 门禁链 step 简化为
     `pnpm check && pnpm test`。check 语义升级为「先构建发布物，再在发布面
     （exports.types → dist d.ts）上做全部静态校验」——单一权威：fresh clone 直接
     `pnpm check` 自足全绿，CI / lefthook / 本地全继承，链序不在三处各写一遍。
     **实施注**：lefthook 因 build 入 check 首环而与并行 test 钩子产生 dist 清空竞态
     （实锤：vitest 在 tsdown clean 窗口报 `Failed to resolve entry`），同提交将
     pre-commit `parallel: true` → `false` 串行化，链序 = check（自含 build）→ test。
  2. **协议导入纪律：biome `noRestrictedImports` 改写保留，不删**。patterns 维持
     `**/protocol/src/**` + `**/protocol/dist/**`（镜像死后自然落在
     `node_modules/@kuro-bridge/protocol/` 深路径上），message 改写为 npm 语义。
  3. **check-versions 协议族新锚**：期望值 = 已安装包清单
     `bridge/core/node_modules/@kuro-bridge/protocol/package.json` 的 `version`
     （复用现有 `jsonVersion()` 助手）；比对对象不变（`KurobridgeVersions.java` 的
     `PROTOCOL_VERSION`）。锚文件缺失时报错文案须指向「协议依赖未安装或消费方未声明」。
     bridge 六点族（期望值 = 根 package.json version）不动。
  4. **CI 简化**：删 ts job 的 KuroProtocol 兄弟检出 step 与 ci.yml 顶部镜像语义注记
     （镜像门禁删除后其唯一消费者即消失）。safe.directory 无需手动配置
     （actions/checkout 默认 set-safe-directory: true）。
  5. **风险与缺口登记**：① pnpm `minimumReleaseAge`（1440 分钟）可能拦截发布不足
     24h 的新依赖解析——切换时实测，若被拦则在 pnpm-workspace.yaml 加
     `minimumReleaseAgeExclude: ["@kuro-bridge/protocol"]`（自家已审发布，防线不适用）；
     **实施注**：实施时已在 pnpm-workspace.yaml 顶层预置
     `minimumReleaseAgeExclude: ["@kuro-bridge/protocol@0.4.0"]`，防将来显式配置
     minimumReleaseAge 时 strict 闸门拦截；
     ② `bridge/embedded` 的 exports.types 指向不存在的 `dist/index.d.mts`（esbuild
     只产 mjs）为预存缺陷，当前无人导入该包故未爆，登记 STATUS 缺口、本线不修；
     ③ stub `peer.mjs` 的 `PROTOCOL_VERSION = "0.3.1"` 为有意落后一档（兼容区间验证），
     非漂移，禁顺手升级。
- **理由**：否决 tsconfig paths → src 方案的四条：① 镜像删除后协议 src 不在仓内
  （npm 包只发布 dist d.ts），paths 无法统一覆盖两类依赖，必然形成「本仓包走 src、
  npm 包走 dist」双轨解析，check 校验语义分裂；② paths 映射 src 绕开包 exports
  边界——发布面（exports 只暴露 "."）失去类型层校验意义，恰是 noRestrictedImports
  一直防的「深路径导入」的类型版；③ vitest 运行时值导入不走 tsconfig，paths 只修
  类型层，test 门禁依旧隐式依赖构建物——问题只修一半；④ paths 表逐包手工维护，
  每新增 workspace 包都要登记，与机械联动纪律相悖。build 前置让校验对象 = 发布面，
  与「npm 消费方拿到什么就校验什么」同构；锚点选 package.json version 而非 dist
  d.ts 正则，因产物文本格式随构建器波动，而包清单 version 由 KuroProtocol 发布侧
  `scripts/assert-version.mjs` 机械断言等价于协议版本（0.4.0 实证对齐）；biome
  窄规则保留作解析器无关的第二道闸（lse 走 bundler 解析，工具链演进不保证 exports
  机械强制），纵深防御零运行成本。代价：每次 check 一次全量构建（本仓 4 个 TS 包，
  秒级），可接受。
- **回退条件**：镜像与门禁整体复活 = `git revert` 本 ADR 的实施提交序列（依赖切换 /
  镜像删除 / 门禁重接，Conventional 一一对应）；单点复活
  `git restore --source=<镜像删除提交>^ -- bridge/protocol scripts/check-protocol-mirror.mjs`
  后按 ADR-031 时代挂点恢复 package.json / lefthook.yml / ci.yml。若 KuroProtocol
  发布纪律变化（包内不再随附 d.ts，或 assert-version 断言废除），第 3 条锚点选择须重审。

## ADR-036 主仓金样本 fixture-driven 机器检查（双层）与 embedded exports 悬空指针闭环（2026-09-19）

- **背景**：三阵营金样本消费矩阵在主仓缺角——KuroProtocol 是源（`src/fixtures.test.ts`
  全语义自检 + 包级三方校验脚本）、KuroAdapter-Pure 有 `FixtureConformanceTest.java`
  （SHA256SUMS 内容守卫 + 7 份行为级回放）、koishi 对端有 `golden.fixtures.test.ts`
  （包内 fixtures + validateFixture + SHA256SUMS 双向完整性）；主仓自镜像退役
  （ADR-031 阶段 2）后对 `@kuro-bridge/protocol@^0.4.0` 的金样本（包内
  `fixtures/v0.4`，16 份）检查为零——协议在本仓只以 npm 包形态存在，消费正确性无机器
  防线。同批登记小洞：`bridge/embedded` 的顶层 `types` 与 `exports["."].types` 指向
  不存在的 `dist/index.d.mts`（esbuild 只产 mjs，无 dts 能力；ADR-035 结论 5② 登记
  「本线不修」，且其承诺的 STATUS 缺口登记实际未落地）。本 ADR 先文档后代码。
- **选项**：① 深度——a) 契约级（16 份 validateFixture + SUMS 校验，对齐对端深度）/
  b) 行为级（server 类回放 fixture 帧、断言 reply 等价与 close code/reason，对齐 Pure
  深度）/ c) 双层；落点——`bridge/core` 测试 / 独立 scripts 第二入口。② exports.types
  ——移除悬空指针 / tsc emit dts / 换 tsdown 出类型。
- **结论**：
  1. **双层、单文件、单一入口**。新增 `bridge/core/src/__tests__/golden.fixtures.test.ts`
     （命中现有 vitest include，进 `pnpm test` 基线；`pnpm check` / `pnpm test` 形状
     不变，不立任何第二门禁入口）：
     - **契约层（16 份全量）**：包根经
       `createRequire(import.meta.url).resolve("@kuro-bridge/protocol")` 上溯定位
       （对端同款；fixtures 不经 exports 暴露，以文件读取消费）；版本目录由包导出
       `PROTOCOL_VERSION` 推导（`v主.次`）并断言 fixtures 根下唯一版本目录；
       SHA256SUMS 双向完整性（行格式严格两空格、逐行实算比对、盘上未登记文件必须为
       空）；逐份 `validateFixture`（消费包导出，不重复实现 schema）。
     - **行为层（动态发现）**：对 `expect.behavior` 可观测（reply 或 close 非 null）
       的样本逐份回放——`KurobridgeServer` + `FakeWsServer` / `FakeWsConnection` /
       `manualTime`（复用 `test-fakes.ts`，非 hello 样本先内联握手），断言 reply 帧
       与金样本 `frames[N]` JSON 全等、close code/reason 精确一致；行为层覆盖数下限
       7（= Pure 现状地板，防覆盖静默缩水）。
  2. **移除 embedded 的悬空 types 指针**（顶层 `types` 与 `exports["."].types` 两处；
     指向真实产物的 `main` / `import` 不动）；不产 dts、不换构建器；同步以已闭环形态
     补记 ADR-035 5② 承诺的 STATUS 缺口条目。
  3. **基线数随实施同步 STATUS**（用例数与文件数，docs↔code 机械联动）；新检查有效性
     按纪律以「篡改即红」实证（改 node_modules 内包 fixtures 副本必须红，验后还原，
     收尾独立复核执行）。
- **理由**：契约级只复刻对端已有深度，主仓作为 server 实现的真缺口是行为级——协议仓
  有意不做行为实跑（执行责任在消费方），Pure 已证 16 份中 7 份可观测可回放；双层同
  文件保单一权威，动态发现让新增金样本自动纳入行为层，落 `bridge/core` 是被测实现
  所在，vitest include / 根 tsc / biome 自动纳管零配置。悬空指针删除优于补产：grep
  实证全仓零 import 该包名（JAR 消费走 `toolings/packaging/embed.ts` 物理路径直读
  `dist/index.mjs`，完全绕过 exports，private 语义 ADR-033）；tsc emit 的 `.d.ts`
  与 exports 指向的 `.d.mts` 文件名对不齐；换 tsdown 则动 733KB JAR bundle 形状
  （createRequire banner、ADR-035 串行链序均围绕 esbuild 落定），风险与收益不对称。
  ADR-033 已锁「未来开 npm 通道前先立 exports/types 全套发布决策」——悬空指针恰是
  该条款要防的敞口形态，删除即诚实态。
- **回退条件**：主仓行为层若与金样本断言冲突（reply 形状 / close reason 措辞等），
  分歧本身是发现——逐条登记报协议仓主权（金样本冻结），不得为绿灯放宽断言；确属主仓
  实现缺口的修主仓。未来出现以包名 import `@kuro-bridge/bridge-embedded` 的 TS 消费
  方时，按 ADR-033 先立发布决策再补 types（即撤销本条结论 2）。

## ADR-037 lse 平台角色裁决：R2′「WS 回环薄壳」——QuickJS 壳 + 本包 Node shim 宿主 kurobridge 服务端（2026-09-19）

- **背景**：`platforms/be/lse` 落地线预勘察矛盾成立——包级 design.md 原方案「复用 core 客户端接入
  kurobridge WS 服务端」两头不存在：core 导出全集无任何客户端类（`transport.ts:25`「kurobridge 永远
  是 WS 服务端角色，ADR-005」），LSE 类型包亦无 WS 服务端/TCP 能力。任务书 R2（脚本薄壳 +
  `system.newProcess` 管道）的成立前提被类型包声明层实证否死：`newProcess` 返回 `boolean`，无
  Process 对象、无 stdin/stdout、回调仅进程结束后一次性回传（`@levimc-lse/types@2.18.7`
  SystemCall.d.ts:40-51）；R3（进程内跑 core + 适配传输层）被同证否死（`HttpServer` 无 WS upgrade，
  适配即改 core，违 ADR-007）；R1（平台侧建服务端）破坏 ADR-005 且需 koishi 侧/独立 hub 新能力
  （跨仓超线）。证据册（角色拓扑 SSOT）：`platforms/be/lse/docs/role-adjudication.md`。
- **选项**：R1（否决，见背景）/ R2（否决：管道不存在）/ R3（否决：无服务端 socket）/ R2′（侦察
  新增：保留 R2 骨架，宿主↔node 通道换回环 WS）。
- **决策**：采纳 R2′——(1) QuickJS 壳只做事件桥接与传输：`mc.listen` 四事件 → IPC 方言 JSON 帧
  （KuroProtocol 0.4.0 现成 schema + `encodeFrame`）→ `WSClient` 发往 127.0.0.1 回环游戏通道；
  (2) Node shim 为 lse 包内代码（`src/runtime/`），经 `newProcess` fire-and-forget 拉起，复用 core
  导出面（`KurobridgeServer`/`Relay`/`CoreContext`/`parseConfig`/`defaultConfig`）+ core
  `WsServer`/`IpcChannel` 接口的本包实现（ws 包 / 游戏通道门卫：单租户、首帧会话令牌，错 1008），
  对 koishi 提供真 WS 服务端；(3) 生命周期脐带：已鉴权游戏通道断开 ⇔ shim 自杀（等价 JE stdin-EOF，
  D-08）；壳内看护器对齐 JE NodeSupervisor（ready 30s、退避 1/5/15s、10 分钟窗 3 次放弃、
  `kurobridgeretry` 手动恢复）；(4) 部署契约与 paper 同目录：`<BDS 根>/plugins/kurobridge/`
  （plugin.json + index.js + bin/node.exe + bin/index.mjs）。ADR-005 不变量保持：WS 服务端仍由游戏侧
  部署体宿主（shim 是壳拉起的子进程，与 JE 的 node 子进程同位），koishi 仍是 WS 客户端；
  `bridge/**` 零改动；协议无新增线上词汇（仅新增「IPC 方言 over WS text frame」传输绑定）。
- **理由**：R2′ 是唯一同时满足「不变量全保（ADR-005/007、协议 SSOT、领地）+ 类型包实证可落地」的
  路线；拓扑与 JE 全同使降级/看护语义逐条可对齐（差异在册：`status` 帧不做——无 TPS API 不造假
  数据；死亡文案恒空串——`onPlayerDie` 无文案参数；`config_reload`/`shutdown` 帧不做——无触发点，
  通道断开兜底；无 kill API——node 卡死等脐带或人工）；node 侧不复用 bridge/embedded bundle
  （入口 import 即自跑 + stdin EOF 自杀，不可作库），但业务零复制（core 导出面装配）。
- **回退条件**：真机背书推翻待真机清单前提（尤其 `newProcess` 参数串 quoting/argv 切分、`WSClient`
  回环与回调线程语义、`ll.getCurrentPluginInfo().filePath` 取值）→ 本 ADR 作废重裁，回到 R1 停线
  预案交用户拍板；ws 包子协议握手门禁在 ws 8.21 不真正拒绝连接为 bridge 家族缺陷（embedded 同款），
  修复归属 bridge 家族统一裁决，不随本 ADR 在 lse 单方面收敛。
