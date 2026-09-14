# bridge/embedded 设计（@kurobridge/bridge-embedded）

> 本文件是包级设计文档（AGENTS.md：写代码前先更新对应包的 `docs/design.md`，设计先行）。

## 职责

嵌入式瘦身对端（`mode=embedded` 默认形态）：

- 复用 `bridge/core` 框架，作为对端连接 kurobridge 的 WS 服务端。
- 内嵌 **napukettoqq** 协议端（QQ 连接，控制台扫码）。
- **无 Koishi**：esbuild 单文件产物，随 JAR 分发（嵌入式打包工具打包，待重建）。

## 与架构的关系（ADR-005 / ADR-006）

- embedded / external 只是打包差异：本包 = "协议端在 JAR 里"的形态；
  external 形态由独立仓库 koishi-plugin-kurobridge 承担（ADR-018），两者复用同一 core。
- `wrapper.node`（腾讯闭源）不进 JAR，运行期从 QQ 安装目录发现拷贝（ADR-014）。

## 目录规划

```
src/
├── index.ts       # 入口：拉起 core 客户端 + napukettoqq（嵌入引导）
└── bootstrap.ts   # 子进程引导（stdin EOF 自杀 / Watchdog / 崩溃兜底）
```

## 实现顺序（STATUS.md 第 4 步细化）

1. core 客户端接入（对端角色：连接/握手/心跳/重连）。
2. napukettoqq 嵌入引导。
3. 子进程生命周期（stdin EOF 自杀 + PID + Watchdog）。

## 依赖

- `@kurobridge/bridge-core`（workspace:*）。
- `@kurobridge/protocol`（workspace:*）。
- esbuild（devDep，单文件打包）。

## 原型阶段（spike，2026-09-12）

> 任务书：`docs/PROTOTYPE-PROMPT.md` §1.2 / §4.2。完整设计（内嵌 napukettoqq）不变，本节只标注原型裁剪。

本阶段本包退化为 **Node 引导层（bootstrap）**，不含 napukettoqq：

- `src/index.ts`：入口——stdin/stdout IPC 端点（JSON-lines，帧走 `@kurobridge/protocol`）+ 以子进程拉起 stub 协议端（孙进程，端口经 argv，决策 D-05）。
- `src/ws-server.ts`：`ws` 库实现 core 的 `WsServer` 接口（`listen(0)` 动态端口 + 子协议 `kurobridge-ws.v1` 校验），唯一的 Node API 落点。
- `src/ipc-stdio.ts`：stdin/stdout 实现 core 的 `IpcChannel` 接口。
- stub 协议端：`stub/peer.mjs`（零依赖，Node 内置全局 WebSocket，决策 D-06）。

启动序列：Java 拉起本入口 → 起 WS 服务端 `listen(0)` → IPC 发 `ready`（携带端口）→ spawn stub → stub 以 WS client 连入并 `hello` 握手。stdin EOF 或 `shutdown` 帧 → 杀 stub → 自行退出（决策 D-08）。

原型裁剪：node.exe 不进 JAR（用 PATH `node` 或 `KUROBRIDGE_NODE`，决策 D-07）、bundle 从 `KUROBRIDGE_BUNDLE` 指定的本地产物加载、无 napukettoqq / wrapper.node / 扫码、无 Watchdog / PID 文件 / 崩溃自动重启。

## MVP 阶段一（2026-09-13）

> 任务书：`docs/MVP1-PROMPT.md` §3 阶段 2/3。本包在 spike 形态上补 Node 能力注入与配置。

- **Node 能力实现（阶段 2）**：`src/node-platform.ts` —— core 的 `Clock`/`TimerScheduler`
  Node 实现（`Date.now` + `setTimeout` + `unref`），与 ws 适配器同为「唯一的 Node API 落点」。
