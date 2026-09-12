# KuroBot 原型机决策记录（PROTOTYPE-NOTES）

> 配套任务书：`docs/PROTOTYPE-PROMPT.md`。本文记录 spike 期间的全部自主决策、放弃的替代方案、架构发现与 ADR 候选。
> 无人值守规则：所有决策自行拍板并记于此。

## 环境（阶段 0 验证，2026-09-12）

- `mise`（2026.8.2）提供 node 26.7.0 / java 25.0.2 / gradle 9.7.0，与 AGENTS.md 要求一致。
- **PATH 直连的 node 是 v24.16.0、java 是 21.0.12**（不满足 engines>=26 / Gradle toolchain 25）。
  → **决策：一切构建/测试命令统一经 `mise exec -- <cmd>` 执行**，不依赖 PATH。
  → 副作用观察：`mise exec -- pnpm install/check/test` 全部通过，但 pnpm 自身仍报 `Unsupported engine node>=26 (current v24.16.0)` 警告（pnpm 独立二进制内嵌运行时所致），无害，忽略。
- 基线：`pnpm install` ✅ `pnpm check` ✅（7 文件）`pnpm test` ✅（3 用例）。
- 分支：自 `master` 切出 `prototype/spike`（任务书 §0）。

## 决策记录

### D-01 握手语义收敛为「Peer 发 hello → Server 回 hello_ack」

draft-v0.1.md 同时列了 Server→Peer 的 `hello`（携带 serverId/channelBindings）与 Peer→Server 的 `hello`，双向注册语义重叠。
spike 收敛为**单程握手**：客户端连入后发 `hello`（peerId/platform/version/protocolVersion，带 id），服务端校验后回 `hello_ack`（同 id，携带 serverId/version/协商后 protocolVersion + ok/error）。服务端身份信息并入 `hello_ack` body，不再单发 Server 侧 `hello`。
理由：请求-响应模型与 UUID 关联机制天然对齐，少一种帧型；正式版若需要服务端主动注册可再拆出。

### D-02 消息 schema 按「WS 侧 / IPC 侧」两文件组织，不按单消息一文件

`bridge/protocol/docs/design.md` 原规划 `src/messages/` 每消息一文件。spike 最小集只有 ~10 个 schema，拆 10 个小文件徒增跳转。
→ `src/messages/ws.ts` + `src/messages/ipc.ts` + 顶层 `meta.ts` / `frame.ts` / `index.ts`。文件内按消息分段注释。正式版消息增多后再按域拆分。

### D-03 IPC 响应帧命名 `*_result`（broadcast_result / execute_command_result）

IPC 请求-响应用显式响应帧型（请求 `broadcast` → 响应 `broadcast_result`，同一 id 关联），不用通用 `result` 帧。
理由：zod discriminated union 按 `header.type` 判别，显式帧型让每条响应有自己的 body schema，Java/TS 两侧都不需要二次分发。放弃了「单一 `ipc_result` 帧 + body 里嵌 type」方案（判别信息重复、类型不收敛）。

### D-04 WS 与 IPC 复用同一帧格式 `{ header: { type, id? }, body }`

IPC JSON-lines 帧直接复用 WS 帧结构（header/body），只是 type 命名空间不同（IPC 侧 snake_case 事件/请求名）。
理由：一套 Frame schema、一套编解码心智模型；Java 侧 Jackson DTO 也只需一套。

### D-05 embedded 引导模型：core 与引导层同进程，stub 协议端为孙进程（ADR 候选）

任务书 §4.2 预设方案落地：Node 引导层（bridge/embedded）= IPC 端点 + WS 服务端宿主，同进程内实例化 `bridge/core`；`listen(0)` 拿到端口后以子进程拉起 stub 协议端（端口经 argv 传入）。
→ Java 只管一个子进程，生命周期级联 Java→node→stub；协议端走与 external 完全相同的 WS client 路径。
→ **ADR 候选 A：内嵌协议端 = 独立孙进程（由 Node 引导层拉起），而非与 core 同进程。**

