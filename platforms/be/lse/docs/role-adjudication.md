# lse 角色裁决册（2026-09-19，2026-09-19 平台落地波〔批次 2026-09-19-platforms〕线 1/4）

> 本文件是 lse 平台**角色拓扑的单一权威（SSOT）**。包级 `design.md`、实现代码、readme SOP 与
> `docs/DECISIONS.md` ADR-037 均以本册为准。裁决先于代码（治理铁律 3）。

## 1. 结论

**裁决：R2′——「WS 回环薄壳」**（任务书 R2「脚本薄壳」的回环变体）：

- QuickJS 壳（`src/`）：`mc.listen` 事件 → IPC 方言 JSON 帧 → `WSClient` 发往**本机回环**游戏通道；
  `broadcast`/`execute_command` 请求经同一通道回收执（`mc.runcmd` / `mc.runcmdEx`）。
- Node shim（`src/runtime/`，**本包领地内新代码**，非 `bridge/embedded` 改动）：`system.newProcess`
  fire-and-forget 拉起，宿主 **bridge/core 的 `KurobridgeServer` + `Relay`**（对 koishi 的真 WS 服务端），
  游戏通道 WS 连接包装为 core 的 `IpcChannel` 注入 Relay。
- 生命周期脐带：游戏通道 WS 断开 ⇔ shim 自杀（等价 JE 的 stdin-EOF 自杀，D-08）。
- 部署契约与 paper 同目录：`<BDS 根>/plugins/kurobridge/`（plugin.json + index.js）+
  `bin/node.exe` + `bin/index.mjs`。

对任务书 R2 的两处**显式偏离**（诚实记录）：

1. 传输介质：任务书假设 `newProcess` 暴露 stdin/stdout 管道（JSON-lines over pipes）——**实证不存在**；
   改用 WS 回环（`WSClient` → 127.0.0.1 游戏通道），帧方言不变（仍是 IPC 方言 JSON 帧）。
2. Node 侧宿主：任务书假设复用 `bridge/embedded` 的 bundle——该 bundle 入口 import 即自跑 `main()`
   且 `StdioIpcChannel` 依赖 stdin（无管道输入即 EOF 自杀），不可作为库复用；改为本包内 shim
   **复用 core 导出面**（`KurobridgeServer`/`Relay`/`CoreContext`/`parseConfig`/`defaultConfig`）自行组装。
   `bridge/**` 零改动，ADR-007 无损。

## 2. 背景矛盾（任务书预勘察 vs 实证）

包级 design.md 原方案「复用 core **客户端**接入 kurobridge WS 服务端」两头都不存在：

- core **没有客户端类**：`bridge/core/src/index.ts:36-69` 导出全集（本线亲自核实）无任何 `*Client`；
  `transport.ts:25`：「WS 服务端（宿主实现；kurobridge 永远是 WS 服务端角色，ADR-005/架构书 §1）」。
- LSE **当不了 WS 服务端**：类型包无 WS 服务端/无 TCP socket（见 §3 R2/R3 证据）。

## 3. 角色三路裁决表 + R2′

### R2（任务书推荐评估方向：管道薄壳）——**否决，声明层即死**

| 证据 | 原文 |
| --- | --- |
| `newProcess` 返回 `boolean`，非 Process 对象 | `@levimc-lse/types@2.18.7 src/SystemAPI/SystemCall.d.ts:40-51`：`function newProcess(process: string, callback: (exitcode: number, output: string) => void, timeLimit?: number): boolean`，JSDoc：「callback 程序进程**结束之后**返回数据使用的回调函数」 |
| 无 stdin 写入 API | 全类型包 grep 无任何向子进程 stdin 写入的成员；无 `Process` 类（`class Process` 零命中） |
| 无流式读子进程 stdout | 唯一输出通道是进程死后一次性 `output: string`（stdout/stderr 合流与否、编码、截断均未知） |

结论：**「QuickJS 壳 + node 子进程 + stdin/stdout JSON-lines IPC」在声明层被否死**，与 endstone/Java
薄壳（有真管道）不同构。

### R3（进程内跑 core + 适配传输层）——**否决**

