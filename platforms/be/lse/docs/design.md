# platforms/be/lse 设计（LeviLamina LSE 平台适配）

> 本文件是包级设计文档（AGENTS.md：写代码前先更新对应包的 `docs/design.md`，设计先行）。
> 角色拓扑的单一权威（SSOT）是同目录的 `role-adjudication.md`（R2′「WS 回环薄壳」裁决册）；
> 本文与其冲突之处以裁决册为准。

## 职责

KuroBridge 的 LeviLamina（BDS）平台适配：QuickJS 壳只做事件桥接与传输（不做业务），业务核心
（`bridge/core`）跑在本包拉起的 Node shim 子进程内，对 koishi 提供真 WS 服务端；平台消息
（群聊 ↔ 游戏聊天）经壳 ↔ shim 之间的本机回环游戏通道往返。

## 角色拓扑（SSOT：role-adjudication.md §4）

裁决册结论 R2′「WS 回环薄壳」：壳（`src/`）用 `mc.listen` 收事件 → IPC 方言 JSON 帧 → `WSClient`
发往本机回环游戏通道；Node shim（`src/runtime/`）由 `system.newProcess` fire-and-forget 拉起，
宿主 bridge/core 的 `KurobridgeServer` + `Relay`，把游戏通道 WS 包装为 core 的 `IpcChannel`。

```
koishi(WS 客户端) ──WS──> Node shim ──游戏通道 WS(127.0.0.1 回环)──> QuickJS 壳(WSClient)
                            │  KurobridgeServer + Relay               │ mc.listen / mc.runcmd
                            └─ config.json(parseConfig)               └─ BDS
```

ADR-005 不变量保持：WS 服务端仍由游戏侧部署体宿主（shim 是壳拉起的子进程，与 JE 的 node 子进程
同位），koishi 仍是 WS 客户端；仅宿主 ↔ node 通道从 stdio 换成回环 WS。

契约要点（机械基准见裁决册 §4，此处仅摘要）：

- **拉起与鉴权**：壳每轮随机选游戏端口 N（20000-40000）、生成会话令牌 T（`system.randomGuid` 去连
  字符），`newProcess("<node> <bin>/index.mjs --server-root <root> --game-port N --game-token T")`
  拉起 shim；游戏通道首帧必须等于 T（明文，非 JSON），错误令牌 → close 1008。koishi 侧鉴权走
  config.json 的 `token`（hello 帧比对），与本会话令牌无关。
- **帧面**：全部为 `@kuro-bridge/protocol` 现成 schema（`encodeFrame` 编码，KuroProtocol 0.4.0）。
  上行 `game_chat` / `player_join` / `player_quit` / `player_death`（死亡文案恒空串）；下行
  `broadcast`（→ `mc.runcmd("say …")`，立即回 `broadcast_result`）与 `execute_command`（→
  `mc.runcmdEx`，输出按行拆分回执）。`shutdown` / `config_reload` / `status` 均不做——LSE 无
  onServerStopped、无插件重载触发点、无 TPS API，不造假数据（与 JE 的差异清单见裁决册 §5）。
- **生命周期脐带**：游戏通道 WS 断开 ⇔ shim 自杀（等价 JE 的 stdin-EOF 自杀，D-08）——BDS 停服/
  崩溃即通道断，shim 随之退出，无孤儿。壳内看护器对齐 JE NodeSupervisor：ready 握手 30s 上限，
  失败退避 1s / 5s / 15s，10 分钟滑动窗累计 3 次失败放弃（此后 `kurobridgeretry` 控制台命令手动
  重看护）；每次重启全新 spawn（新端口新令牌）。

## 硬性约束

- **LSE TS 化**（ADR-012）：TS 源码 → esbuild 编译为 JS → LeviLamina 加载（LSE 内核是 QuickJS，
  不原生跑 TS）。产物 target ES2020、无 tslib/装饰器（`erasableSyntaxOnly` 保证），QuickJS 可直接跑。