### D-06 stub 协议端用 Node 内置全局 WebSocket，不引 `ws` 依赖

Node 26 自带 Undici 全局 `WebSocket` 客户端。stub 只做客户端，用内置即可；`ws` 库只出现在 embedded 引导层（服务端角色）。

### D-07 Node 运行时与 bundle 路径经环境变量注入

- `KUROBOT_NODE`：node 可执行文件（缺省 `node`，走 PATH）。
- `KUROBOT_BUNDLE`：embedded 引导层产物 `dist/index.mjs` 绝对路径（Java 拉起子进程的入口）。
- 原型不做 JAR resources 解压 / tools/embed（任务书 §1.2 已批准的简化）。

### D-08 生命周期两条路径

1. 正常：Java onDisable → 发 `shutdown` IPC 帧 → 关 stdin → Node 收到帧或 stdin EOF 后自行退出（先杀 stub 孙进程）。
2. 兜底：Java destroyForcibly。无 Watchdog / PID 文件 / 自动重启（任务书 §1.2）。

### D-09 帧层 union 用 z.union，不用 discriminatedUnion

实测 zod 4.4.3：`z.discriminatedUnion("header.type", [...])` 抛 `Invalid discriminated union option`（不支持嵌套判别路径，判别键必须是 option 的顶层属性）。
→ 帧格式 `{ header: { type, id? }, body }` 保持不变，聚合 schema 用 `z.union([...各消息帧 schema])` 平铺。每个消息的帧 schema 单独导出，消费方按方向（发送方）选用精确 schema，聚合 union 只用于收帧侧的「接受任意已知帧」。放弃了「把 type 提到帧顶层」的方案（会偏离 draft-v0.1 已定稿的帧结构）。

### D-10 协议版本协商：spike 要求精确相等

大版本由 WS 子协议 `kurobot-ws.v1` 把关（握手期拒绝）；`hello.protocolVersion` 小版本在 spike 中要求与本端 `PROTOCOL_VERSION` **精确相等**，不匹配回 `hello_ack` error + 关连接（1002）。宽容的 semver 协商（兼容区间）留正式版。

### D-11 帧 schema 解析后 transform 为扁平消息 `{ type, id?, body }`

实测（TS 7/tsgo + tsc 行为一致）：**解构判别与嵌套属性判别都无法收窄 union**（`const { type } = frame.header` 与 `frame.header.type === "x"` 均不行——判别键必须是 union 变量的直接属性）。
→ protocol 包的帧 schema 在 zod `.transform()` 里把线格式 `{ header: { type, id? }, body }` 摊平成 `{ type, id?, body }`（线格式不变，Java 侧零影响）；消费方直接 `msg.type === "hello"` 原生收窄。出帧统一走 `encodeFrame(message)`。
→ 副作用：zod v4 对「泛型 body 成员的对象输出 + transform」推断不足（body 键在回调参数上丢失），SSOT 助手内用结构断言收拢（`frame as { header: …; body: z.output<B> }`），断言被限制在两个助手函数内。
→ 放弃的方案：①每分支二次 safeParse（重复解析、运行时多一次全量校验）；②把 type 提到线格式顶层（违背 draft 已定稿帧结构）。

### D-12 embedded 单文件打包需 createRequire banner

esbuild `--format=esm` 打包 CJS 依赖（ws）时产物内 `require("events")` 报 Dynamic require not supported。
→ 构建脚本加 `--banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"`。
放弃方案：`--external:ws`（产物不再单文件，运行期依赖 node_modules 布局，违背 JAR 内嵌目标）。

### D-13 IpcChannel 事件改为多播

Relay 与引导层都要订阅 IPC onClose（前者结算在途请求，后者杀孙进程退出），单 handler 语义会互相覆盖。
→ 传输接口文档明确 onXxx 可多次注册、实现方需回调全部（StdioIpcChannel 用数组实现）。WS 侧单注册即可（core 是唯一订阅方）。

### D-14 Spotless palantir-java-format 钉 2.71.0（JDK 25 兼容）

