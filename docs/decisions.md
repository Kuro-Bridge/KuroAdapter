# 决策台账（ADR-001 ~ ADR-042）

只保留结论与理由。代码注释中的 ADR 编号以本表为准；KuroProtocol 仓另有独立的 ADR-001~003 序列，与本表**无编号对应关系**。

## 架构与工程

| 编号 | 日期 | 结论 | 理由 / 状态 |
| --- | --- | --- | --- |
| ADR-001 | 2026-08-10 | 单仓 monorepo（Java / TS / 平台适配同仓） | 协议与消费方一个 PR 原子改；跨仓联动成本高 |
| ADR-002 | 2026-08-10 | Java 21 LTS，字节码 target 21 | Paper 运行时基线；虚拟线程适合长连接 |
| ADR-005 | 2026-08-10 | 业务核心移入 Node，Java 退化为平台薄壳 | 开发量 90% 在 TS；薄壳只做 API 桥接 |
| ADR-006 | 2026-08-10 | external 形态也拉起 Node 业务核心 | 业务在 Node；两种形态只差协议端是否随包 |
| ADR-007 | 2026-08-10 | `bridge/core` 平台无关：零 Node API，传输/logger 注入，target ES2020 | Node / QuickJS 双端复用；`erasableSyntaxOnly` 保证 QuickJS 可跑 |
| ADR-009 | 2026-08-10 | pnpm workspace + Gradle，不引 nx/turbo | 包数量少，缓存收益为负 |
| ADR-010 | 2026-08-10 | 平台薄壳 ↔ Node 用 stdin/stdout JSON-lines | 零端口零配置；避免本地端口冲突 |
| ADR-011 | 2026-08-10 | Java 第一版不上 Error Prone / NullAway | 薄壳定型后再评估；Spotless + `-Xlint:all -Werror` 已够 |
| ADR-012 | 2026-08-10 | LSE 走 TS：源码编译为 JS 后由 LeviLamina 加载 | QuickJS 不原生跑 TS；`erasableSyntaxOnly` 保证产物可直接执行 |
| ADR-013 | 2026-08-10 | 测试栈：vitest（TS）+ JUnit 5（Java）+ ctest（C++） | 与各语言生态原生工具对齐 |
| ADR-014 | 2026-08-10 | 嵌入式打包沿用 Napuketto 许可方案：node 进 JAR，腾讯闭源件不进 | 运行期发现拷贝；构建期扫描断言兜底 |
| ADR-015 | 2026-08-11 | 工具链 Node 26 + Java 25；Java 字节码 target 21 | 新特性可用，运行时兼容 Paper |
| ADR-016 | 2026-08-11 | 运行时不用 Bun | 与 QuickJS / Node 生态及内嵌分发不一致 |
| ADR-017 | 2026-08-11 | 曾剔除 CI/CD | **已被 ADR-032 取代**（CI 已恢复） |
| ADR-018 | 2026-08-11 | koishi-plugin-kurobridge 独立仓库 | 平台渲染与 adapter 生态归对端；本仓不引 Koishi |
| ADR-019 | 2026-08-11 | `platforms/je` 多模块：一个服务端 = 一个模块 | `:core` 复用，适配层隔离 |
| ADR-020 | 2026-08-11 | BE 家族：LSE（TS）+ Endstone（C++ 薄壳）；剔除 Nukkit | 工具链匹配；PocketMine 不做 |
| ADR-021 | 2026-08-11 | JE 多版本策略：`:core` 版本无关，适配层按 MC 版本构建 | 改版本只重编适配层；fabric 当前单版本 1.21.4 |
| ADR-022 | 2026-09-13 | 内嵌协议端以孙进程形态由 Node 引导层拉起 | 协议端与业务核心进程隔离；崩溃经引导层退出交看护器重启，树杀避免 self-host 孤儿持锁 |
| ADR-032 | 2026-09-18 | 恢复 CI：ts + java 双 job（后续加 endstone） | 机器级复跑本地同一命令链 |
| ADR-033 | 2026-09-18 | `bridge/core` 与 `bridge/embedded` 标记 `private` | 封死误发 npm 通道；只有 protocol 发布 |
| ADR-034 | 2026-09-18 | 可观测性收敛：`[KuroBridge][node][LEVEL]` 行契约、`IpcLogLevels` 单一解析点、`server.id`、版本单点 | 修复 error 行降级 INFO 的事故；消除硬编码残留 |
| ADR-035 | 2026-09-18 | 门禁链 build 前置；协议镜像退役；版本锚改为已安装 npm 包 | 校验在发布面进行；消除仓内协议副本 |
| ADR-036 | 2026-09-19 | 主仓金样本 fixture-driven 双层检查；删除 embedded 悬空 `types` | 协议消费正确性有机器防线；诚实导出面 |
| ADR-038 | 2026-10-25 | Java 字节码基线降 8（`--release 8`，取代 ADR-002/015 的 target 21）：Paper 单 jar universal 覆盖 1.12.2 ~ 26.3。经典 `plugin.yml`（1.19.4+ 专属 `paper-plugin.yml` 弃用）；新增 `:paper-legacy` 模块隔离旧 Adventure 序列化器（`PlainTextComponentSerializer` → `PlainComponentSerializer` 兼容链）；`Compat` 运行期探测（`AsyncChatEvent` 有无 → 现代或 legacy 聊天监听，不双注册）；死亡/广播走全版本 String 路径；IPC 日志展示层剥传输前缀（`IpcLogLines`） | Paper 26.3 捆绑 Adventure 5.2 删除 `PlainComponentSerializer`，静态初始化失败致聊天/死亡监听全崩（QQ→MC 正常、MC→QQ 崩）；1.16.5/1.12.2 运行 Java 8，字节码与 SE API 双锁；ADR-034 传输契约不变，套娃前缀只在「中继到控制台」最后一跳剥离 |
| ADR-039 | 2026-10-25 | 消费 napuketto 0.2.0（`@napuketto/cli` 精确 pin 0.1.20 → 0.2.0）：宿主 env 钉 `NAPUKETTO_LOG_FORMAT=single-line` + `NAPUKETTO_NO_BANNER=1`；关停改「停止哨兵 `<数据根>/napuketto.stop`（内容 all）优先、taskkill 树杀兜底（10s 超时）」，哨兵路径恢复退出码展示（exit 0），树杀兜底仍不展示机制性 code=1；ANSI 剥离/QR 折叠/banner 丢弃/噪音表保留为防御层 | 上游 0.2.0 落地日志可配置化与优雅关停契约（NapukettoQQ PR #22）：非 TTY 自动 single-line 无色、默认级别重分配（校准/接收/mmkv 降 debug）源头降噪；子协议 `kurobridge-ws.v1` 与 PROTOCOL_VERSION 0.4.0 不变，仅自报身份变 `napukettoqq/0.4.0` |
| ADR-040 | 2026-10-25 | 配置面 JSONC 化：配置文件改 `plugins/kurobridge/config.jsonc`（严格 JSON 超集：行/块注释 + 行尾逗号，剥离输出与输入等长保行号）；首启生成带注释模板并写入 32 位 hex 随机 token（全形态，对齐 Pure 线）；旧 `config.json` 回退读取、不迁移不重命名；模板形状由「parseJsonc + parseConfig 回环」单测锁死 | 生成件即文档——裸 JSON 无引导，服主一头雾水；等长输出让 JSON.parse 报错行号直接定位手改处；回退而非迁移，避免首启意外改写服主已有文件；解析器放 bridge/core（零 Node API，LSE QuickJS 共用）；解析失败仍走降级运行不变 |
| ADR-041 | 2026-10-25 | embedded onboarding 闭环与退出码契约：`embedded.napuketto.qq/logLevel` 上浮主配置，连接参数（url/token）由宿主按内嵌 CLI 版本注入——支持 `NAPKETTO_CONFIG_JSON`（0.3.0+）走内联，旧版回退 `NAPKETTO_CONFIG` + WARN（面向上游 fix4 契约编程，不写过渡 TOML 生成器）；Node 退出码收敛为 0 优雅 / 1 可重试 / 2 配置未就绪（`CONFIG_NOT_READY_EXIT_CODE`），上游 napuketto `exit 78` 映射 2；:core 看护器对 exit 2 进入 blocked-on-config 终态（不计窗、不退避、单条 SEVERE 指路）；NodeIpc EOF 后有界等待真实退出码、退出通知先于 start future 失败完成、观察到退出即清 pid 文件 | 配置守卫 fatal 走退避重启是纯风暴（占位 qq → 3 次重试同败刷屏）；stdout EOF 先于进程状态翻转曾致看护器只见「exit=未知」，识别不了契约；`managed:false` 逃生门不设（高级用法走 external 形态）；paper/fabric/lse 命令文案同步区分「配置未就绪」与「反复崩溃」 |
| ADR-042 | 2026-10-26 | 首个公开发版 1.0.0 与产物分层：主仓与纯净线同版；Paper / Fabric 为正式产物，LSE / Endstone 标注预览（真机联调未完成）；新增 `pnpm release:pack`（`toolings/packaging/release.ts`）收拢四类产物 + `SHA256SUMS.txt`，打包期校验嵌入清单 sha256、JAR 必需条目与腾讯闭源件红线；版本以 `v<version>` tag 与 GitHub Release 发布，`CHANGELOG.md` 按版本记录 | 发布前无 tag、变更日志与分发件，服主只能自行构建；预览标注避免把 ABI 构建成功当成行为背书；校验放在打包期而非构建期，保证上传的字节就是被校验的字节 |