- **配置实现（阶段 3）**：`src/config-store.ts` —— core 的 `ConfigStore` Node 实现：
  读 `plugins/kurobridge/config.json`（相对子进程 cwd = 服务器根目录），缺失时生成默认配置
  （`{ "channels": [] }`）落盘；**轮询监听**（interval + mtime 比对）——选轮询而非 fs.watch：
  Windows/网络盘的 fs.watch 事件语义不可靠，轮询实现更简单可测（任务书 §1.2 二选一的决策）。
- **stub 升级 v0.2（阶段 1，已落地）**：hello 协议版本 0.2.0；平台消息携带
  `channel: "stub-channel"`（沙盒验收时把该频道写进配置绑定表即端到端连通）；
  处理 join/leave/status/bindings_updated 帧（stderr 打印，供验收 grep）；
  收到含自己频道的 bindings_updated 后补发一条平台消息（验收配套行为：不重启即可验证
  「写绑定 → 消息进游戏」，见 MVP1-NOTES M-16）。
- **实际落地补充**：`NodeConfigStore` 轮询用 mtimeMs+size 双指标（单 mtime 在编辑器原子替换
  空窗会误判）；默认配置 `writeFile(flag:"wx")` 生成，绝不覆盖服主手写内容；bootstrap 初始
  load 失败以空绑定降级运行（配置修复后 watch 自动生效）。

## MVP 阶段二（2026-09-13）

> 任务书：`docs/MVP2-PROMPT.md`（打包闭环）。本包源码零改动，本节记录形态变化。

- **产物进 JAR**：`dist/index.mjs` 经 `scripts/embed.ts` 拷入
  `platforms/je/paper/src/main/resources/embedded/index.mjs`（随 manifest.json 带 sha256），
  运行期由 :paper 解压到 `plugins/kurobridge/bin/` 后拉起（详见 platforms/je design 的
  「MVP 阶段二」节）。本包构建方式（esbuild 单文件）不变。
- **运行环境**：从「mise node + KUROBRIDGE_BUNDLE 环境变量」变为「JAR 自带 node.exe 26.7.0」；
  环境变量保留为开发覆盖。cwd 语义不变（=服务器根，配置在 `plugins/kurobridge/config.json`）。
- **stub 不进 JAR**（测试件）：JAR 模式未设 `KUROBRIDGE_STUB_PEER` 时不拉 stub，
  即 external 协议端形态；沙盒验收经该环境变量指向仓库内 `stub/peer.mjs`。

## 债务清偿二（DEBT-2，2026-09-13）：autoRestart 上报 + stub 重连上限

> 任务书：`docs/DEBT2-PROMPT.md` §1.2。两件小事，均不触碰 core。

### bootstrap 上报 autoRestart（协议 0.2.1）

- `main()` 发 ready 帧时带 `autoRestart`：取自配置 `runtime.autoRestart`（core 的
  `parseConfig` 已扩展、缺省 true）。配置加载失败降级路径（空绑定）同样带缺省 true。
- 版本号顺延随 `@kurobridge/protocol` 0.2.0 → 0.2.1；bootstrap 日志里的协议版本随之更新。

### stub 重连上限：10 次连续失败自杀（孤儿治理）

- 背景（MVP1-NOTES 架构发现）：Windows 无父子级联终止，宿主强杀 node 后 stub 孤儿
  会无限重连。治理选 stub 侧计数自杀，**不做** Job Object / 父进程死亡检测（测试件
  复杂度不值；真实对端 napukettoqq 的重连策略属其自身实现）。
- 行为：`connect` 前重连计数 +1，`open` 成功清零；**连续 10 次未成功连入** → 打印原因
  （连续重连失败 10 次，最后一次错误）并以**退出码 1** 退出。心跳建立后的运行期断开
  （服务器重启场景）也走重连，同样受 10 次上限约束——stub 是测试件，简单一致优先。
- 影响面：集成测试若有依赖「stub 无限重连」的预期需同步；正常路径（node 活着）不受影响。