- **复用 `bridge/core` 零改动**（ADR-007）：core 仅被导入，`IpcChannel` 是传输无关接口；改 core 即越领地。
- **QuickJS 侧禁 `node:` 内建**：壳 bundle 不允许任何 Node API（core 本身零 Node API），esbuild
  `--platform=neutral` 兜底拦截；shim（`src/runtime/`）跑在真实 Node，不受此限。
- 使用官方 TS 声明 `@levimc-lse/types`（`newProcess` / `WSClient` / `mc.listen` 等的事实契约）。

## 目录规划（实况）

```
src/                    # QuickJS 壳 → dist/index.js（esbuild IIFE / ES2020）
├── index.ts            # 入口：ll.registerPlugin + bootstrap（异常只 log 不崩 BDS）+ kurobridgeretry 命令
├── lse-env.ts          # LSE 全局唯一触点：newProcess / WSClient / mc.listen / runcmd(Ex) / randomGuid / 日志
├── frames.ts           # 事件帧 encodeFrame 包装 + decodeHostInbound 两段式解析（失败一律 null）
├── game-channel.ts     # 游戏通道：WSClient → 127.0.0.1 回环 + 首帧令牌 + 等 ready（30s deadline）
├── supervisor.ts       # 看护器：退避 1s/5s/15s / 10min 窗 3 次放弃 / autoRestart 尊重 / manualRetry
├── bridge-host.ts      # 一次尝试编排：端口+令牌生成、路径推导（filePath→root/bin）、newProcess、握手、装配
├── event-bridge.ts     # mc.listen 四事件桥接 + broadcast（say）/ execute_command（runcmdEx）回执
└── runtime/            # Node shim → dist/bin/index.mjs（跑在真实 Node，esbuild ESM）
    ├── index.ts        # argv 解析（--server-root/--game-port/--game-token）、core 组装、ready 帧、脐带
    ├── ws-server.ts    # core WsServer 接口的 ws 包实现（koishi 侧，kurobridge-ws.v1 子协议）
    ├── game-gate.ts    # 游戏通道 WS 服务端（127.0.0.1:N，单租户，首帧令牌，错→1008）→ core IpcChannel
    ├── config-store.ts # plugins/kurobridge/config.json 读取（parseConfig，缺失写默认）+ watch（core ConfigStore）
    ├── platform.ts     # NodeClock / NodeScheduler（定时器 unref）
    └── logger.ts       # stderr 日志（[KuroBridge][node][level] 行格式，对齐 embedded）
```

## 与 platforms/be 家族的关系（ADR-020）

`platforms/be` 是 **BE 服务端家族**，按具体平台分子目录，当前含两条路线：

- `endstone/`：Endstone **C++ 薄壳**路线——与 `platforms/je` 的 Java 薄壳完全同构（事件桥接 +
  内嵌 Node 子进程 + stdin/stdout JSON-lines 真管道）。
- `lse/`（本目录）：同一薄壳架构的 **WS 回环变体**——差异一句话：LSE `newProcess` 不暴露
  stdin/stdout 管道，宿主 ↔ node 通道从 stdio 换成 127.0.0.1 回环 WS，帧方言与生命周期语义
  （脐带）不变。

**Nukkit 已剔除**（2026-08-11，ADR-020：Java 服务端、插件生态非主流）；PocketMine-MP（PHP）
工具链不匹配，明确不做。

## 依赖

- `@kuro-bridge/bridge-core`（workspace:*）——业务核心，壳与 shim 复用其导出面
  （`KurobridgeServer` / `Relay` / `CoreContext` / `parseConfig` / `defaultConfig`）。
- `@kuro-bridge/protocol`（^0.4.0，npm 包，发布自姊妹仓 KuroProtocol，ADR-035）——消息 schema 与 `encodeFrame`。
- `@levimc-lse/types`（devDep）——LSE 全局对象类型。
- `ws`（^8.18.0）+ `@types/ws`——shim 的 koishi WS 服务端实现（core `WsServer` 接口的宿主绑定，版本对齐 bridge/embedded）。
- esbuild + typescript（devDep）——两份产物的打包与检查（壳 IIFE / ES2020 / `platform=neutral`；shim ESM）。
- 运行期：Node ≥ 20（服主自备，置于 `plugins/kurobridge/bin/`，见包内 readme 部署清单）。