| 证据 | 原文 |
| --- | --- |
| 无 WS/TCP 服务端 | 全类型包无 WS server 类；`HttpServer`（`Network.d.ts:227-350`）只有 HTTP 方法路由（`onGet/onPost/...` + `listen(addr, port)`），**无 WebSocket upgrade 声明** |
| core 传输面是 WS 形状 | `transport.ts:26-31`：`WsServer { start(): Promise<number>; stop(); onConnection(WsConnection) }`——HTTP 长轮询适配需改 core（本线领地外） |

结论：进程内无服务端 socket 可承载 core 的 `WsServer` 抽象；适配即改 core，违反 ADR-007 领地约束。

### R1（lse = WS 客户端、平台侧建服务端）——**否决（与任务书同判）**

- 破坏 ADR-005 不变量（WS 服务端必须由游戏侧部署体宿主）。
- 需 koishi 侧/独立 hub 新能力（别的仓），超出本线范围。
- 仍缺游戏事件词汇：`player_join/quit/death` 等只存在于 IPC 方言（`ipcNodeInboundFrame`），
  WS 对端协议入站集是 `hello/ping/chat/command/query`（`WS_INBOUND_TYPES`）——平台侧建服务端也接不住游戏面。

### R2′（裁决采纳：WS 回环薄壳）——**成立依据**

| 能力 | 证据 | 用途 |
| --- | --- | --- |
| `system.newProcess`（fire-and-forget，`timeLimit` 缺省 -1 不限时） | `SystemCall.d.ts:40-51` | 拉起 node shim 长驻进程；退出回调 `(exitcode, output)` 恰好充当崩溃通知 |
| `WSClient` 全双工客户端 | `Network.d.ts:62-147`：`connect/connectAsync/send/listen('onTextReceived'/'onError'/'onLostConnection')/close` | 壳 ↔ shim 游戏通道（127.0.0.1 回环）；`onLostConnection` 充当管道断裂信号 |
| `file.readAllSync` / `ll.getCurrentPluginInfo().filePath` | `File.d.ts` 静态方法；`ScriptAPI/Li.d.ts:27` `filePath: string`（插件路径） | 读 config.json token（若采配置令牌方案）；推导 BDS 根路径 |
| `mc.runcmd` / `mc.runcmdEx` | `GameAPI/Command/mc.d.ts:11-29`，Ex 返回 `{success, output}`（隐藏执行） | broadcast → `say`；execute_command → `runcmdEx` 回执 |
| `mc.listen` 四事件 + `Player.realName` + `mc.getOnlinePlayers()` | `PlayerEvents.d.ts:11/14/20-23/32-35`；`Player.d.ts:28/1019` | 事件桥接 |
| QuickJS 可跑 zod + protocol + core | core「零 Node API」（`transport.ts` 头注）；`@kuro-bridge/protocol` dist 无 `node:` 导入（zod 为 external 但 zod 本体纯 JS，实测 0 处 Node API 引用） | 帧编解码、业务核心整包进 QuickJS 侧 bundle 与 node 侧 bundle |

### 不变量核对

| 不变量 | 状态 |
| --- | --- |
| ADR-005「kurobridge 永远是 WS 服务端角色」 | **保持**。服务端仍由游戏侧部署体宿主（node shim 是游戏壳拉起的子进程，与 JE 的 node 子进程同位）；koishi 仍是 WS 客户端。拓扑与 JE 全同，仅宿主↔node 通道从 stdio 换成回环 WS |
| ADR-007 core 平台无关 | **保持**。core 仅被导入，零改动；`IpcChannel` 是传输无关接口（`transport.ts:33-40`），注释「Java 薄壳 ↔ Node 的 stdin/stdout」描述的是 JE 实例而非接口约束 |
| 领地 | **保持**。全部新代码在 `platforms/be/lse/**`；`bridge/**`、`platforms/je/**`、`platforms/be/endstone/**` 只读未动 |
| 协议 SSOT（KuroProtocol 0.4.0） | **保持**。游戏通道两端用同一 `@kuro-bridge/protocol` zod schema 与 `encodeFrame`，无新增线上词汇，仅新增一种传输绑定（IPC 方言 over WS text frame，一帧一 message） |
| 版本号 | 不动（0.1.0，无发版） |

## 4. R2′ 契约（实现与测试的机械联动基准）