### 实现回填（2026-09-13 验收后）

- autoRestart 上报落地：ready body 携带 `initialConfig.runtime.autoRestart`；配置加载
  失败降级路径显式构造 `{ channels: [], runtime: { autoRestart: true } }`。
- stub 自杀落地：`MAX_CONSECUTIVE_FAILURES = 10`；close 累加 / open 清零；退出前打印
  「连续 10 次重连失败（最后一次：…），放弃重连并退出」；error 事件 message 为空串时用
  `||` 落到 error 对象/unknown（Undici 实测）。
- **重要发现（DEBT2-NOTES A）**：Node 26 在 Windows 对 spawn 的子进程施加 Job Object
  （kill-on-close）——强杀 node 后 stub 立即级联退出，孤儿不存活；本节自杀上限为纵深
  防御（external 对端形态 / 运行时行为变化时为主防线）。独立验证（bash 直spawn stub
  连死端口）确认 10 次失败 → 退出码 1 全程 ~181s。

## 债务清偿一（DEBT-1，2026-09-13）：bootstrap 注入 token/admins + stub 0.3.0

> 任务书：`docs/DEBT1-PROMPT.md` §3 阶段 3。在 DEBT-2 形态上叠加，不回退自杀逻辑。

### bootstrap

- `CoreContext` 注入 `token: initialConfig.token`；`Relay` 注入
  `new AdminTable(initialConfig.admins)`（业务态与 BindingTable 对称）。
- 配置加载失败降级路径改用 `defaultConfig()`（0.3.0 起自含 token/admins/runtime 全字段）。
- 启动日志补鉴权状态与管理员映射条数（沙盒验收 grep 用）。

### stub 0.3.0（stub/peer.mjs）

- 版本常量 → 0.3.0；hello 可携带 token。
- **env 钩子**（前三个为任务书指定）：
  - `KUROBRIDGE_STUB_PROTOCOL_VERSION`：覆盖 hello.protocolVersion（验协商拒绝 / 0.2.0 兼容连入）。
  - `KUROBRIDGE_STUB_TOKEN`：hello 携带 token。
  - `KUROBRIDGE_STUB_ADMIN_SOURCE`：command 帧的 source 覆盖，格式 `channel:userId`
    （缺省 `stub-channel:stub-admin`，与沙盒配置 admins 对齐）。
  - `KUROBRIDGE_STUB_SEND_COMMAND` / `KUROBRIDGE_STUB_SEND_QUERY` / `KUROBRIDGE_STUB_SEND_UNKNOWN`：
    握手成功后自动发送的验收序列（无人值守沙盒验收驱动；SEND_COMMAND 支持 `;` 分隔、
    顺序发送且逐条等待结果，query 支持 `status`/`bindings`/逗号并列，unknown 取
    `event`/`request`）。结果帧（command_result/query_result/未知回执）以醒目格式打印。
- **交互命令**（stdin 行命令，standalone 运行 stub 时可用；被 node 以 stdio ignore 拉起时
  stdin 即 EOF，静默禁用不影响常驻）：`command <文本...>` / `query <status|bindings>` /
  `unknown <event|request>`。
- 处理新帧：`death` / `command_result` / `query_result` / `<type>_result`（未知请求帧回执）打印。
- DEBT-2 的「连续重连 10 次自杀」原样保留（复跑指引 3）。

## MVP 阶段三（MVP-3，2026-09-13）：NodeWsServer 参数化 + external 安全基线

> 任务书：`docs/MVP3-PROMPT.md`。external 形态（napukettoqq 独立部署、经配置端口连入）的
> 接入基座：固定端口 + 绑定地址 + 绑定失败语义 + 空 token WARN + stub 独立连入模式。

### NodeWsServer 参数化（host/port）

