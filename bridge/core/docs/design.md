# bridge/core 设计（@kuro-bridge/bridge-core）

> 本文件是包级设计文档（AGENTS.md：写代码前先更新对应包的 `docs/design.md`，设计先行）。

## 职责

kurobridge 的业务核心 + `kurobridge-ws` 协议服务端（ADR-005：业务在 Node 侧）。

- 绑定/白名单/指令权限/转发规则等业务逻辑。
- WS 服务端：握手、鉴权、心跳、UUID 请求-响应、`msgContinue` 流式回报、指数退避重连。
- 与 Java 薄壳的 stdin/stdout JSON-lines IPC（ADR-010）。

## 硬性约束（AGENTS.md 硬约束 #3，ADR-007）

- **零 Node API**：禁止 `ws`/`process`/`fs`/`pino` 等。
- 传输层抽象为可注入接口：`WsServer/WsClient`、`Logger`、`IpcChannel`。
- target ES2020（根 tsconfig 已锁），保证 QuickJS（LSE）可跑。
- `erasableSyntaxOnly`：产物无 tslib/装饰器依赖。
- core 无全局单例（对齐 Napuketto ADR-015 推论）：logger/connection/state 均为实例化对象，由 `CoreContext` 持有。

## 目录结构

```
src/
├── __tests__/         # vitest 单测（server / relay / reconnect 等）
├── business/          # 绑定列表 / 白名单 / 权限 / 转发规则（纯逻辑：bindings / admins / config / forwarding）
├── clock.ts           # Clock / TimerScheduler 注入接口 + 测试用 ManualClock / ManualScheduler
├── context.ts         # CoreContext：注入的 logger/传输层/配置持有者
├── index.ts           # 聚合导出
├── relay.ts           # 转发：IPC ↔ WS 帧路由（game_chat → chat、chat → broadcast 等）
├── server.ts          # KurobridgeServer：WS 服务端（握手/心跳/连接生命周期）
├── test-fakes.ts      # 测试假件（传输层 / IPC 的内存实现）
└── transport.ts       # WsServer / WsConnection / IpcChannel / Logger 可注入接口
```

## 实现顺序（STATUS.md 第 2 步细化）

1. 传输层接口 + `CoreContext`。
2. 握手状态机（hello/hello_ack，含协议版本协商）。
3. 心跳 + 假连接检测。
4. chat 收发最小闭环。
5. 业务模块（绑定/白名单/权限/转发）。

## 依赖

- `@kuro-bridge/protocol`（^0.4.0，npm 包，发布自姊妹仓 KuroProtocol）——协议 schema（ADR-031/035）。

## 原型阶段（spike，2026-09-12）

> 任务书：`docs/history/PROTOTYPE-PROMPT.md` §4 阶段 2。完整设计不变，本节只标注原型裁剪。

最小闭环（connect → hello 握手 → 心跳 → chat 收发）：

- `src/context.ts`：`CoreContext`（注入 logger + serverId）。
- `src/transport.ts`：`WsServer` / `WsConnection` / `IpcChannel` / `Logger` 可注入接口（零 Node API）。
- `src/server.ts`：`KurobridgeServer` —— 握手状态机（awaitingHello → established/rejected）、心跳应答（ping→pong）、连接生命周期；协议版本不匹配 → `hello_ack` error + 关连接。
- `src/relay.ts`：假转发规则（占位业务）——IPC `game_chat` → WS `chat` 推给已握手对端；WS `chat` → IPC `broadcast` 请求（UUID 关联，等 `broadcast_result`）。
- `src/index.ts`：聚合导出。

原型裁剪：无鉴权 token、无 `bindings_updated`、无 msgContinue、无指数退避重连（对端 stub 自行重连）、心跳只做应答 + 空闲超时关连接（不做多阈值假连接检测）、业务模块仅 `relay.ts` 假规则。

## MVP 阶段一（2026-09-13）

> 任务书：`docs/history/MVP1-PROMPT.md` §3 阶段 2/3。本节是动代码前的设计定稿。

