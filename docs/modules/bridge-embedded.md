# bridge/embedded

`@kuro-bridge/bridge-embedded`：Node 引导层（bootstrap）。它把 `bridge/core` 装配成可执行进程，负责所有 Node API 落点，并可选拉起内嵌 napuketto 协议端。

## 启动顺序

[`src/index.ts`](../../bridge/embedded/src/index.ts)：

1. 创建 stderr logger 与 stdin/stdout IPC 通道。
2. 读取 `plugins/kurobridge/config.jsonc`（相对 `process.cwd()`，即服务器根；JSONC，ADR-040）。缺失 → 生成带注释模板（含随机 token）；旧 `config.json` 回退读取不迁移；非法 → 记 error 后以默认配置降级运行，等服主修复。
3. 组装 `CoreContext`（`serverId` = `config.server.id ?? "kurobridge"`，`version` = `BRIDGE_VERSION`，`token` = `config.token`，Node 版 `Clock`/`Scheduler`，`randomUUID`）。
4. 创建 `BindingTable`、`AdminTable`、`KurobridgeServer`、`Relay`。
5. `server.start()`：按 `config.ws` 绑 WS 服务端（缺省 `listen(0)` + 全接口）。失败 → 明确 error + `exit(1)`，由薄壳看护器退避重试。
6. 向 stdout 发 `ready { wsPort, autoRestart }`。
7. 协议端分支：
   - `embedded.napuketto.enabled === true` → 守卫后拉起 napuketto CLI；
   - 否则 `KUROBRIDGE_STUB_PEER` 非空 → 拉起 stub 协议端（开发/测试用，参数为 WS 端口）；
   - 否则按 external 形态运行，等待外部对端连入。
8. 注册 `stdin` EOF / `SIGTERM` → 统一 `shutdown()`。

## 模块

| 文件 | 职责 |
| --- | --- |
| `config-store.ts` | `ConfigStore` 的 Node 实现：读 `plugins/kurobridge/config.jsonc`（JSONC 解析，ADR-040）；缺失写注释模板（`wx`，含随机 token，不覆盖）；旧 `config.json` 回退；mtime+size 轮询（缺省 2s，`unref`）；解析失败保留旧配置 |
| `ipc-stdio.ts` | `IpcChannel` 的 stdin/stdout 实现；stdout 只写 JSON-lines；stdin EOF 触发 `onClose` |
| `logger.ts` | Node 侧日志唯一 writer，格式 `[KuroBridge][node][LEVEL]`；只写 stderr |
| `node-platform.ts` | `Clock` / `TimerScheduler` 的 Node 实现；所有定时器 `unref()` |
| `ws-server.ts` | `ws` 库实现 `WsServer`/`WsConnection`；子协议 `kurobridge-ws.v1`；绑定失败 `WsBindError` |
| `napuketto.ts` | napuketto CLI 拉起（env 钉 single-line + 关 banner）、stdio 捕获与记录重组、QR URL 探测、停止哨兵优雅关停 + `taskkill /T /F` 树杀兜底（ADR-039） |
| `qr-watcher.ts` | 扫 napuketto 数据目录的 `cache/qrcode.png`，拷贝为 `qr.png` 并原子写 `qr.json` |
| `version.ts` | `BRIDGE_VERSION` 单点；与根 `package.json` 等六点由门禁对齐 |

## napuketto 分支

`decideNapukettoLaunch()` 是纯函数，决定 `spawn | skip | fatal`：

| 条件 | 结果 |
| --- | --- |
| 非 Windows | `skip`：记 error，继续做纯 WS 服务端（external 对端不受影响） |
| `ws.port` 未配置 | `fatal`：连接 url 静态拼入，动态端口无法告知；配置未就绪语义，进程 `exit(2)`（ADR-041） |
| CLI 入口 `<bin>/napuketto/node_modules/@napuketto/cli/dist/index.mjs` 不存在 | `fatal`：配置要求嵌入形态而产物缺失，`exit(2)`（ADR-041） |
| 其余 | `spawn`：解析 configPath / dataDir 后拉起 |

拉起行为：

