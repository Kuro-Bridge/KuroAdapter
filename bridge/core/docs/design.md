# bridge/core 设计（@kurobot/bridge-core）

> 本文件是包级设计文档（AGENTS.md：写代码前先更新对应包的 `docs/design.md`，设计先行）。

## 职责

kurobot 的业务核心 + `kurobot-ws` 协议服务端（ADR-005：业务在 Node 侧）。

- 绑定/白名单/指令权限/转发规则等业务逻辑。
- WS 服务端：握手、鉴权、心跳、UUID 请求-响应、`msgContinue` 流式回报、指数退避重连。
- 与 Java 薄壳的 stdin/stdout JSON-lines IPC（ADR-010）。

## 硬性约束（AGENTS.md 硬约束 #3，ADR-007）

- **零 Node API**：禁止 `ws`/`process`/`fs`/`pino` 等。
- 传输层抽象为可注入接口：`WsServer/WsClient`、`Logger`、`IpcChannel`。
- target ES2020（根 tsconfig 已锁），保证 QuickJS（LSE）可跑。
- `erasableSyntaxOnly`：产物无 tslib/装饰器依赖。
- core 无全局单例（对齐 Napuketto ADR-015 推论）：logger/connection/state 均为实例化对象，由 `CoreContext` 持有。

## 目录规划

```
src/
├── context.ts        # CoreContext：注入的 logger/传输层/配置持有者
├── server.ts         # KurobotServer：WS 服务端（握手/心跳/连接生命周期）
├── ipc/              # 与 Java 薄壳的 JSON-lines IPC（inbound/outbound）
├── handlers/         # 消息处理：chat/command/query/…
├── business/         # 绑定列表 / 白名单 / 权限 / 转发规则（纯逻辑）
└── index.ts          # 聚合导出
```

## 实现顺序（STATUS.md 第 2 步细化）

1. 传输层接口 + `CoreContext`。
2. 握手状态机（hello/hello_ack，含协议版本协商）。
3. 心跳 + 假连接检测。
4. chat 收发最小闭环。
5. 业务模块（绑定/白名单/权限/转发）。

## 依赖

- `@kurobot/protocol`（workspace:*）——消息 schema SSOT。

## 原型阶段（spike，2026-09-12）

> 任务书：`docs/PROTOTYPE-PROMPT.md` §4 阶段 2。完整设计不变，本节只标注原型裁剪。

最小闭环（connect → hello 握手 → 心跳 → chat 收发）：

- `src/context.ts`：`CoreContext`（注入 logger + serverId）。
- `src/transport.ts`：`WsServer` / `WsConnection` / `IpcChannel` / `Logger` 可注入接口（零 Node API）。
- `src/server.ts`：`KurobotServer` —— 握手状态机（awaitingHello → established/rejected）、心跳应答（ping→pong）、连接生命周期；协议版本不匹配 → `hello_ack` error + 关连接。
- `src/relay.ts`：假转发规则（占位业务）——IPC `game_chat` → WS `chat` 推给已握手对端；WS `chat` → IPC `broadcast` 请求（UUID 关联，等 `broadcast_result`）。
- `src/index.ts`：聚合导出。

原型裁剪：无鉴权 token、无 `bindings_updated`、无 msgContinue、无指数退避重连（对端 stub 自行重连）、心跳只做应答 + 空闲超时关连接（不做多阈值假连接检测）、业务模块仅 `relay.ts` 假规则。

## MVP 阶段一（2026-09-13）

> 任务书：`docs/MVP1-PROMPT.md` §3 阶段 2/3。本节是动代码前的设计定稿。

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
dispose 语义）、`KurobotServer.send*` 返回送达的已握手对端数（0 = 无人接收）。Java 侧配套：
`NodeIpc.sendGameChat` 返回 boolean，`/kurobot send` 据此明确报错。消息排队/补发留 MVP-2。

### 业务最小闭环（阶段 3，已落地）

- `src/business/config.ts`：`ConfigStore` 注入接口（`load(): Promise<KurobotConfig>` /
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