### 时钟/定时器注入（阶段 2）

core 平台无关（ADR-007）意味着 `setTimeout`/`Date.now` 也不能直接用——抽象为注入接口：

- `Clock`：`now(): number`（epoch 毫秒）。
- `TimerScheduler`：`schedule(delayMs, callback): CancelFn`（一次性定时器；宿主实现负责 unref，
  不阻止进程退出）。不引入周期定时器——空闲检测用「每次收帧重置一次性定时器」实现，减少泄漏面。

实现（`src/clock.ts`）：接口 + `ManualClock`/`ManualScheduler`（测试用，vitest 手动推进）。
Node 实现在 embedded 引导层。

### 超时健壮性（阶段 2）

- **hello 等待超时（默认 10s）**：连接建立即挂一次性定时器；超时仍未握手 → 关连接（1002）。
- **心跳空闲检测（默认 30s）**：任何收帧（含 ping/chat）刷新；超时无帧 → 判定断开、关连接（1001）。
  阈值均可配（`ServerOptions.timeouts`），0 = 禁用（测试用）。
- **IPC 请求超时（默认 10s，对齐 Java 侧）**：`Relay.forwardToGame` 在途请求挂定时器，超时以
  `IpcRequestError`（reason=timeout）拒绝。

### IPC 断连降级（阶段 2，候选 E，已落地）

三层可观测信号（不再静默丢弃）：`IpcChannel.isOpen`（只读健康快照）、`Relay.ipcOpen`（含
dispose 语义）、`KurobridgeServer.send*` 返回送达的已握手对端数（0 = 无人接收）。Java 侧配套：
`NodeIpc.sendGameChat` 返回 boolean，`/kurobridge send` 据此明确报错。消息排队/补发留 MVP-2。

### 业务最小闭环（阶段 3，已落地）

- `src/business/config.ts`：`ConfigStore` 注入接口（`load(): Promise<KurobridgeConfig>` /
  `watch(onChange): 取消订阅`——实现时 load 定形为异步，Node 侧 fs/promises 天然异步；宿主可
  同步实现后包 Promise 返回）、`parseConfig`（zod：`{channels: string[]}`，频道非空、去重保序、
  多余字段剥离）、`ConfigError`、`defaultConfig`。
- `src/business/bindings.ts`：`BindingTable` 纯逻辑（去重保序；`has`/`channels`/`replace`——
  replace 按集合语义判变化，重排不触发推送）。
- `src/business/forwarding.ts`：转发规则纯逻辑：
  - `platformChatTarget(channels, chat)`：未绑定频道 → null（丢弃，Relay 记 debug 日志说明原因）。
  - `gameEventChannels(channels)`：游戏事件 → 全部绑定频道（fan-out 目标列表；未来按频道/事件
    差异化规则在此扩展）。
- Relay 接入：`RelayOptions` 增 `bindings` + `configStore`；配置变更 → `BindingTable.replace`
  → 集合变化时推 `bindings_updated`；hello_ack 的 channelBindings 经 `ServerOptions.channelBindings`
  闭包实时取值（配置变更后新握手对端自动拿新列表）。

### v0.2 协议适配（阶段 1，已落地）

chat/broadcast 携带 channel、hello_ack 携带 channelBindings（`ServerOptions.channelBindings`
注入快照）、新增 join/leave/status/bindings_updated 的 send* 出帧；阶段 1 的 fan-out 用占位
频道假规则（`relay.ts` 的 FANOUT_PLACEHOLDER_CHANNEL），阶段 3 绑定表落地后移除。

## 债务清偿二（DEBT-2，2026-09-13）：断连清理与重连一致性

> 任务书：`docs/history/DEBT2-PROMPT.md` §1.2。范围限定：**只做清理与一致性的测试背书与补缺**，
> 不重构对端模型（单/多对端能力维持现状），不做消息排队补发。

### 现状梳理（设计核对结论）

