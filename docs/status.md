# 项目现状

> 以当前代码为准（最后核对 2026-10-23）。产品版本 `0.1.0`，协议 `0.4.0`。

## 版本基线

| 项 | 值 |
| --- | --- |
| bridge | `0.1.0`（根 package / embedded / paper-plugin / Gradle 六点对齐） |
| 协议 | `0.4.0`（`@kuro-bridge/protocol`，主版本兼容区间 `0.x`） |
| 内嵌 Node | `26.7.0`（win-x64） |
| napuketto | `@napuketto/cli` 0.1.20（精确 pin） |
| Java | 工具链 25，字节码 target 21 |
| Fabric | MC 1.21.4 / loader 0.19.5 / fabric-api 0.119.4 |
| Endstone | API v0.11 补丁线（CMake FetchContent） |

## 平台支持

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Paper | ✅ 可用 | 四事件 + status、命令、热载、embedded/external、JAR 自含运行时 |
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

## 下一步优先级

1. LSE / Endstone 真机联调，收敛平台前提清单。
2. Fabric 多版本矩阵与权限门（fabric-permission-api）。
3. 协议流式回报与 status 周期上报（需 KuroProtocol 先行）。
4. 多平台 Node 分发与 JAR 体积优化。
