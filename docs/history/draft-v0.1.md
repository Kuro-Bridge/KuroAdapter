# kurobridge-ws 协议草案 v0.1（draft）

> 协议 SSOT 形态：本文描述语义与机制；**最终字段以 `docs/protocol/` 下的 zod schema 为准**（`@kurobridge/protocol`，ADR-008）。任何文件禁止手写消息类型。
> 版本机制（ADR-003）：WS 子协议 `kurobridge-ws.v1` 声明大版本（不兼容变化，握手期拒绝）；`hello.protocolVersion`（语义化 `0.1.0`）做小版本/能力协商。

## 1. 传输与握手

- 传输：WebSocket，kurobridge 为 **WS 服务端**，对端主动连入。
- 握手：客户端连接时声明 `Sec-WebSocket-Protocol: kurobridge-ws.v1`；不匹配 → 服务端拒绝（HTTP 426/子协议协商失败）。
- 鉴权：连接建立后首个消息为 `hello`（Server→Peer 注册）或 `hello`（Peer→Server 注册），随后服务端回 `helloAck`；携带鉴权 token（后续版本）。
- 帧格式（参考 HuHoBot 思路）：

```ts
{ header: { type: string, id?: string }, body: unknown }
```

- `type`：消息类型（小写 snake_case）。
- `id`：UUID，请求-响应与流式回报的关联键（无 `id` = 单向通知）。

## 2. 事件集（初步）

### Server → Peer（kurobridge 发出）

| type | body 要点 | 说明 |
|---|---|---|
| `hello` | serverId、platform、version、protocolVersion、channelBindings[] | 注册 + 绑定频道列表上报（ADR-004） |
| `hello_ack` | 握手结果（ok / error+reason） | 对注册的确认 |
| `chat` | 游戏聊天消息（玩家名、内容、频道） | 转发到群 |
| `join` / `leave` | 玩家进出服 | 广播 |
| `death` | 死亡消息 | 广播 |
| `status` | TPS、在线人数、uptime | 周期/按需上报 |
| `bindings_updated` | 变更后的绑定列表 | 配置漂移通知（ADR-004） |

### Peer → Server（对端发出）

| type | body 要点 | 说明 |
|---|---|---|
| `hello` | peerId、platform（koishi/embedded/…）、version、protocolVersion | 对端注册 |
| `chat` | 群消息（群号、发送者、内容）→ 游戏广播 | 需服务端校验转发规则 |
| `command` | 群指令 → 执行游戏命令 | 权限校验在 kurobridge 侧 |
| `query` | 查询（在线列表 / 绑定 / 白名单…） | UUID 请求-响应 |
| `ping` / `pong` | 业务心跳 + 假连接检测 | 载荷可带时间戳/随机数 |

## 3. 机制

- **UUID 请求-响应**：`query` 等请求带 `id`，响应回带同一 `id`；超时未回 → 请求方报错。
- **异步回调（msgContinue）**：长任务（如执行多行命令）用 `msgContinue` 流式回报，挂同一 `id`，末端 `msgEnd`。
- **业务心跳**：对端发 `ping`，服务端回 `pong`（或反向）；超时 N 次未收到 → 判定假连接/断开。
- **指数退避重连**：对端断线后按 1s → 2s → 4s … 封顶 60s 重连，带抖动。
- **配置漂移**：`bindings_updated` 通知对端更新缓存，避免 hello 时快照过期。

## 4. 待细化（进入 zod SSOT 时逐项定稿）

1. 鉴权 token 的传输方式与过期策略。
2. `channelBindings` 字段形态（群号 ↔ 服务器频道映射）。
3. 消息内容格式（纯文本起步；富文本/图片为二期）。
4. 权限模型：kurobridge 侧指令白名单 + 群管理员映射。
5. `status` 上报频率与订阅机制（对端可否按需拉取）。
6. 多服务器（serverId 多实例）互联语义。

## 5. 原型最小集（spike，2026-09-12）

> 任务书 `docs/PROTOTYPE-PROMPT.md` §4.1。schema 实现在 `bridge/protocol/src/`；本节记录已定稿字段语义。

### 5.1 握手语义（决策 D-01）

