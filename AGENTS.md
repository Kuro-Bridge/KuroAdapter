# KuroBridge 工程指南

> 本文件是项目级指令（VS Code Copilot 自动加载）。开始任何工作前，先读本文件与 `docs/STATUS.md`（现状 + 关键决策点）→ `docs/architecture.md`（架构书）→ 对应包的 `docs/design.md`。工程体系（配置/文档/工作流）借鉴 **NapukettoQQ**，规范对齐。

## 项目是什么

KuroBridge：MC 服务器 ↔ 社交平台群服互通插件。Paper JAR + 内嵌 Node 子进程，业务核心在 Node（TypeScript），Java 只做 Bukkit 桥接薄壳。对外通过自研 WS 协议 `kurobridge-ws` 与协议端通信（内嵌 napukettoqq / koishi-plugin-kurobridge / 其它实现）。

## 硬性约束（违反 = 错误）

1. **许可证 MIT，全自研**。参考 HuHoBot 只借鉴思路（业务在机器人侧、自定义 WS 协议、UUID 请求-响应），**不复制其代码**（GPL-3.0 与 MIT 不兼容）。闭源件（`wrapper.node`）运行期发现拷贝，不进 JAR。
2. **业务核心在 Node（TS）侧**：绑定/白名单/权限/转发规则等业务逻辑属于 `bridge/core`，**Java 薄壳不做业务**，只做 Bukkit 桥接（事件/命令/权限/广播/executeCommand/进程管理）。
3. **`bridge/core` 平台无关**：禁止使用任何 Node API（含 `ws`、`process`、`fs`、`pino`），传输层抽象为可注入接口（`WsServer/WsClient`、`Logger`），target ES2020，保证 QuickJS（LSE）也能跑。logger 通过依赖注入提供，不直接依赖具体实现。
4. **协议 SSOT 唯一**：`bridge/protocol` 的 zod schema（`@kurobridge/protocol`）是消息类型的唯一来源，**任何文件禁止手写消息类型**，必须 `import { ... } from "@kurobridge/protocol"`。`docs/protocol/` 只放说明文档。
5. **kurobridge 永远是 WS 服务端角色**：对端主动连入；只认 `kurobridge-ws` 协议，不关心对端是谁。embedded / external 只是打包差异，不是架构差异。
6. **不采用 OneBot 11**：方向不匹配（OneBot 是「机器人→QQ」，群服互通是「服务器↔群」）。
7. **依赖方向**（只允许向下依赖）：

   ```
   bridge/protocol（@kurobridge/protocol）   zod 纯 schema，零框架依赖
   bridge/core    依赖 protocol；零 Node API、零框架
   bridge/embedded  依赖 core + protocol；esbuild 单文件
   platforms/je   Gradle 多模块：:core（IPC/进程管理，零 Bukkit API）+ :paper（Paper 适配，compileOnly）；不含协议逻辑
   platforms/be   LSE TS（编译为 JS），复用 bridge/core（QuickJS 可跑）
   ```

   > **koishi-plugin-kurobridge 是独立仓库**（ADR-018）：作为 `kurobridge-ws` 的官方参考对端，依赖 `@kurobridge/protocol` 发布版本，不在本仓库内开发。

8. **IPC 唯一通道**：Java 薄壳 ↔ Node 子进程走 **stdin/stdout JSON-lines**，零端口零配置。Node 对外 WS 用动态端口（`listen(0)`），Java 侧不碰任何端口。
9. **不做的事**：自研通用消息语义层（平台渲染交给独立仓库 koishi-plugin-kurobridge）、嵌入式 QQ 协议端（napukettoqq 只做协议端）、无理由的 `any`、Java 侧业务逻辑。

## 工作流

```bash
pnpm install            # 安装依赖
pnpm check              # biome check + tsc --noEmit（提交前必跑）
pnpm fix                # biome 自动修复 + tsc
pnpm test               # vitest run（TS 侧）
pnpm -r build           # TS 全量构建（tsdown / esbuild）
./gradlew build         # Java 薄壳（platforms/je）
pnpm build:jar          # 全链路：TS 构建 → gradle :paper:shadowJar（嵌入式打包待重建）
```

**构建顺序（硬约束）**：`pnpm -r build`（bridge/embedded 产物）→ 嵌入式打包工具（tools/embed，已删除待重建）拷入 `platforms/je/src/main/resources/embedded/` → `gradle :paper:shadowJar`。本地 `pnpm build:jar` 链式执行（当前 embed 步骤暂缺）。

**多版本策略（ADR-021）**：`:core` 版本无关（零 MC API）；Paper 单 jar 通吃；Fabric/NeoForge 按版本矩阵构建（每 MC 版本一个 jar）；Velocity 单 jar。改版本只重编适配层，不动 `:core` 与 `bridge/core`。

## 代码风格（biome 已强制，手动也须遵守）

- 缩进 **space+4**，行尾 **LF**，双引号 + 分号 + 尾逗号，行宽 100（对齐 NapukettoQQ 的 biome.json）。
- 类型安全：`strict` 全家桶、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`erasableSyntaxOnly`（产物可被 QuickJS 直接跑，不依赖 tslib/装饰器）、`noUnusedLocals/Parameters` 均为 error。
- 类型导入一律 `import type`；禁止 `any`（例外必须注释说明原因）。
- `noFloatingPromises` 为 error：异步调用必须 `await` 或显式 `.catch`。
- `noExcessiveCognitiveComplexity(15)` 为 error：协议状态机强制拆分。
- 错误处理：业务错误抛类型化错误，不静默吞掉；日志走注入的 logger 接口。

## 实现模式（重要）

- **一个模块一个模块实现**：开工前先读 `docs/STATUS.md` 与 `docs/architecture.md`、对应包的 `docs/design.md`，按其中的「实现顺序」推进，不跨模块跳跃；每完成一个模块跑一次 `pnpm check`。
- **core 无全局单例**：logger / connection / state 等都是实例化对象，由 `CoreContext` 持有——多连接多进程场景每份独立，避免状态污染。
- **新增协议端**（如外部独立协议端）→ 在 `bridge/` 内新增包，复用 core 框架（握手/心跳/请求-响应），**不改 Java、不改 protocol**。
- **新增平台适配**（Koishi adapter）→ 在独立仓库 koishi-plugin-kurobridge 内扩展；平台渲染（富文本/颜色码/长度收敛）只出现在那个仓库，本仓库不涉及。
- **写代码前先更新对应包的 `docs/design.md`**，设计先行。

## 环境

- Node.js 26（ESM，`"type": "module"`）；TypeScript `NodeNext` 解析；包名统一 `@kurobridge/*`。
- Java 25 工具链 + Gradle 9.7（`platforms/je`，mise 统一版本；**gradlew.bat 日常构建**，mise 的 gradle 仅一次性生成 wrapper）；**字节码 target 21**（兼容 Paper 服务端运行时，见 ADR-015）。
- LSE（`platforms/be`）使用官方 TS 声明 `@levimc-lse/types` + `@levimc-lse/scaffold`，编译为 JS 后由 LeviLamina 加载。