- 构造器收 `NodeWsServerOptions { host?: string | undefined, port?: number | undefined }`
  （缺省 = 现状：动态端口、全部接口）；bootstrap 从 `config.ws`（core configSchema 是形状
  SSOT）读出传入。成员声明 `?: T | undefined` 是 exactOptionalPropertyTypes 下的显式
  undefined 豁免（bootstrap 可直接 `config.ws?.host` 传入）。
- `KurobridgeServer` / `WsServer` 接口不感知监听参数：`start()` 返回实际端口的契约不变，
  ready 帧照报实际端口（固定端口配置下即配置值）。
- **实测依据（Node 26.7.0 + ws 8.x）**：`new WebSocketServer({port, host})` 构造时同步发起
  listen；**EADDRINUSE 不在构造时抛**，经底层 http server 以 `error` 事件**异步**转发
  （ws 源码 `addListeners` 转发 listening/error/upgrade）；`address()` 构造后同步可得
  （listen(0) 立即回真实端口）。因此 `start()` 以**先挂的一次性 `error` 监听**为失败判据、
  `listening` 事件为成功判据做竞态收口：listening 先到 → 移除一次性 error 监听并 resolve
  （不依赖 address() 的同步可得性，跨 Node 版本稳健）。
- **绑定失败语义（任务书拍板）**：`start()` 以 `WsBindError`（message 含 host/port 与原因）
  reject → bootstrap 打**明确 error 日志**（含端口与原因）→ Node 进程 **exit(1) 非零退出**。
  **不新增重试机制**：Java 看护器按 1s/5s/15s 退避自然重试、10 分钟窗 3 次失败放弃（DEBT-2
  既有语义），长期端口冲突收敛为「放弃 + 日志」。
- listening 之后的 `error` 事件（非绑定失败，如 accept 层错误）注入 logger 打 error 日志、
  不退出（仅防未处理 error 事件炸进程；超出本册范围）。

### 空 token 安全基线（external 暴露面变大）

- config 含 `ws` 段且 `token` 为空 → bootstrap 启动打 **WARN**（提示 external 模式建议配置
  token），不阻断启动（保持空 token 向后兼容语义）。

### stub 独立连入模式（模拟 external 对端）

- 新 env 钩子：`KUROBRIDGE_STUB_WS_URL` 覆盖连接地址（缺省维持 `ws://127.0.0.1:<argv[2]>`）——
  stub 可不经孙进程拉起、以独立进程模拟 external 对端连入（设该变量时 argv 端口可省略）；
  `KUROBRIDGE_STUB_CLIENT` hello 携带 `client` 自报身份（验服务端握手日志展示，协议 0.3.1）。
- 既有钩子（PROTOCOL_VERSION/TOKEN/ADMIN_SOURCE/SEND_*）与重连 10 次自杀逻辑不动。

### 实现回填（2026-09-13 验收后）

- 绑定失败实例**不登记 `this.server`**：stop() 维持 no-op，进程清理路径安全；
  listening 后的 error 经注入 logger 记日志不退出。
- 架构发现（Windows，M3-08）：通配（0.0.0.0）与特定地址（127.0.0.1）绑定可**并存**——
  复现绑定失败必须同地址形态占位；`ws-server.test.ts` 端口占用用例用同族 socket
  （listen(0) → 读端口 → 释放）不受影响。
- 沙盒证据（MVP3-NOTES 验收表）：固定端口 25580、绑定失败退避 3 次放弃、空 token WARN、
  双独立 stub 并存（WS_URL/CLIENT 钩子）。

## MVP 阶段四（MVP-4，2026-09-14）：napuketto spawner（JAR 内嵌协议端真身）

> 任务书：`docs/MVP4-PROMPT.md`；ADR-029。ADR-022 孙进程模型从 stub 换成真身：
> 进程树 Java → node（kurobridge WS 服务端）→ napuketto CLI（supervisor）→ boot →
> self-host（最深四层）。协议 0.3.1 零变更；stub 路径零改动（napuketto 是新增分支）。

### 分支接线（bootstrap）

