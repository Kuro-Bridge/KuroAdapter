# 项目现状

> 以当前代码为准（最后核对 2026-10-26）。产品版本 `1.0.0`，协议 `0.4.0`。

## 版本基线

| 项 | 值 |
| --- | --- |
| bridge | `1.0.0`（根 package / embedded / plugin.yml / Gradle 六点对齐） |
| 协议 | `0.4.0`（`@kuro-bridge/protocol`，主版本兼容区间 `0.x`） |
| 内嵌 Node | `26.7.0`（win-x64） |
| napuketto | `@napuketto/cli` 0.2.0（精确 pin；哨兵优雅关停 + single-line env 契约，ADR-039）。内联注入门槛 0.3.0+（ADR-041）：当前 pin 走 `NAPKETTO_CONFIG` 回退 + WARN，升级嵌包即转宿主托管 |
| Java | 工具链 25，字节码 `--release 8`（ADR-038 universal：1.12.2 ~ 26.3 单 jar） |
| Fabric | MC 1.21.4 / loader 0.19.5 / fabric-api 0.119.4 |
| Endstone | API v0.11 补丁线（CMake FetchContent） |
| 测试基线 | TS vitest 298 用例（25 文件）/ Java JUnit 90 用例（`:core` 84 + `:fabric` 6），2026-10-26 本地门禁 |

## 平台支持

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Paper | ✅ 可用 | universal 单 jar 1.12.2 ~ 26.3（ADR-038：兼容链 + 运行期探测 + 经典 plugin.yml）；四事件 + status、命令、热载、embedded/external、JAR 自含运行时。26.3（embedded 深验：命令四条 + napuketto 在线日志治理）/ 26.2 / 1.21.11 / 1.16.5（Java 16）四线真机冒烟通过；1.12.2 未上机 |
| Fabric | ✅ 首版 | 四事件 + status（TPS 自测）、命令；单 MC 版本；chat/权限有登记差异 |
| LSE | 🟡 已实现，待真机 | 壳 + shim + 回环 e2e 绿；`newProcess` 等平台前提待实机背书 |
| Endstone | 🟡 已实现，待真机 | portable 层 ctest 5/5；clang-cl dll 已构建；真机联调未做 |
| NeoForge / Velocity | ⬜ 骨架 | 仅 Gradle 模块，未实现 |

## 已具备的能力

- 双向聊天、进服/退服/死亡事件、状态快照。
- 绑定频道 fan-out；平台消息按绑定过滤。
- 群管理员映射 + 群指令执行（结果含输出行）。
- `status` / `bindings` 查询（core 本地作答）。
- token 鉴权、主版本协商、未知帧容忍、心跳/空闲检测。
- 配置热载（embedded：轮询 + `/kurobridge reload`）。
- 配置面 JSONC（ADR-040）：`config.jsonc` 支持注释与行尾逗号；首启生成带注释模板并写入 32 位 hex 随机 token；旧 `config.json` 回退读取、不迁移。
- onboarding 闭环与退出码契约（ADR-041）：`embedded.napuketto.qq/logLevel` 上浮主配置，连接参数按内嵌 CLI 版本注入（0.3.0+ `NAPKETTO_CONFIG_JSON` 内联，旧版回退 `NAPKETTO_CONFIG` + WARN）；Node exit 0/1/2，看护器对 exit 2 记单条 error 且不重启不退避；上游 napuketto exit 78 映射 2。
- embedded 形态：JAR 内 node + napuketto、固定端口、QR 文件交接。
- 看护器：1s/5s/15s 退避，10 分钟窗 3 次放弃，`autoRestart` 可关。
- 门禁：build 前置、biome、tsc、LSE typecheck、docs 口径/死链、版本对齐、金样本契约/行为。

## 已知缺口

### 协议 / 核心

| 缺口 | 影响 | 备注 |
| --- | --- | --- |
| `msgContinue` / `msgEnd` 流式回报未实装 | 长消息无法分段回传 | 协议无此帧 |
| `status` 非周期上报 | 在线数只在 join/quit 变化时更新 | 设计取舍，未排期 |
| 无 TLS/wss | 公网需隧道/反代 | 协议本身不做 |
| `serverId` 不参与路由/去重 | 同机多实例仅日志可辨 | 多实例互联未做 |
| 看护窗口/退避写死 | 不能按服调参 | 10 分钟窗 / 3 次 |

### 平台

