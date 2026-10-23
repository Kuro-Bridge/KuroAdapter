# 决策台账（ADR-001 ~ ADR-037）

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
