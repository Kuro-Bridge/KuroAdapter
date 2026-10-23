# 开发指南

## 环境

| 工具 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 26（CI 与 `mise.toml`） | ESM；`package.json` 要求 `>=26` |
| pnpm | 11.6.0 | 版本由 `devEngines` 钉住 |
| Java | 25 工具链，target 21 | 仅 `platforms/je`；日常用 `gradlew.bat` / `./gradlew` |
| Gradle | 9.7（wrapper） | 不用全局 gradle |
| CMake / Ninja | ≥ 3.29 / 任意 | 仅 `platforms/be/endstone` |
| mise | 可选 | `mise install` 一次性装 node 26 + java 25 |

```bash
pnpm install
pnpm check        # 全量静态门禁（含构建首环）
pnpm test         # vitest
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm check` | `pnpm -r build` → `biome check .` → 根 `tsc --noEmit` → LSE `tsc --noEmit` → docs 两门禁 → 版本对齐 |
| `pnpm test` | vitest（bridge/*、platforms/be/*、toolings/**） |
| `pnpm fix` | biome 自动修复 + 根 tsc |
| `pnpm build` | `pnpm -r build`（core / embedded / lse） |
| `pnpm build:je` | `gradlew build`（编译 + Spotless + JUnit） |
| `pnpm build:endstone` | portable 层 configure + build + ctest |
| `pnpm build:all` | TS 全量 + JE + Endstone |
| `pnpm check:all` | `pnpm check` + `pnpm test` + 平台两侧（CI 三 job 本地合体） |
| `pnpm build:jar` | TS 构建 → embed 打包 → paper shadowJar → fabric remapJar |
| `pnpm check:docs` | 文档口径 + 死链两道门禁 |
| `pnpm check:versions` | bridge 六点 + 协议两份版本对齐 |

pre-commit（lefthook）串行跑 `pnpm check` → `pnpm test`（`parallel: false`，避免 build 清空 `dist` 与 vitest 解析竞态）。CI 的 ts job 复跑同一命令链；java job 跑 `gradlew build`；endstone job 跑 `core` 三连。

## 版本对齐

bridge 版本族（当前 `0.1.0`）共六点，改版本必须同改：

1. 根 `package.json` 的 `version`
2. `bridge/embedded/package.json` 的 `version`
3. `bridge/embedded/src/version.ts` 的 `BRIDGE_VERSION`
4. `platforms/je/paper/src/main/resources/paper-plugin.yml` 的 `version:`
5. `platforms/je/build.gradle.kts` 的根级 `version = "..."`
6. 同文件 `subprojects` 的 `version = "..."`

协议版本族共两份，锚点是**已安装 npm 包**的 version：

1. `bridge/core/node_modules/@kuro-bridge/protocol/package.json` 的 `version`（实际安装版本）
2. `platforms/je/core/.../KurobridgeVersions.java` 的 `PROTOCOL_VERSION`

LSE 的 `plugin.json` / `BRIDGE_VERSION` 与 Endstone 的插件版本当前**不在**门禁内，改动需手动同步。

## 代码规范

### TypeScript

- 缩进 4 空格、LF、双引号、分号、尾逗号、行宽 100。
- 严格全家桶：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`erasableSyntaxOnly`、`noUnusedLocals/Parameters`、`noFloatingPromises`、`noExcessiveCognitiveComplexity(15)`。
- 类型导入一律 `import type`；禁止 `any`（例外必须注释原因）。
- 协议导入只允许包名入口：`import { ... } from "@kuro-bridge/protocol"`；深路径被 `noRestrictedImports` 拦截。
- `bridge/core` 不碰 Node API，也不直接用 `setTimeout` / `Date.now`（走注入的 `Clock` / `TimerScheduler`）。
- 业务错误抛类型化错误（`ConfigError` / `IpcRequestError`），不静默吞掉。

### Java

- `-Xlint:all -Werror`；Spotless Palantir 2.71.0。
- `:core` 零 Bukkit API；`:paper` / `:fabric` 零业务。
- 回调在 IPC 读取线程触发，必须 `runTask` / `server.execute` 回主线程；回执要显式（失败也要回，避免 Node 等到超时）。
- 日志级别统一走 `IpcLogLevels.parse`，不要在各处猜前缀。

### C++（Endstone）

- C++20；portable 层（`src/core/`）零 endstone 依赖。
- Win32 细节只放 `.cpp`；头文件保持可移植。
- 错误用返回值/异常显式上报，不静默吞。

## 测试

- 单元测试与源码相邻：`src/**/*.test.ts`（vitest）、`:core/src/test/java`（JUnit）、`tests/`（ctest）。
- `bridge/core` 测试使用 `ManualClock` / `ManualScheduler`，不真实等待。
- 跨进程行为（stdio、看护、真实 node）放在 `:core` 集成测试或 endstone `test_node_ipc`；缺失 node 时相关用例自跳过。
- 改协议消费面时跑 `golden.fixtures.test.ts`；它校验 npm 包内 fixtures 的契约、完整性与行为回放。
- 平台薄壳的单测偏薄（paper 无单测、fabric 仅 TPS），涉及 Bukkit/Fabric API 的改动必须过沙盒/真机清单。

## 扩展方式

### 新增业务规则

1. 在 `bridge/core/src/business/` 写纯函数或表（无 I/O）。
2. 在 `Relay` 接线；`KurobridgeServer` 只保留协议状态机，不堆业务。
3. 补 `bridge/core/src/**` 的 vitest；必要时更新 [config 参考](../reference/config.md)。

### 新增协议帧

唯一路径：KuroProtocol 仓四件套同改 + 发版 → 本仓升 `@kuro-bridge/protocol` 依赖 → 按需改 `bridge/core`、Java codec、C++ `ipc_frame`。**不要在本仓新增手写帧类型**。改完跑 `pnpm check` 与金样本测试。

### 新增平台适配

- 复用 `bridge/core`；平台薄壳只做事件/命令/进程/传输。
- 传输接口见 `bridge/core/src/transport.ts`；可注入 `WsServer` / `IpcChannel` / `Logger`。
- 同步 `bridge/core` 零改动（LSE 是范例：只新增传输实现与壳）。
- 更新 [平台差异矩阵](../architecture/runtime.md#7-平台差异矩阵) 与 [现状](../status.md)。

### 新增外部对端

在独立仓库实现；本仓只消费协议包。平台渲染留在对端仓库，不进入 kurobridge。

## 文档

- 新增内容优先补现有主题文件；`docs/` 根不再新增散篇。
- 改配置/协议/构建流程时同笔更新对应文档。
- 不写阶段史、任务书、交接册；决策结论进 [decisions.md](../decisions.md)。
- 提交前跑 `pnpm check:docs`（死链 + 旧 npm scope 口径）。

## 提交前检查

```bash
pnpm check
pnpm test
```

平台改动再加：

```bash
pnpm build:je
pnpm build:endstone
```

全链路打包验证用 `pnpm build:jar`。发布/构建细节见 [构建与发布](build.md)。