仓库预置的 Spotless 7.0.2 默认 palantir 版本在 JDK 25 下抛 `NoSuchMethodError`（`DeferredDiagnosticHandler.getDiagnostics()` 在 JDK 25 改了签名，见 spotless#2468/#2625）。
→ 五个 je 模块的 `palantirJavaFormat()` 全部钉 `2.71.0`。这是首次真正跑 Java 构建暴露的预置缺陷。

### D-15 Java :core 复核修正（subagent 产出打回项）

subagent 产出整体合格，复核发现三处并亲手修复：
1. `palantir` 版本问题（D-14，构建直接失败）。
2. `-Werror` 下 try-with-resources 资源未在体内引用的 `[try]` 警告 → 改为直接 `close()` 调用。
3. FakeProcess.StdoutStream.write 不补换行 → `readLine()` 永久阻塞，4 个用例超时；write 改为按 JSON-lines 语义自动补 `\n`。
4. shutdownIsGracefulAndIdempotent 断言取帧顺序错（在途 broadcast 帧先于 shutdown 帧落盘）→ 修正断言顺序。
教训：subagent 自称「跑过构建」不可信（它实际没跑通 spotless/test），主智能体复核环节不可省。

## 架构发现（随做随记）

- **TS 生态摩擦**：嵌套判别不可收窄 + zod v4 泛型 transform 推断缺陷，是 SSOT「线格式=消费格式」设计的直接代价；D-11 的扁平 transform 层把它吸收在 protocol 包内，消费方零感知。正式版若消息变多，这个 transform 层就是「协议解析层」的雏形。
- **TS 链路烟囱（2026-09-12，sandbox/ts-smoke.mjs）已全通**：ready（动态端口 59398）→ stub 孙进程拉起 → hello/hello_ack 握手 → stub 平台消息 → broadcast 请求-响应 → 游戏聊天送达 stub → shutdown 级联退出（node code=0，无孤儿进程）。IPC onClose 多播（D-13）与「stdout 只出 JSON-lines、日志全走 stderr」的纪律在真进程模型下验证成立。
- **端到端全链路成立（2026-09-13，sandbox Paper 1.21.4-232）**：插件加载 → node 拉起 → IPC ready（动态端口）→ stub 孙进程 → 握手 → 双向消息 → 优雅关机级联，全部按架构书预期工作。「一个 JAR、两个进程、一条消息双向跑通」的原型命题成立。
- **Java Path.resolve 的目录段语义坑（实测踩中）**：`bundle.resolve("../stub/peer.mjs").normalize()` 会把文件名当目录段消掉，得到 `dist/stub/peer.mjs` 而非 `embedded/stub/peer.mjs`。必须以 `getParent()` 为基准推导兄弟路径（已修 `KuroBotPlugin`）。
- **mise 的 PATH 不传导到 Java ProcessBuilder 的可执行文件搜索**：即便服务端经 `mise exec` 启动，Java 里 `ProcessBuilder("node", ...)` 解析到的仍是系统 PATH 的 node v24。必须显式传 node 绝对路径（`KUROBOT_NODE=$(mise which node)`，已写进 scripts/paper-start.sh）。
- **MSYS pid 跨 bash 会话不可靠**：后台记录的 `$!`（MSYS pid）在另一会话 `kill -0` 判活失败。沙盒脚本改记录 `/proc/$!/winpid`（Windows pid），用 `tasklist //FI` 判活。
- **tail -f stdin 注入的两个坑**：① cmd.in 里残留的 `stop` 会被新一轮 tail 回放——服务器一启动就被停（实测复现）；② 多轮启停遗留的 tail.exe 与新 tail 抢读同一 cmd.in，命令行随机丢失。解法：启动前清空 cmd.in + `taskkill tail.exe`（已写进脚本）。
- **PaperMC v2 API 已 sunset（2026）**：下载走新端点 fill.papermc.io（v3），构建对象自带 sha256；旧 api.papermc.io/v2 返回 `{"ok":false,"error":"sunset"}`。
- **Paper 1.21.4 的 paper-api 不携带 adventure plaintext 序列化模块**（subagent 实证 + 复核认可）：`PlainTextComponentSerializer` 会运行时 NoClassDefFoundError；只能用带 @Deprecated 的 `PlainComponentSerializer.plain()`（局部压制）。升级暴露 plaintext 模块的 Paper 版本后替换。
- **paper-plugin.yml 不支持 commands 声明**：/kurobot 经 `Bukkit.getCommandMap().register(...)` 运行期注册（Paper 直接提供该方法，无需反射）。
- **Shadow 9 不再把 shadowJar 挂进 assemble**：`:paper:build` 只产普通 jar，fat jar 要显式 `:paper:shadowJar`（工程已有 kurobotBuild 任务，构建脚本未改，留待正式版决策）。
- **观察**：Node 侧 stdout 行缓冲在 Windows 重定向下有秒级延迟，验收 grep 日志要留余量；Paper 控制台日志以 `logs/latest.log` 为准（console.log 是 stdout 重定向）。