- `KurobridgeServer.handleConnection` 的 `onClose` 已做：hello/idle 定时器取消 + peers 删除。
  握手被拒路径（`rejectHello`）先 cancelTimers 再 close，onClose 幂等二次清理无害。
- `Relay` 的 IPC onClose 已做：在途请求全部拒绝 + 定时器取消（`markDisposed`）。
- `server.stop()` 走 `connection.close(1001)` → onClose 清理；对异步 close 的真实实现，
  peers 先 clear、迟到 onClose 闭包仍能取消自身定时器（peer 引用捕获）——无泄漏路径。

### 本册补齐与证据（vitest）

断连状态一致性此前**无测试背书**，本册补 `reconnect` 行为测试（新文件或并入 server.test）：

1. **断开 → 重连 → 重新握手**：新连接全新 PeerState，hello_ack 携带**当前**绑定快照
   （配置在断开期间变更，新握手拿到新列表——`channelBindings` 闭包实时取值语义的回归证明）。
2. **送达数归零语义**：对端断开后 `send*` 返回 0（不抛错）；重连握手后恢复非 0。
3. **hello 超时/空闲超时断开后重连**：被服务端关掉的连接（1001/1002）同样触发完整清理，
   新连接不受旧状态污染（established 计数、定时器 pending=0）。
4. **反复 N 轮（连入→握手→断开）零泄漏**：`ManualScheduler.pendingCount === 0` 断言。
5. **Relay 侧**：IPC 断开时挂起请求拒绝且定时器取消（已有部分用例，补「断开→新 Relay
   实例（重启后）恢复转发」路径：dispose 状态不残留、新实例不受旧实例污染）。

发现缺口才改实现；预计实现零改动或极小补丁（设计上清理链已闭合）。

### ready.autoRestart 上报（协议 0.2.1）

`config.ts` 的 `parseConfig` 扩展：`runtime: { autoRestart: boolean }` 可选字段（缺省 true，
多余字段剥离语义不变）。本包只做 schema 与默认值；ready 帧扩展在 `@kuro-bridge/protocol`
（`readyBodySchema` 加 `autoRestart` 可选字段，版本 0.2.0 → 0.2.1 patch 顺延），上报在
bridge/embedded 引导层（配置 → ready body）。

### 实现回填（2026-09-13 验收后）

- 断连清理链核对结论：实现**零改动**即满足全部一致性用例（reconnect.test.ts 8 例）——
  onClose 清理/闭包实时快照/send 送达数语义本就闭合，本册补的是测试背书。
- `config.ts`：`runtime.autoRestart` 用 zod `.default(true)` 双层默认（runtime 段缺省
  或字段缺省都得到 true），`KurobridgeConfig` 形状新增必填 runtime 段（构造点全走
  defaultConfig/cfg 助手）。

## 债务清偿一（DEBT-1，协议 v0.3.0，2026-09-13）

> 任务书：`docs/history/DEBT1-PROMPT.md`。鉴权、兼容协商、query 本地作答、command 权限与透传、
> death fan-out、config_reload。协议帧形设计（原 `bridge/protocol/docs/design.md` 的 DEBT-1 节，
> 该册已随镜像退役移除）现以姊妹仓 KuroProtocol 为权威（其 `docs/peer-guide.md` / `docs/changelog.md`）。

### 鉴权 token（hello 校验）

- `CoreOptions` 增可选 `token`（`CoreContext` 存为 `readonly token: string`，缺省 `""` =
  不鉴权；exactOptionalPropertyTypes 下经 `?? ""` 归一）。bootstrap 从配置注入。
- `handleHello` 校验顺序：版本兼容（不兼容 → 既有 1002 路径）→ token（服务端配置非空
  token 且 hello 未带/带错 → `hello_ack ok:false "auth failed"` + close **1008**）。
- token 在 Node 进程生命周期内固定（boot 时注入）：`/kurobridge reload` 不刷新 token
  （改 token 需重启 Node；边界记录于 DEBT1-NOTES）。

### 版本协商落地