| 缺口 | 影响 |
| --- | --- |
| `ws` 8.21 子协议不匹配不真正拒连 | 仅省略响应头；实际由 hello 版本协商拦截 |
| Paper 无 Bukkit 桥接单测 | 依赖沙盒验收 |
| Fabric 缺 relay 权限门、`/kurobridge` 为 op level 近似 | 无法按玩家静音 |
| Fabric 单 MC 版本、SERVER_STOPPING 早于玩家断开 | 多版本矩阵未做；关停时序有差异 |
| LSE 无杀子进程 API、无 status、无 reload、死亡文案恒空 | 卡死进程需等 BDS 退出/手动结束 |
| LSE 未纳入版本门禁 | `manifest.json` / `BRIDGE_VERSION` 需手动同步 |
| Endstone 无命令面、`bin/` 手动预置、tps=0.0 | 升级与运维靠 SOP；状态数据不完整 |
| Endstone 真机未联调 | ABI 构建成功 ≠ 行为已背书 |

### 打包 / 运维

| 缺口 | 影响 |
| --- | --- |
| Node 仅 win-x64 嵌包 | Linux/macOS 需自行提供 node |
| 内嵌 napuketto pin 0.2.0 无内联注入 | 内嵌形态回退 `NAPKETTO_CONFIG` + WARN，仍需手工 napuketto.toml；升级嵌包即启用宿主托管 |
| 旧版 CLI 配置校验失败仍 exit 1（非 78） | 内嵌形态（0.2.0）qq 占位模板会走三次退避后才放弃；exit 78→2 契约待上游发版 |
| napuketto 仅 Windows | wine / Linux QQ 宿主未支持 |
| JAR 约 48 MB，无分层下载/升级提示 | 分发体积大 |
| QR URL 正则 best-effort | napuketto 改日志文案会失效（PNG 路径不受影响） |
| quick-login 登录历史不稳定 | 每次重启可能需重扫码（napuketto 侧） |
| vanilla 命令输出捕获依赖 log4j 主线程窗口 | 并发混行理论风险 |
| `fake-player.ts` 无 play 态 keepalive | 仅 30s 验收窗 |

## 已收敛（不要重复报告）

- 协议镜像目录与镜像门禁已删除，统一 npm 消费（ADR-031/035）。
- `embedded` 包悬空 `types` 已删（ADR-036）。
- CI 三 job 已入库并绿（ADR-032/035）。
- Node error 日志降级 INFO 已修（ADR-034）。
- `kurobridge-spike` serverId 硬编码已清（ADR-034）。
- 版本六点/两份机械对齐、金样本契约/行为检查已入门禁。
- 腾讯闭源件扫描已是构建期硬断言。
- Paper 26.3 聊天/死亡监听崩溃已修（ADR-038：Adventure 5.2 删除旧序列化器，兼容链 + release 8 universal）；控制台 IPC 日志套娃前缀在展示层剥离，napuketto 多行记录（含 ANSI 色码形态）重组为单行、遥测噪音降 debug、banner/终端二维码折叠、关停日志收敛为单条。
- Paper 26.x vanilla 命令拒绝自定义 sender 的回退修复：异常类型随版本漂移（26.x 不再是 bukkit CommandException / IllegalArgumentException），判据改为消息链匹配（2026-10-25 cleanroom 实证，version/tps/list/kurobridge qr 四命令回执成功）。
- shadowJar 重复 META-INF 条目（Jackson 三件的 LICENSE/NOTICE）触发 Paper 1.20.5+ PluginRemapper 拒绝（经典 plugin.yml 的 api-version 1.13 触发重映射），已加 `duplicatesStrategy = EXCLUDE`（2026-10-25 Paper-1.21.11 实证）。
- napuketto 已消费 0.2.0（ADR-039）：宿主 env 钉 single-line + 关 banner，关停改停止哨兵优先（`<数据根>/napuketto.stop`）、树杀 10s 兜底，哨兵路径展示 exit 0；上游默认级别重分配后校准/接收/mmkv 噪音在源头即 debug，宿主侧降噪层保留为防御。协议面零变化（`kurobridge-ws.v1` / 0.4.0），自报身份 `napukettoqq/0.4.0`。
- 配置面 JSONC 化（ADR-040）：`jsonc.ts` 剥离器与 `config.jsonc` 注释模板在 `bridge/core`，embedded 与 LSE 共用；首启随机 token 落地，旧 `config.json` 回退路径有单测与集成测试覆盖。
- embedded onboarding 闭环（ADR-041）：qq/logLevel 上浮、按 CLI 版本内联注入/旧版回退、exit 0/1/2 契约、看护器 blocked-on-config（exit 2 不重启）、NodeIpc EOF 竞态修复与观察到退出即清 pid 文件；paper/fabric/lse 命令文案区分「配置未就绪」与「反复崩溃」。

## 下一步优先级

1. LSE / Endstone 真机联调，收敛平台前提清单。
2. Fabric 多版本矩阵与权限门（fabric-permission-api）。
3. 协议流式回报与 status 周期上报（需 KuroProtocol 先行）。
4. 多平台 Node 分发与 JAR 体积优化。