- 用当前 `process.execPath` 执行 CLI 入口，`stdio: ["pipe","pipe","pipe"]`（不能 inherit，stdout 是 IPC 通道）。
- 注入 `NAPKETTO_DATA` 与日志 env；配置注入按 CLI 版本分流（ADR-041）：支持内联注入的版本（0.3.0+）经 `NAPKETTO_CONFIG_JSON` 整包注入（qq/url/token，token 即主配置值），旧版回退 `NAPKETTO_CONFIG` 指路 TOML 并 WARN 提示升级。其余环境原样透传。
- 数据目录缺省 `plugins/kurobridge/napuketto-data`；TOML 路径仅旧版 CLI 回退形态使用；相对路径以服务器根为基准，也接受绝对路径。
- stdout/stderr 逐行捕获，带 `[napuketto]` 前缀写入 stderr logger；顺带 best-effort 识别 QR URL。
- CLI 配置校验失败（上游 `exit 78`）→ bootstrap `exit(2)`，看护器不重启（ADR-041）；其余意外退出 → bootstrap `exit(1)`，交薄壳看护器退避重启（quick-login 由 napuketto 侧恢复）。
- 优雅关停：Windows `taskkill /PID <pid> /T /F`，等退出最多 5s；强杀本 Node 进程时，CLI 树随 Node 26 的 Job Object 级联结束。

## QR 交接

napuketto 的登录二维码以文件形式交接，零协议变更：

- 轮询 `<dataDir>/<uin>/cache/qrcode.png`（多账号取 mtime 最新），复制到 `plugins/kurobridge/qr.png`。
- 任一信号（新 PNG 或捕获到的 URL）更新时原子写 `plugins/kurobridge/qr.json`：
  ```json
  { "pngPath": "...\\qr.png", "url": "https://...", "detectedAt": 1750000000000 }
  ```
- 消费方是 `/kurobridge qr`（paper / fabric 只读展示）。二维码约 120s 过期，watcher 会随 napuketto 刷新继续覆盖文件。

## 关停

统一 `shutdown(exitCode)`：

1. `relay.dispose()`（拒绝在途 IPC 请求）。
2. 停 QR watcher。
3. `napuketto.stop()`（停止哨兵优先，10s 超时回退树杀）。
4. 杀 stub（若有），最多等 3s，然后 `process.exit`。

触发源：Java/C++ 发的 `shutdown` 帧、stdin EOF、`SIGTERM`。Java 侧 `NodeIpc.shutdown` 在发帧后还会关 stdin，并在 5s 后 `destroyForcibly()` 兜底。

## 产物与打包契约

`pnpm -r build` 产出 `bridge/embedded/dist/index.mjs`。`toolings/packaging/embed.ts` 把它与 node.exe、许可、napuketto 嵌包一起写入 `platforms/je/{paper,fabric}/src/main/resources/embedded/`：

| 文件 | 说明 |
| --- | --- |
| `node.exe` | Node 26.7.0 win-x64，sha256 对官方 `SHASUMS256.txt` |
| `index.mjs` | esbuild 单文件 bundle |
| `NODE_LICENSE` | Node 许可 |
| `manifest.json` | `{ nodeVersion, files: {name: sha256}, napukettoZip?: {name, sha256, cliVersion} }` |
| `napuketto.zip` | `@napuketto/cli` 及其依赖树（仅 npm 发布物） |
| `NAPUKETTO_LICENSES` | 嵌包许可聚合 |

Endstone 平台不自动接入该链路：Endstone 的 `bin/` 由真机 SOP 手动预置四件（node.exe / index.mjs / NODE_LICENSE / manifest.json），不含 napuketto。

## 环境变量

| 变量 | 消费方 | 作用 |
| --- | --- | --- |
| `KUROBRIDGE_BUNDLE` | 平台薄壳 | 开发覆盖：直接使用指定 bundle，跳过 JAR 解压 |
| `KUROBRIDGE_NODE` | 平台薄壳 | 开发覆盖 node 路径；JAR 模式缺省 `plugins/kurobridge/bin/node.exe` |
| `KUROBRIDGE_STUB_PEER` | 薄壳 + 本包 | stub 协议端脚本路径；设置即注入。JAR 模式不设置 = external 形态 |
| `NAPKETTO_CONFIG` / `NAPKETTO_DATA` | napuketto CLI | 由本包注入，指向 TOML 与数据目录 |
| `KUROBRIDGE_NODE_DIST_BASE` / `KUROBRIDGE_NODE_CACHE_DIR` / `KUROBRIDGE_NPM_REGISTRY` / `KUROBRIDGE_NODE_DIST_STRICT` | `toolings/packaging/embed.ts` | 下载镜像、缓存目录、napuketto 安装镜像、SHASUMS 严格模式 |

## 测试

vitest 覆盖 `logger`（行格式/级别）、`napuketto`（守卫决策、spawn/env 契约/哨兵关停与树杀兜底/QR URL/记录重组/异常退出）、`qr-watcher`（PNG 轮询、原子写、多账号取最新）、`ws-server`（动态/固定端口、绑定失败、子协议）。