`server.ts` 的精确相等判断替换为 `isProtocolVersionCompatible(body.protocolVersion, PROTOCOL_VERSION)`；
`hello_ack` ok 体回服务端实际版本（现状不变）。

### WS 收帧改两段式解析（未知帧容忍的落点）

`handleMessage` 改为「`wireFrameSchema` 先取 type/id → 按 type 分发到具体 schema safeParse」：
已知类型（hello/ping/chat/command/query）解析失败 → warn 丢弃（既有行为不变）；未知类型 →
容忍路径（请求帧回 `<type>_result {ok:false,"unknown frame type"}`；`_result` 后缀不回执防乒乓；
事件帧 debug 忽略；均不断连，ADR-026）。

### query 本地作答（零 IPC 变化）

- status 缓存：`KurobridgeServer.sendStatus` 顺带缓存最近一帧（`latestStatus`，null = 尚未收到
  任何 status）——缓存更新只挂在既有 Relay→sendStatus 路径上，不新增 IPC 帧也不改推送时机
  （维持 M-04 事件驱动决策）。
- `query status` → 命中缓存回 `{ok:true, data: StatusBody}`；未命中 `{ok:false,"no status yet"}`。
- `query bindings` → `{ok:true, data: channelBindings()}`（与 hello_ack 同一闭包，实时取值）。

### command 管理员判定与 IPC 透传

- 协议层（`server.ts`）：新增 `onCommand(handler)` 订阅。handler 签名
  `(body: CommandBody) => Promise<CommandResultBody>`；server 负责以同 id 回 `command_result`，
  handler 异常（含 IpcRequestError）统一转为 `{ok:false, error}` 回执。server 零业务判定。
- 业务层（`relay.ts`）：管理员判定在 handler 内完成——
  - `business/admins.ts` 新增 `AdminTable`（与 BindingTable 同模式：构造注入初始值、
    `replace` 随配置变更/重载刷新、`isAdmin(channel, userId)`）。
  - 非管理员 → `{ok:false, error:"forbidden"}` + warn 日志（不触发 IPC）。
  - 管理员 → 既有 IPC 请求机制（pending map 的 resolve 类型扩宽为 `CommandResultBody`，
    承载 output）→ `execute_command_result` 的 ok 体（含 output）原样透传进 `command_result`；
    IPC 失败/超时/ok:false 经既有拒绝路径由 server 转为 `{ok:false, error}`。

### death fan-out

Relay 收 IPC `player_death` → 复用 join/leave 同一条 `fanoutGameEvent` 路径按绑定频道逐帧
调 `server.sendDeath({channel, player, message})`。字段命名沿任务书原文（`player`，与
join/leave 的 `playerName` 不一致，protocol design 已记录）。

### config_reload 处理（复用 watch 路径）

Relay 收 IPC `config_reload`（事件帧，无 id）→ `configStore.load()` → 复用
`handleConfigChange`（admins.replace + BindingTable.replace + 集合变化时推
bindings_updated）→ load 失败 error 日志、保留旧值等下次修复。注意 handleConfigChange
需**无条件**刷新 admins（绑定集合未变时 admins 仍可能已变）。

### config schema 扩展

`KurobridgeConfig` 增 `token: string`（缺省 `""`）与 `admins: readonly AdminMapping[]`
（`{channel, users}`，缺省 `[]`；entry 按 channel 去重保序、entry 内 users 去重保序，
语义对齐 channels）。**runtime 段原样保留**（DEBT-2 语义不动，复跑指引 2）。`defaultConfig`
同步扩展（生成的默认配置文件自含字段说明作用）。

## MVP 阶段三（MVP-3，2026-09-13）：config 增 ws 监听段（SSOT 形状）

> 任务书：`docs/history/MVP3-PROMPT.md`。WS 监听参数（host/port）是**宿主事务**（红线 2）：
> core 只提供配置形状 SSOT 与解析，消费方在 bridge/embedded 引导层；`KurobridgeServer` 与
> `WsServer` 接口**不感知**监听参数——`start()` 返回实际端口、ready 帧照报实际端口的
> 契约不变，本包其余零改动。