- `config.embedded?.napuketto.enabled === true` → napuketto 分支（**不再拉 stub**——
  一个 kurobridge 实例只有一个逻辑协议端）；其余（无段 / enabled=false）→ 现状不变。
- 分支前置校验（顺序执行，均注入 platform 便于测试）：
  1. 非 Windows 宿主 → error 日志 + **不拉起**（node 继续以纯 WS 服务端跑，external
     对端不受影响；wine 记债务）。
  2. config 无 `ws.port` → error 日志（含「为什么」）+ **exit(1)**（WsBindError 同族：
     napuketto TOML 的 `url` 静态，动态端口无法喂给；收敛于 Java 看护器退避）。
  3. CLI 入口缺失（`<bin>/napuketto/node_modules/@napuketto/cli/dist/index.mjs` 不存在，
     开发覆盖模式未装包）→ error + exit(1)（配置要求嵌入形态而产物缺失 = 快速失败）。

### napuketto spawner 契约（src/napuketto.ts）

- `createNapukettoSpawner(options)` → `{ child, stop(), onExit(cb) }`；依赖全部可注入：
  `spawnFn`（默认 node:child_process.spawn）、`platform`（默认 process.platform）、
  `execTaskkill`（默认 spawn taskkill）、logger、时钟（QR 轮询间隔）。
- 拉起：`spawn(process.execPath, [cliEntry], { env, stdio: ["pipe", "pipe", "pipe"] })`。
  - env = `{ ...process.env, NAPKETTO_CONFIG: <绝对路径>, NAPKETTO_DATA: <绝对路径> }`
    ——其余 env（`NAPUTO_QQ_PATH` 等）原样透传，KuroAdapter 不默认设置。
  - **stdio 全 pipe、绝不 inherit**（node 的 stdout 是 IPC 通道，污染即断 IPC）。
  - 不传 `-q`：CLI 走 autoStart（读 TOML `[[accounts]]` 拉起全部启用账号）——napuketto
    侧配置 SSOT 是它自己的 TOML，KuroAdapter 只指路。
- stdio 捕获：逐行 → `[napuketto] ` 前缀走注入 logger；行内可辨识 ` WARN `/` ERROR `
  级别字样（pino-pretty 固定格式）分流 warn/error，其余 info。**终端 ASCII 二维码按
  突发折叠**（终验期反转早先「透容忍」决策：实机体验该图经编码转发后本就扫不了，
  还把 console.log 与 `/kurobridge qr` 回复淹没）：去 ANSI 后块元素（U+2580–U+259F）≥10
  或整行 ≥15 个 `?`（编码降级残骸）判为图行，连续图行折叠为单行提示（上限 200 行防
  流污染）；QR URL 提取（见下）不受折叠影响。BANNER 等正常输出不命中、原样透传。
- **生命周期**（考据结论：napuketto boot 层无信号处理器、全链无父死检测——只 kill CLI
  本体必留 self-host 孤儿持 instance.lock）：
  - 优雅关停（shutdown 帧 / stdin EOF）：Windows `taskkill /PID <cliPid> /T /F` 树杀
    （napuketto 自家 `napuketto stop` 同款；/T 连带 boot/self-host）→ 有界等待 exit
    （5s，对齐 napuketto FORCE_EXIT_MS）→ node 自退。
  - CLI 意外退出（非关停路径 exit）→ error 日志 + node `exit(1)` → Java 看护器退避重启
    → 重拉 CLI（凭据在腾讯原生层，quick-login 自动恢复）。
  - 强杀 node → CLI 树预期随 Node 26 Job Object 级联死亡（DEBT-2 发现；四层树验收复验）。

### QR 状态文件（零协议变更交接）