## 协议

| 编号 | 日期 | 结论 | 理由 / 状态 |
| --- | --- | --- | --- |
| ADR-003 | 2026-08-10 | 协议 `kurobridge-ws`，双层版本：WS 子协议大版本 + `hello.protocolVersion` 小版本 | 不兼容在握手期尽早暴露。协议代号原 `kurobot-ws`，由 ADR-030 改为 `kurobridge-ws` |
| ADR-004 | 2026-08-10 | 绑定频道随 `hello_ack` 下发；运行期变更推 `bindings_updated` | 对端无需读配置即可发现频道。代码现状：`hello_ack.channelBindings` + 全量推送 |
| ADR-008 | 2026-08-10 | 协议 SSOT 用 zod | schema 即产物，`safeParse` 可直接校验；零依赖，QuickJS 可跑 |
| ADR-023 | 2026-09-13 | 握手收敛为单程 `hello` + `hello_ack` | 去掉双向 hello 的冗余状态 |
| ADR-024 | 2026-09-13 | 协议包常驻解析层：线格式 → 扁平消息 | 线格式不变，消费方好收窄类型 |
| ADR-025 | 2026-09-13 | WS 与 IPC 统一帧格式与 UUID 规则，`*_result` 显式响应 | 一套编解码、一套关联逻辑 |
| ADR-026 | 2026-09-13 | 版本协商改主版本兼容区间；未知帧两段式容忍 | 小版本可前向兼容；未知帧不断连 |
| ADR-027 | 2026-09-13 | 白名单 SSOT 归 MC 原生 `whitelist.json` | 插件不维护第二份白名单；命令透传即可 |
| ADR-028 | 2026-09-13 | external 基座：`config.ws` 监听段、绑定失败交看护器、空 token WARN | 固定端口可配；失败不新增重试机制 |
| ADR-029 | 2026-09-14 | embedded：napuketto CLI 嵌包、固定端口强制、文件式 QR 交接、taskkill 树杀 | 平台端自带、开箱扫码；树杀避免孤儿持锁 |
| ADR-030 | 2026-09-14 | 品牌 KuroBot → KuroBridge，协议 0.4.0 | 唯一 breaking 是子协议字符串，帧形状零变化；one-name-only 不迁移 |
| ADR-031 | 2026-09-16 | 协议 SSOT 移交 KuroProtocol，本仓只经 npm 消费 | 跨仓契约单一来源。阶段 1 的只读镜像已由 ADR-035 退役 |
| ADR-037 | 2026-09-19 | LSE 采用 R2′「WS 回环薄壳」：QuickJS 壳 + Node shim 宿主 core | LSE `newProcess` 不暴露 stdio；帧方言与生命周期语义不变 |

## 已失效 / 被取代

| 编号 | 原结论 | 现状 |
| --- | --- | --- |
| ADR-017 | 剔除 CI/CD | 由 ADR-032 恢复 |
| ADR-031 阶段 1 | 协议镜像目录 + 镜像门禁 | 由 ADR-035 删除，改为 npm 依赖 |