### 4.1 拓扑

```
koishi(WS 客户端) ──WS──> Node shim ──IpcChannel(游戏通道 WS, 127.0.0.1)──> QuickJS 壳(WSClient)
                            │  KurobridgeServer + Relay + WsServer-over-ws        │ mc.listen / mc.runcmd
                            └─ config.json(parseConfig)                          └─ BDS
```

### 4.2 拉起与鉴权

- 壳推导路径：假设 `ll.getCurrentPluginInfo().filePath` = **插件目录** `<root>/plugins/kurobridge`
  （语义待真机核实，§6.4 首项）：`root = dirname(dirname(filePath))`；`binDir = <root>/plugins/kurobridge/bin`；
  node = `<binDir>/node.exe`（Linux `node`）。若真机实证 filePath 是主脚本文件路径，则多取一层 dirname。
  实现与测试按「目录」解释锚定（与部署布局 §4.1 自洽；实现期勘误 2026-09-19）。
- 拉起：`system.newProcess("<node> <binDir>/index.mjs --server-root <root> --game-port N --game-token T>", exitCb, -1)`；
  `N` = 壳每轮尝试随机选的临时端口（20000-40000），`T` = 壳每轮生成的会话令牌（`system.randomGuid()` 去连字符；
  勘误 2026-09-19：类型包实证 randomGuid 在 `system` 命名空间，非 `data`）。
- shim 先绑 koishi WS（`config.ws?.port ?? 0` 动态端口），再绑 `127.0.0.1:N` 游戏通道；
  游戏通道**首帧必须等于 `T`**（明文，非 JSON），错误令牌 → close 1008；鉴权后两端一帧一 JSON（IPC 方言）。
- shim 就绪后经游戏通道发 `ready{wsPort, autoRestart}`（现成 `readyFrame` schema；wsPort = koishi WS 实际端口）。
- 绑定失败（任一端口）→ stderr error + `process.exit(1)`（对齐 embedded L191）。

### 4.3 帧面（全为协议包现成 schema，`encodeFrame` 编码）

| 方向 | 帧 | 壳侧动作 |
| --- | --- | --- |
| 壳→shim | `game_chat{playerName: realName, content}`、`player_join{playerName}`、`player_quit{playerName}`、`player_death{player, message: ""}` | 通道开启时逐事件发；通道关闭时静默丢弃（对齐 JE `ipc == null → return`） |
| shim→壳 | `broadcast{id, body:{message}}` | `mc.runcmd("say " + message)` → 立即回 `broadcast_result{id, {ok:true}}`（对齐 JE 立即回执语义） |
| shim→壳 | `execute_command{id, body:{command}}` | `mc.runcmdEx(cmd)` → 回 `execute_command_result{id, {ok: success, output: output 按行拆分}}`（对齐 JE v0.3.0 执行完回执） |
| shim→壳 | `ready{wsPort, autoRestart}` | 握手判据 + autoRestart 交看护器 |
| 壳→shim | `shutdown{reason}` / `config_reload` / `status` | **均不做**：LSE 类型包无 onServerStopped（停服由游戏通道断开兜底）、无插件重载触发点、无 TPS API（不造假数据）。差异已列入 §6 |

### 4.4 看护器（壳内，对齐 JE NodeSupervisor `Options.defaults()`）

- 一次尝试 = newProcess → `connectAsync` + 等 `ready`（总上限 30s，对齐 JE `startTimeout`）→ 开通事件桥接。
- 失败源：`newProcess` 返回 false（node 缺失）/ 退出回调先于 ready / WS `onError`/`onLostConnection` / 30s 超时。
- 退避：1s / 5s / 15s；10 分钟滑动窗累计 3 次失败 → 放弃（WARN/SEVERE 分级对齐 JE），停止自动重启。
- `ready.autoRestart == false`（缺省按 true，对齐 JE `handleReady`）→ 崩溃只 WARN 不重启。
- 放弃后：功能禁用（事件静默丢弃、无请求进来），服务器继续跑；`mc.regConsoleCmd("kurobridgeretry")`
  手动重看护（SOP 记载）。
- 每次重启全新 spawn（新端口新令牌）；在途请求随通道死亡自然失效（Relay 侧超时兜底）。

