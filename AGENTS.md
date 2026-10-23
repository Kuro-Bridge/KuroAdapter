# KuroBridge 工程指南

> 本文件是项目级指令（VS Code Copilot 自动加载）。开始任何工作前，先读本文件与 `docs/status.md`（现状 + 已知缺口）→ `docs/architecture/overview.md`（架构）→ `docs/modules/` 下对应模块文档。工程体系（配置/文档/工作流）借鉴 **NapukettoQQ**，规范对齐。

## 项目是什么

KuroBridge：MC 服务器 ↔ 社交平台群服互通插件。Paper JAR + 内嵌 Node 子进程，业务核心在 Node（TypeScript），Java 只做 Bukkit 桥接薄壳。对外通过自研 WS 协议 `kurobridge-ws` 与协议端通信（内嵌 napukettoqq / koishi-plugin-kurobridge / 其它实现）。

## 硬性约束（违反 = 错误）

1. **许可证 MIT，全自研**。参考 HuHoBot 只借鉴思路（业务在机器人侧、自定义 WS 协议、UUID 请求-响应），**不复制其代码**（GPL-3.0 与 MIT 不兼容）。闭源件（`wrapper.node`）运行期发现拷贝，不进 JAR。
2. **业务核心在 Node（TS）侧**：绑定/白名单/权限/转发规则等业务逻辑属于 `bridge/core`，**Java 薄壳不做业务**，只做 Bukkit 桥接（事件/命令/权限/广播/executeCommand/进程管理）。
3. **`bridge/core` 平台无关**：禁止使用任何 Node API（含 `ws`、`process`、`fs`、`pino`），传输层抽象为可注入接口（`WsServer/WsClient`、`Logger`），target ES2020，保证 QuickJS（LSE）也能跑。logger 通过依赖注入提供，不直接依赖具体实现。
4. **协议 SSOT 在姊妹仓 KuroProtocol**（ADR-031，ADR-035 起经 npm 消费）：zod schema 的唯一可编辑来源是
   `KuroProtocol/src/`（发布名 `@kuro-bridge/protocol`，版本 SSOT = 其 `src/meta.ts`）。
   本仓**无协议副本**，经 npm 依赖 `@kuro-bridge/protocol@^0.4.0` 消费——
   协议演进唯一路径 = KuroProtocol 四件套同改（schema + peer-guide + fixtures + changelog）
   + 发版，本仓只升依赖版本号。
   任何文件禁止手写消息类型，必须 `import { ... } from "@kuro-bridge/protocol"`。
   `docs/reference/protocol.md` 只放说明文档（权威契约在 KuroProtocol 仓）。
5. **kurobridge 永远是 WS 服务端角色**：对端主动连入；只认 `kurobridge-ws` 协议，不关心对端是谁。embedded / external 只是打包差异，不是架构差异。
6. **不采用 OneBot 11**：方向不匹配（OneBot 是「机器人→QQ」，群服互通是「服务器↔群」）。
7. **依赖方向**（只允许向下依赖）：

   ```
   @kuro-bridge/protocol（npm ^0.4.0）  zod schema，姊妹仓 KuroProtocol 发布，零框架依赖（无仓内副本）
   bridge/core    依赖 protocol；零 Node API、零框架
   bridge/embedded  依赖 core + protocol；esbuild 单文件
   platforms/je   Gradle 多模块：:core（IPC/进程管理，零 Bukkit API）+ :paper（Paper 适配，compileOnly）；不含协议逻辑
   platforms/be   LSE TS（编译为 JS，复用 bridge/core）+ Endstone C++ 薄壳（portable 层 + 内嵌 Node）
   ```

   > **koishi-plugin-kurobridge 是独立仓库**（ADR-018）：作为 `kurobridge-ws` 的官方参考对端，依赖 `@kuro-bridge/protocol` 发布版本，不在本仓库内开发。

8. **IPC 通道**：JE / Endstone 的薄壳 ↔ Node 子进程走 **stdin/stdout JSON-lines**，零端口零配置。Node 对外 WS 缺省动态端口（`listen(0)`），薄壳不监听对外端口。LSE 因 `newProcess` 不暴露 stdio，改用 127.0.0.1 回环 WS 游戏通道（ADR-037），帧方言与生命周期语义不变。
9. **不做的事**：自研通用消息语义层（平台渲染交给独立仓库 koishi-plugin-kurobridge）、嵌入式 QQ 协议端（napukettoqq 只做协议端）、无理由的 `any`、Java 侧业务逻辑。

## 工作流