## ADR 候选清单

- **候选 A**（来自 D-05）：内嵌协议端以孙进程形态由 Node 引导层拉起，Java 只管一个子进程。**原型已验证成立**：生命周期级联（Java→node→stub）与 external 同构（stub 走的就是普通 WS client 路径）。
- **候选 B**（来自 D-01）：握手收敛为单程 hello + hello_ack（服务端身份并入 ack body），废除双向 hello 草案语义。原型按此实现并通过。
- **候选 C**（来自 D-11）：协议包在解析层做「线格式 → 扁平消息」的 transform（含 encodeFrame 出帧助手），作为常驻的协议解析层设计，而非仅 TS 类型体操补丁。
- **候选 D**（来自 D-03/D-04）：IPC 与 WS 复用同一帧格式与「事件无 id / 请求响应有 id」规则，`*_result` 显式响应帧型。
- **候选 E**：`kurobot.sendGameChat` 在 IPC 断开时静默丢弃并 WARN——正式版应把 IPC 健康状态暴露给业务层做降级决策（消息排队/重连后补发 vs 丢弃）。

## MVP 阶段债务清单

- **心跳只做了应答**（ping→pong），无空闲超时检测、无假连接多阈值判定（架构书 §10 要求）。core 平台无关约束下需要注入 clock/scheduler 抽象。
- **hello 等待无超时**（stub 挂起不发 hello 会占连接）；IPC broadcast 请求在 TS 侧无超时（Java 侧有 10s）。
- **协议版本协商是精确相等**（D-10），无 semver 兼容区间。
- **无重连**：WS 对端断开后 core 不感知重建（stub 自带简退避重连）；Node 死后 Java 侧重启/Watchdog/PID 文件均未做（任务书批准的裁剪）。
- **业务为空壳**：Relay 假规则（全量转发），无绑定/白名单/权限/转发规则，无 `bindings_updated`。
- **消息格式拼接**：平台消息广播为 `<sender> content` 裸字符串，无渲染层（归属 koishi-plugin-kurobot，正确）。
- **`/kurobot send` 在 IPC 断开时仍回复「已发送」**（实际丢弃）——应回报失败。
- **未消费 `kurobot.relay` 权限**（转发过滤是 Node 侧业务语义，已在 ChatListener javadoc 注明）。
- **Java :paper 无单元测试**（Bukkit 侧无 mock 依赖，依赖集成/沙盒验收兜底）。
- **sandbox 烟囱脚本 ts-smoke.mjs 留在 sandbox/**（gitignore 区）：模拟 Java 驱动 bundle 的自验脚本，正式版可升格为 vitest 进程级测试或删除。
- **Spotless palantir 2.71.0 为最低兼容线**（D-14）：Paper/Velvet 等模块启用时同版本钉住即可。
- **shadowJar 未挂进 assemble**（见架构发现）：`pnpm build:jar` 链路目前可用但 `:paper:build` 不产 fat jar。