### 4.5 关机与孤儿

- 优雅：壳发 `shutdown{reason}`（预留，当前无触发点）→ 关 WS；shim 关机主路径 = **游戏通道断开** →
  `onShutdown` → `shutdown(0)`（对齐 embedded stdin-EOF 语义，D-08）。
- BDS 停服/崩溃 → 游戏通道 TCP 断 → shim 自杀，**无孤儿**（不依赖 newProcess 的杀死能力——它没有）。
- 已知限制：无 kill API → 若 node 卡死（WS 不 accept），壳 30s 超时放弃该次尝试后旧进程只能等 BDS 退出
  （或 SOP 手工 taskkill）；config 显式固定 `ws.port` 时旧进程会占位导致后续绑定失败——SOP 明示。

## 5. 与 JE（paper）语义对照与差异清单

| 语义 | JE（基准） | lse（本线） | 判定 |
| --- | --- | --- | --- |
| node 缺失 | spawn IOException → 看护退避 | `newProcess` false → 看护退避 | 对齐 |
| 崩溃/断管 | stdout EOF / stdin 写失败 → tearDown → 退避 | 退出回调 / `onLostConnection` → 退避 | 对齐 |
| 放弃 | 600s 窗 3 次 → SEVERE + 手动恢复提示 | 同参数（1s/5s/15s，10min 窗，3 次） | 对齐 |
| ready 握手 | 30s 超时，autoRestart 缺省 true | 同 | 对齐 |
| 降级不崩服 | 监听器判空静默跳过，插件保持加载 | 同（通道关闭时事件静默丢弃） | 对齐 |
| status 帧 | join/quit 后补发 {tps,online,uptime} | **不做**（无 TPS API；不造假数据） | 差异，koishi 侧在线状态不更新 |
| 死亡消息 | Bukkit 死亡文案，null→空串 | **恒空串**（onPlayerDie 无文案参数） | 差异 |
| config_reload | /reload 触发 | **不做**（无触发点；shim ConfigStore.load 仍支持显式帧） | 差异 |
| 命令输出 | CollectingCommandSender 收集 | `runcmdEx` 返回串按行拆分 | 近似，语义待真机 |
| 关机通知 | Java 主动 shutdown 帧 + 关 stdin | 无停服事件，依赖通道断开兜底 | 等效（脐带） |
| 杀子进程 | destroyForcibly | **无此能力**（类型包无 kill） | 差异，SOP 兜底 |

## 6. 待真机清单（本线不做真机，SOP 背书项）

1. `newProcess` 参数串解析/quoting 规则、子进程工作目录与环境继承（shim 已用 `--server-root` 显式传参消解 cwd 依赖，但 argv 切分规则未证实）。
2. `WSClient` 回环连接（`ws://127.0.0.1:<port>` 目标串格式）与 `listen` 回调线程语义（游戏主线程还是网络线程；若后者，`mc.runcmd` 安全性需实测）。
3. `runcmdEx` 输出串的编码/合流/截断语义；`mc.runcmd("say …")` 广播的实际呈现。
4. `ll.getCurrentPluginInfo().filePath` 在 LSE 下的实际取值（主脚本绝对路径假设）与 `system.randomGuid` 格式。
5. BDS 硬杀时游戏通道断开能否及时触发 shim 自杀（TCP RST 时序）；LeviLamina 是否替子进程兜底 reap。
6. 长驻 node 进程在 `newProcess` 下无回调期内是否被 LSE/BDS 干扰（信号、控制台）。
7. `ready` 前退出回调的 `output` 内容可读性（引导失败的 stderr 是否并入）。

## 7. 裁决记录

- 裁决人：本线主对话（2026-09-19）；证据核实方式：2+1 并行 Explore subagent 侦察 + 主对话亲核
  `SystemCall.d.ts`/`Network.d.ts`/`PlayerEvents.d.ts`/`Li.d.ts`/`transport.ts`/`index.ts(core 导出)`/
  `business/config.ts` 原文。
- 升级：本册结论收尾时追加为 `docs/DECISIONS.md` ADR-037（追加式，不动他人内容）。
- 若真机背书推翻 §6 任一前提（尤其 1/2），本册作废重裁，回到 R1 停线预案。