```bash
pnpm install            # 安装依赖
pnpm check              # 一条入口（pre-commit 同款）：pnpm -r build 首环（ADR-035）+ biome
                        #   + 根 tsc（bridge/*）+ lse typecheck + docs 门禁（旧 scope 口径清零
                        #   + md 死链）+ 版本对齐门禁
pnpm check:docs         # docs 两道门禁单跑（已含在 pnpm check，列出便于定位）
pnpm check:versions     # 版本对齐门禁：bridge 六点 0.1.0 + 协议两份（锚 = 已安装 npm 包
                        #   @kuro-bridge/protocol 清单 version，ADR-034/035，已含在 pnpm check）
pnpm fix                # biome 自动修复 + tsc
pnpm test               # vitest run（TS 侧）
pnpm -r build           # TS 全量构建（tsdown / esbuild）
pnpm build:je           # Java 薄壳门禁（platforms/je gradlew build，= CI java job；跨壳经 toolings/build/platforms.ts）
pnpm build:endstone     # endstone portable 构建回归（cmake+build+ctest 五目标，= CI endstone job；dll 轨道仍走手动 SOP）
pnpm build:all          # 三侧全量构建：pnpm -r build + build:je + build:endstone
pnpm check:all          # 全量门禁（CI 三 job 本地合体）：pnpm check + pnpm test + 平台两侧
pnpm build:jar          # 全链路：TS 构建 → 嵌入式打包 → gradle :paper:shadowJar → :fabric:remapJar（toolings/packaging/build-jar.ts 链式）
```

**构建顺序（硬约束）**：`pnpm -r build`（bridge/embedded 产物）→ `toolings/packaging/embed.ts` 嵌入式打包（node 官方 dist 下载校验 + napuketto 嵌包，产出进 `platforms/je/paper/src/main/resources/embedded/`）→ `gradle :paper:shadowJar`。本地 `pnpm build:jar` 经 `toolings/packaging/build-jar.ts` 链式执行四步（TS 构建 → embed 嵌包 → shadowJar → fabric remapJar）。

**CI（ADR-032，结构经 ADR-035 结论 4 简化）**：`.github/workflows/ci.yml` 三 job——ts job 只检出本仓，跑 `pnpm check && pnpm test`（check 链自含 build 首环，与本地 pre-commit 同构；lefthook 串行 check → test，ADR-035）；java job 经 mise 提供 JDK 25 跑 `gradlew build`；endstone job 于 windows runner 跑 portable 层 `cmake --preset core && cmake --build --preset core && ctest --preset core`（本地等价 = `pnpm build:endstone`）。push main / PR 触发。

**多版本策略（ADR-021）**：`:core` 版本无关（零 MC API）；Paper 单 jar 通吃；Fabric/NeoForge 按版本矩阵构建（每 MC 版本一个 jar）；Velocity 单 jar。改版本只重编适配层，不动 `:core` 与 `bridge/core`。

## 代码风格（biome 已强制，手动也须遵守）

- 缩进 **space+4**，行尾 **LF**，双引号 + 分号 + 尾逗号，行宽 100（对齐 NapukettoQQ 的 biome.jsonc）。
- 类型安全：`strict` 全家桶、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`erasableSyntaxOnly`（产物可被 QuickJS 直接跑，不依赖 tslib/装饰器）、`noUnusedLocals/Parameters` 均为 error。
- 类型导入一律 `import type`；禁止 `any`（例外必须注释说明原因）。
- `noFloatingPromises` 为 error：异步调用必须 `await` 或显式 `.catch`。
- `noExcessiveCognitiveComplexity(15)` 为 error：协议状态机强制拆分。
- 错误处理：业务错误抛类型化错误，不静默吞掉；日志走注入的 logger 接口。

## 实现模式（重要）

- **一个模块一个模块实现**：开工前先读 `docs/status.md` 与 `docs/architecture/overview.md`、`docs/modules/` 下对应模块文档，按其中的实现顺序推进，不跨模块跳跃；每完成一个模块跑一次 `pnpm check`。
- **core 无全局单例**：logger / connection / state 等都是实例化对象，由 `CoreContext` 持有——多连接多进程场景每份独立，避免状态污染。
- **新增协议端**（如外部独立协议端）→ 在 `bridge/` 内新增包，复用 core 框架（握手/心跳/请求-响应），**不改 Java、不改协议**（协议演进的唯一路径是 KuroProtocol 仓四件套同改 + 发版，本仓只升依赖版本号，ADR-031/035）。
- **新增平台适配**（Koishi adapter）→ 在独立仓库 koishi-plugin-kurobridge 内扩展；平台渲染（富文本/颜色码/长度收敛）只出现在那个仓库，本仓库不涉及。
- **写代码前先更新对应模块文档**（`docs/modules/*.md`；平台包内 `docs/design.md` 只保留包级实现细节），设计先行。
- **文档规范**：`docs/` 按主题分目录（architecture / modules / reference / guides），不写阶段史、任务书或交接册；决策结论追加到 `docs/decisions.md`，现状与缺口更新 `docs/status.md`。新增文档优先并入现有主题文件。

## 环境

- Node.js 26（ESM，`"type": "module"`）；TypeScript `NodeNext` 解析；包名统一 `@kuro-bridge/*`（`platforms/be/lse` 根包 `kurobridge` 无 scope）。
- Java 25 工具链 + Gradle 9.7（`platforms/je`，mise 统一版本；**gradlew.bat 日常构建**，mise 的 gradle 仅一次性生成 wrapper）；**字节码 target 21**（兼容 Paper 服务端运行时，见 ADR-015）。
- LSE（`platforms/be`）使用官方 TS 声明 `@levimc-lse/types` + `@levimc-lse/scaffold`，编译为 JS 后由 LeviLamina 加载。