- node 轮询（默认 2s）两路信号：
  1. 数据目录扫描 `<dataDir>/*/cache/qrcode.png`（`*` = 账号 uin 目录）mtime+size 变化
     → 拷贝为 `plugins/kurobridge/qr.png`；
  2. 捕获流正则 `请扫描二维码登录（保存: … | URL: …）`（napuketto 固定文案，全角括号）
     → 提取 URL。
- 任一信号触发 → 原子写 `plugins/kurobridge/qr.json`：
  `{ pngPath: string, url?: string, detectedAt: number }`（pngPath = qr.png 绝对路径；
  node.pid 式运维文件先例）。拷贝失败（PNG 写入中）下次轮询自然重试，不致命。
- 消费方：`:paper` 的 `/kurobridge qr` 只读展示（Java 不解析内容，纯文件读取）。

### 打包形状（与 scripts/embed.ts 的分工）

- embed.ts 新增：`pnpm`/`npm` 拉取 `@napuketto/cli@<pin>` 到缓存目录（真实文件，非 pnpm
  symlink）→ node_modules 树打成**单一 zip 资源** `embedded/napuketto.zip`（零依赖
  zip writer，deflate + crc32，与既有 reader 对称）→ manifest 增条目 + 许可文件
  `NAPUKETTO_LICENSES`（各 @napuketto/* 的 MIT LICENSE 拼接收集，待遇对齐 NODE_LICENSE）。
- EmbeddedRuntime（:core）扩展：manifest 含 `napukettoZip` 条目 → 解压到
  `bin/napuketto/node_modules/`（JDK ZipInputStream；entry 名 normalize 包含检查防
  zip slip；哨兵文件 `.kurobridge-install.json` 记 zip sha256 幂等复用/升级重建）。
- 红线：zip 内只有 npm 发布物；wrapper.node / QQ 安装包 / QQNT 二进制绝不出现
  （验收 grep 证据）。

### vitest 策略

- spawner：注入假 spawnFn（记录 argv/env/stdio）+ 假平台，覆盖分支校验、env 组装、
  退出回调、taskkill 调用形状；真进程链路留沙盒验收（无人值守不碰真 QQ 登录——考据：
  napuketto 的 SMOKE/PROBE 钩子均在真登录之后，无免登录烟测可用）。

### 实现回填（2026-09-14 验收后）

- **守卫语义分化（M4-04）**：无 `ws.port` 与 CLI 入口缺失 → `fatal`（error + exit(1)，
  WsBindError 同族）；非 Windows → `skip`（error 日志 + 不拉起，node 继续纯 WS 服务端，
  external 兜底）。`decideNapukettoLaunch` 返回三态 union（spawn/skip/fatal），守卫与
  路径解析纯函数化，bootstrap 的 `launchNapukettoBranch` 只接线。
- **spawner 报告点收敛**：exit 与 error 双事件（spawn ENOENT 只有 error）经
  `reported` 标志只报告一次；`stopping` 标志区分关停路径（不触发 onUnexpectedExit）。
- **关停接线**：`shutdown()` 统一路径（relay.dispose → qrWatcher.stop → napuketto.stop
  → terminate(stub)），shutdown 帧 / stdin EOF / SIGTERM 三入口共用。
- **QR watcher（src/qr-watcher.ts）**：2s 轮询 `cache/qrcode.png`（mtime+size 双指标，
  多账号取 mtime 最新）拷贝为 qr.png；URL 由 spawner `onQrUrl` 回调喂入（napuketto
  kernel 固定文案正则，best-effort）；`qr.json` tmp+rename 原子写；timer unref 不拖
  退出；拷贝失败（napuketto 覆写中）不更新基线、下轮自然重试。
- **沙盒证据（MVP4-NOTES §4）**：四层树实证（node→CLI→boot→self-host）、`[napuketto]`
  前缀日志、QR 落地 + 过期刷新、固定端口快速失败退避 3 次放弃、stop 树杀零孤儿、
  强杀 node T+1s 级联死、CLI 意外退出 → 看护器 1s 重启 → instance.lock 自愈接管。