draft §1 的双向 `hello` 收敛为单程握手：**Peer 连入 → 发 `hello`（请求，带 id）→ Server 校验 → 回同 id 的 `hello_ack`**。服务端身份（serverId/version/protocolVersion）并入 `hello_ack` body，不再单发 Server 侧 `hello`。

- `hello` body：`{ peerId, platform, version, protocolVersion }`（全部必填，protocolVersion 为语义化三元组）。
- `hello_ack` body：`{ ok: true, serverId, version, protocolVersion }` 或 `{ ok: false, reason }`。
- 协议版本不匹配 → `ok: false` + 关连接。

### 5.2 心跳

`ping`（Peer→Server，请求带 id，body `{ timestamp }`）→ `pong`（同 id 回带 timestamp）。空闲超时由服务端检测（阈值注入），多阈值假连接检测留正式版。

### 5.3 chat 双向

- Server→Peer `chat`：`{ playerName, content }`（游戏聊天事件，无 id）。
- Peer→Server `chat`：`{ sender, content }`（平台消息，无 id）。同型不同体，按方向校验。

### 5.4 IPC 帧（Java ↔ Node，stdin/stdout JSON-lines）

帧结构复用 §1 的 `{ header: { type, id? }, body }`（决策 D-04）：

| type | 方向 | 帧型 | body |
|---|---|---|---|
| `ready` | Node→Java | 事件 | `{ wsPort }` |
| `game_chat` | Java→Node | 事件 | `{ playerName, content }` |
| `broadcast` | Node→Java | 请求（id） | `{ message }` |
| `broadcast_result` | Java→Node | 响应（同 id） | `{ ok: true }` \| `{ ok: false, error }` |
| `execute_command` | Node→Java | 请求（id） | `{ command }` |
| `execute_command_result` | Java→Node | 响应（同 id） | 同上 |
| `shutdown` | Java→Node | 事件 | `{ reason }` |

### 5.5 帧校验规则（决策 D-09）

- `type` 必须 snake_case（`^[a-z][a-z0-9_]*$`）；`id` 存在时必须 UUID。
- 事件帧携带 id → 校验失败（严格拒绝，尽早暴露方向用错）；请求/响应帧 id 必填。
- 聚合 schema 用 `z.union` 平铺（zod 4.4.3 不支持嵌套判别路径 `header.type`）。

## 6. v0.2 变更（MVP 阶段一，2026-09-13）

> schema 实现见 `bridge/protocol/src/`；PROTOCOL_VERSION `0.1.0 → 0.2.0`（D-10 精确相等
> 策略下，对端 hello 需同步升版本）。

### 6.1 channel 概念（对齐 ADR-004）

- WS `chat` 双向 body 各加 `channel: string`：游戏侧 `{channel, playerName, content}`，
  平台侧 `{channel, sender, content}`。channel 是服务端绑定表的频道标识（如群号）；
  游戏事件由服务端**按绑定频道逐频道 fan-out**（每频道一帧），平台消息按 channel 过滤。
- `hello_ack` ok 体加 `channelBindings: string[]`（服务端绑定表快照随握手下发，空数组合法）。
- IPC `broadcast` 请求 body 加 channel（`{channel, message}`；Java 侧 MVP 只广播不区分）。
- IPC `game_chat` / `player_join` / `player_quit` **不携带 channel**——Java 零业务，
  fan-out 是 Node 侧职责。

### 6.2 新事件集

| type | 方向 | body | 说明 |
|---|---|---|---|
| `join` / `leave` | Server→Peer 事件 | `{channel, playerName}` | 玩家进出服，按绑定频道 fan-out |
| `status` | Server→Peer 事件 | `{tps, onlinePlayers, uptimeSeconds}` | 全服状态（无 channel）；Java 在 join/quit 时机经 IPC `status` 事件推送，Node 中继 |
| `bindings_updated` | Server→Peer 事件 | `{channelBindings: string[]}` | 变更后**完整列表**（非增量）；配置变更时发给已握手对端 |
| `player_join` / `player_quit` | Java→Node IPC 事件 | `{playerName}` | Bukkit 事件桥接（IPC 帧名描述事件源，WS 帧名是协议事件，对齐 `game_chat`/`chat` 模式） |
| `status` | Java→Node IPC 事件 | 同 WS status body | tps=1 分钟均值（Paper `getTPS()[0]`），uptime 取 JVM uptime |