- `configSchema` 增顶层可选段 `ws: { host?: string, port?: number }`：
  - **整段缺省 = 现状不变**（动态端口、不指定绑定地址——全部接口）。
  - `port`（1-65535 整数）→ 固定端口（external 对端连入点）；`host`（非空串）→ 绑定指定
    地址（如 `127.0.0.1` 只听本机）；**只配 host 不配 port = 动态端口 + 指定地址**（合法）。
  - `KurobridgeConfig.ws` 可选（exactOptionalPropertyTypes 下成员声明为 `?: T | undefined`，
    消费方 `config.ws?.port` 取值）；`parseConfig` 条件展开透传；`defaultConfig()` **不含
    ws 段**（生成的默认配置维持动态端口现状）。
- 归属论证（ADR-028）：形状进 core 是 SSOT 惯例的延续（token/admins/runtime 同款），
  避免 `docs/config-schema.md` 出现第二处来源；Java 侧零感知。放弃方案：配置只放 embedded
  （SSOT 破裂）、配置进 Java 薄壳（WS 细节漏进桥接层，违背红线 2/3）。
- 空 token 安全基线（config 含 ws 段且 token 为空 → WARN）的打点在 embedded bootstrap，
  core 只定义形状，不做行为。

### 实现回填（2026-09-13 验收后）

- `server.ts` 握手成功日志展示 client：有则追加 `，client=<身份串>`，无则逐字节维持
  0.3.0 旧格式（验收 grep 不受影响）；client 不进 PeerState、不参与任何判定。
- `parseConfig` 条件展开保证「ws 段缺省 = 结果对象无 ws 键」（测试断言
  `not.toHaveProperty("ws")`）；defaultConfig 同样无 ws 键。
- 沙盒与单测证据：config.test.ts +4（形态/非法值/缺省无 ws 键）、embedded
  ws-server.test.ts +4（真网）、沙盒固定端口/绑定失败/WARN/双对端全过（MVP3-NOTES）。

## MVP 阶段四（MVP-4，2026-09-14）：config 增 embedded 段（SSOT 形状）

> 任务书：`docs/history/MVP4-PROMPT.md`。与 ws 段同款（ADR-028 先例）：**形状 SSOT 归 core zod，
> 消费方在 bridge/embedded 引导层**。本包只新增顶层可选段 `embedded` 的形状与解析，
> 不含任何行为（拉起/守卫/QR 全在 embedded）。

- `configSchema` 增顶层可选段：

  ```
  embedded: {
      napuketto: {
          enabled: boolean,
          configPath?: string,   // napuketto TOML 路径（相对服务器根）；缺省 plugins/kurobridge/napuketto.toml
          dataDir?: string,      // napuketto 数据目录（相对服务器根）；缺省 plugins/kurobridge/napuketto-data
      },
  }
  ```

  - `napuketto` 段必填 `enabled: boolean`（显式声明，不给缺省——嵌入是重行为，要求服主
    写明）；`configPath`/`dataDir` 非空串可选。
  - **整段缺省 = 现状不变**（无 napuketto 分支：stub 孙进程 / external 对端形态）。
  - `defaultConfig()` 不含 embedded 段（与 ws 段同款：默认配置维持最小形态）。
- 语义约定（消费方在 embedded 实现，此处仅记录形状意图）：
  - `enabled=true` 强制要求 config 有 `ws.port`（napuketto TOML 的 `url` 静态，动态端口
    无法喂给——违反即 embedded 侧快速失败，WsBindError 同族）。
  - `configPath`/`dataDir` 经 env `NAPKETTO_CONFIG` / `NAPKETTO_DATA` 指给 napuketto
    （napuketto 侧配置 SSOT 是它自己的 TOML，KuroAdapter 只指路）。
- 归属论证同 ADR-028/ADR-029：避免 `docs/config-schema.md` 第二处来源；Java 零感知。
