# kurobridge-ws 对端接入指南（Peer Guide）

> **本文是外部协议端（napukettoqq / 其它实现）实现 kurobridge-ws 客户端的唯一实现依据。**
> 帧名与字段以 `bridge/protocol/src` 的 zod schema 为 SSOT——本文与 schema 不一致时以
> schema 为准（发现漂移请修本文并通知仓库方）。协议版本演进记录见该包 `docs/design.md`。
>
> 当前协议版本：**0.3.1**（2026-09-13）。本文覆盖 0.2.0 引入的全部帧与 0.3.0/0.3.1 增量。

## 0. 角色与拓扑

- **kurobridge 永远是 WS 服务端**，协议端（你）是 WS 客户端，**主动连入**。不存在反向连接。
- 服务端支持**多个对端并存**：每个已握手对端都会收到全部游戏侧事件（按频道 fan-out）。
  但**一个逻辑协议端只保持一条连接**——同一逻辑端开两条连接会导致平台消息重复广播进游戏。
- 服务端监听地址/端口由 MC 服主在配置里声明（`plugins/kurobridge/config.json` 的 `ws` 段）：
  external 部署**必须配置固定端口**（`ws.port`），否则服务端用动态端口（对端无从连入）。
  `ws.host` 可选（如 `127.0.0.1` = 只听本机，适合服务端与协议端同机的隧道部署）。

## 1. 连接建立与子协议

- URL：`ws://<host>:<port>`（路径不校验，建议用根路径 `/`）。
- **必须携带子协议头** `Sec-WebSocket-Protocol: kurobridge-ws.v1`——缺失时服务端在握手期
  直接拒绝（HTTP 400），不会进入协议层。
- 升级成功后立刻进入握手期（见 §3）：**10 秒内必须发出 `hello`**，否则服务端以
  close 1002（"hello timeout"）关闭连接。
- 握手完成前发送其它已知帧会被服务端丢弃（warn 日志）；握手完成后才开始收发业务帧。

## 2. 帧格式（线格式）

单条 WS **文本帧** = 一行 JSON（UTF-8），结构与 IPC 共用：

```json
{"header": {"type": "<帧名>", "id": "<UUID>"}, "body": {}}
```

| 规则 | 说明 |
|---|---|
| 帧名 `type` | 全小写 snake_case（`^[a-z][a-z0-9_]*$`） |
| **请求/响应帧**（成对） | `id` **必填**，UUID；响应复用请求的 id 做关联 |
| **事件帧**（单向） | **无 id**；携带 id 会被校验拒绝（尽早暴露方向用错） |
| 未知字段 | 服务端非严格校验：body 里的多余字段会被剥离（不报错） |

## 3. 握手时序、版本协商与鉴权

```
对端                                服务端
 │  WS 升级（子协议 kurobridge-ws.v1）   │
 │ ─────────────────────────────────► │
 │  hello（请求，id 必填）             │  10s 内必须发出
 │ ─────────────────────────────────► │
 │  hello_ack（响应，同 id）           │  或关连接（见下）
 │ ◄───────────────────────────────── │
```

### 3.1 `hello` body 字段表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `peerId` | string（非空） | ✅ | 对端实例唯一标识（日志辨识用；建议含实例名/进程 id，重启后可变） |
| `platform` | string（非空） | ✅ | 平台名（如 `qq`、`napukettoqq`） |
| `version` | string（非空） | ✅ | 对端自身实现版本（如 `1.0.0`） |
| `protocolVersion` | string | ✅ | 对端实现的协议版本，**必须**形如 `主.次.补丁`（`^\d+\.\d+\.\d+$`） |
| `token` | string | ❌ | 鉴权 token（v0.3.0）；服务端配置了非空 token 时必带且相同 |
| `client` | string | ❌ | 对端自报身份串（v0.3.1），建议 `名称/版本` 形如 `napukettoqq/1.0`；服务端仅用于连接日志辨识 |

### 3.2 版本兼容规则（主版本兼容区间）

- **主版本号相同即兼容**：`0.2.0` 对端可连 `0.3.1` 服务端（次/补丁位自由浮动）；`1.x`
  对端连 `0.x` 服务端被拒。
- 不兼容 → 服务端回 `hello_ack {ok:false, reason:"protocol version mismatch: peer=<你的版本>"}`,
  随后 **close 1002**。
- 兼容 → `hello_ack` ok 体回服务端身份（`protocolVersion` 为**服务端**实际版本，可能与
  你的不同——后续实现新帧时以未知帧容忍规则（§5.3）自保）。

### 3.3 鉴权（close 1008）

- 服务端配置了非空 `token` 时：hello 缺失 `token` 或值不符 → `hello_ack
  {ok:false, reason:"auth failed"}` + **close 1008**。
- 服务端 token 为空 = 不鉴权（但 external 部署下服务端会打 WARN 建议配置 token）。
- 校验顺序：先版本协商（不兼容 = 1002），后鉴权（失败 = 1008）——两个失败原因可据此区分。
- 非法 hello（schema 校验失败）不回执：连接保持到 10s hello 超时（close 1002）。重复
  hello 被忽略。

### 3.4 `hello_ack` body

| 分支 | 字段 | 说明 |
|---|---|---|
| ok | `ok:true`、`serverId`（string）、`version`（服务端程序版本）、`protocolVersion`（服务端协议版本）、`channelBindings`（string[]，可为空数组） | `channelBindings` 是服务端绑定频道**快照**（当前生效值；ADR-004） |
| error | `ok:false`、`reason`（string） | 拒绝原因，配 close 1002 / 1008 |

### 3.5 channelBindings 快照语义

- `hello_ack.channelBindings` = 握手时刻的绑定列表（**完整列表**，非增量；空数组合法）。
- 服务端配置变更（热重载）后，会向全部已握手对端推 `bindings_updated` 事件（§5.2）——
  收到后以帧内列表为准刷新本地认知。
- 也可以随时 `query kind=bindings` 拉取实时快照（§5.1）。

## 4. 心跳与空闲检测

- 服务端空闲阈值**缺省 30s**：**任何入帧**（含 ping、业务帧，甚至非法帧）都会重置计时；
  30s 无任何帧 → 服务端判定对端失联，**close 1001**（"idle timeout"）。
- **对端保活建议**：周期发 `ping`（建议 5–15s，务必小于服务端空闲阈值）；服务端会以同 id
  的 `pong` 应答（`body.timestamp` 原样回显，可测往返延迟但服务端不做超时判定）。
- 服务端关服时会向已握手对端发 **close 1001**（"server shutdown"）——收到后按 §7 重连。

## 5. 帧目录（逐帧字段表）

> id 规则总览：`hello`/`ping`/`command`/`query` 是请求（id 必填）；`hello_ack`/`pong`/
> `command_result`/`query_result` 是响应（同 id 回）；其余为事件（无 id）。

### 5.1 Peer → Server

| 帧 | 类型 | body 字段 | 说明 |
|---|---|---|---|
| `hello` | 请求（id） | 见 §3.1 | 握手（必须首帧） |
| `ping` | 请求（id） | `timestamp`: number（整数 ≥0） | 心跳；响应 `pong` |
| `chat` | 事件（无 id） | `channel`: string、`sender`: string、`content`: string（均非空） | 平台 → 游戏聊天。`channel` 未绑定进服务端绑定表时被服务端静默丢弃（debug 日志） |
| `command` | 请求（id） | `command`: string（非空）、`source`: `{channel: string, userId: string}`（均非空） | 执行服务器命令。`command` **不含前导斜杠**（`"whitelist list"` 而非 `"/whitelist list"`）；`source.userId` = 群成员 QQ 号。响应 `command_result` |
| `query` | 请求（id） | `kind`: `"status"` \| `"bindings"` | 状态/绑定查询。响应 `query_result` |

`command` 语义细节：

- 管理员判定在**服务端**：`source.channel` + `source.userId` 命中服务端配置 `admins`
  （`{channel, users[]}`，userId = QQ 号）才执行；否则 `command_result {ok:false,
  error:"forbidden"}`（不触发执行）。
- 执行者语义 = 服务器控制台（`say` 等命令以 CONSOLE 名义生效）。
- 长命令（如 `whitelist add`）可能数秒才回——请求-响应按 id 异步关联，不要同步阻塞假设
  立即返回；服务端 IPC 超时 10s，超时回 `{ok:false, error:"..."}`。
- 命令输出行（若有）在 ok 分支的 `output: string[]`（可能缺省 = 无输出）。

`query` 响应细节：

- `kind=status`：ok 分支 `data` = `{"tps": <number>, "onlinePlayers": <int>, "uptimeSeconds": <int>}`
  （StatusBody 同构）。服务端自最近一帧 `status` 事件后才有缓存——从未收到过时回
  `{ok:false, error:"no status yet"}`。
- `kind=bindings`：ok 分支 `data` = 当前绑定频道 `string[]`（实时快照）。

### 5.2 Server → Peer

| 帧 | 类型 | body 字段 | 说明 |
|---|---|---|---|
| `hello_ack` | 响应（同 hello id） | 见 §3.4 | 握手结果 |
| `pong` | 响应（同 ping id） | `timestamp`: number（原样回显） | 心跳应答 |
| `chat` | 事件 | `channel`: string、`playerName`: string、`content`: string | 游戏 → 平台聊天（玩家在游戏内发言） |
| `join` | 事件 | `channel`: string、`playerName`: string | 玩家进服 |
| `leave` | 事件 | `channel`: string、`playerName`: string | 玩家退服 |
| `death` | 事件 | `channel`: string、`player`: string、`message`: string（**允许空串**） | 玩家死亡；`message` = 原生死亡消息文本（deathMessage 为 null 时为空串）。注意字段名是 `player`（与 join/leave 的 `playerName` 不一致，历史原因） |
| `status` | 事件 | `tps`: number（≥0）、`onlinePlayers`: int（≥0）、`uptimeSeconds`: int（≥0） | 服务器状态。**无 channel**（全服状态）；推送时机为事件驱动（玩家进出服时），无周期推送 |
| `bindings_updated` | 事件 | `channelBindings`: string[] | 绑定表变更推送——**变更后完整列表**（非增量） |
| `command_result` | 响应（同 command id） | ok：`{ok:true, output?: string[]}`；error：`{ok:false, error: string}` | 命令执行结果；`output` 缺省 = 无输出 |
| `query_result` | 响应（同 query id） | ok：`{ok:true, data}`；error：`{ok:false, error: string}` | `data` 形状由请求 `kind` 决定（见 §5.1） |

**fan-out 语义**：`chat`/`join`/`leave`/`death` 服务端按绑定频道逐频道发**一帧一频道**
（`channel` 字段即本帧所属频道）——对端按 `channel`（群号）路由到对应群。全部绑定频道
都未命中你的平台时收不到对应帧；`status` 例外（无频道，全体对端都收）。

### 5.3 未知帧容忍（服务端行为，对端建议镜像）

版本兼容区间（§3.2）意味着对端可能收到自己不认识的帧。服务端收帧侧行为如下（建议对端
实现同等容忍，至少**不因未知帧断连**）：

- 未知**请求帧**（带 id）→ 服务端回同 id 的 `<type>_result` 帧 `{ok:false,
  error:"unknown frame type"}`，不断连。
- 未知**事件帧**（无 id）→ 忽略 + debug 日志，不断连。
- 未知 `<type>_result` 响应帧（对端回了服务端不认识的响应）→ 忽略不回执（防乒乓循环）。

## 6. 业务约定（QQ 群服互通）

- **channel = QQ 群号字符串**：服务端绑定表（`config.channels`）的 SSOT 在服主配置里；
  群号以字符串承载（避免大号段精度问题）。对端不得自造频道——发未绑定频道的 `chat`
  会被丢弃；想接新群请引导服主改服务端配置。
- **admins 的 userId = QQ 号**：`command` 的 `source.userId` 必须是群成员的 QQ 号字符串，
  服务端按 `(channel, userId)` 匹配管理员表。
- **command 触发形式由协议端定义**：以什么前缀触发（如 `/服主`、`!cmd`）、如何解析命令行，
  都是协议端（napukettoqq）侧的职责；服务端只收「已提取的命令行 + 来源」。
- **富文本 → 文本降级建议**（游戏侧只收纯文本）：
  - @提及 → `@昵称` 文本；
  - 图片 → `[图片]` 占位；
  - 表情 → `[表情:名称]` 占位（或 QQ 原生 face 文本）；
  - 多段消息（引用/转发）建议拒绝或拼接为首段文本；
  - 空白内容（纯图片等降级后为空）不发送（协议要求 content 非空）。
- **反向渲染**：游戏侧事件均为纯文本（`content`/`message`/`playerName`），协议端自行
  决定 QQ 侧富文本包装（如加「[MC]」前缀区分来源）。

## 7. 断线与重连策略

| 关闭场景 | close code | 对端正确行为 |
|---|---|---|
| 版本不兼容 / hello 超时 | **1002** | **停止重连**——版本不符时重连必然再被拒；应告警并等待对端/服务端升级 |
| 鉴权失败 | **1008** | **停止重连**——token 错误不会自愈；应告警并等待配置修正 |
| 服务端空闲超时 / 主动关服 | **1001** | 指数退避重连 |
| 网络错误（未完成握手 / 1006 等） | — | 指数退避重连 |

- **退避建议**：1s 起步，每次 ×2，封顶 30s，加随机抖动（±20%）防惊群。
- **反模式点名**：
  - 固定短间隔（如 200ms）盲目重连——服务端重启窗口内形成重连风暴；
  - 收到 1002/1008 后仍继续重连——拒绝原因不会消失，只会刷日志；
  - 无上限无限重连且不告警——长期故障无人知晓。
- 建议：重连成功（重新握手 ok）后重置退避；连续 N 次（如 10 次）失败后放弃并告警，
  交由人工/上层调度恢复。

## 8. 安全基线

- **token 必配**（强烈建议）：external 部署暴露面大于本机内嵌形态；服务端配置了 `ws` 段
  但 token 为空会打 WARN。token 是静态凭据：泄露需两端同步更换（服务端改配置重启 +
  对端更新）。
- **明文 WS 仅限可信网络**：本协议不做 TLS/wss（明文帧可被链路窃听/篡改）。跨公网部署
  必须走隧道——推荐反代 TLS 终结（nginx/caddy 的 wss→ws），或 wireguard/ssh 隧道。
- 服务端 `ws.host` 支持 `127.0.0.1` 只听本机——协议端与服务端同机部署时**应当**这样配，
  配合隧道/反代对外暴露。
- 端口选择避开 MC 服务端口（25565）与 RCON（25575）等。

## 9. 完整时序示例

以下为一次完整会话（`P→` 对端发出，`S→` 服务端发出；JSON 为便于阅读做了换行美化，
**实际线格式为单行文本**）：

```
# 1. WS 升级：GET ws://mc.example.com:25580，头带 Sec-WebSocket-Protocol: kurobridge-ws.v1
P→ {"header":{"type":"hello","id":"3f9d2c1e-8b4a-4c3e-9a2d-7f1e5b6c8d90"},
    "body":{"peerId":"napuketto-01","platform":"qq","version":"1.0.0",
            "protocolVersion":"0.3.1","token":"s3cret","client":"napukettoqq/1.0"}}
S→ {"header":{"type":"hello_ack","id":"3f9d2c1e-8b4a-4c3e-9a2d-7f1e5b6c8d90"},
    "body":{"ok":true,"serverId":"kurobridge-spike","version":"0.1.0",
            "protocolVersion":"0.3.1","channelBindings":["114514","1919810"]}}

# 2. 心跳（周期 5–15s）
P→ {"header":{"type":"ping","id":"a1b2c3d4-1111-4222-8333-444455556666"},
    "body":{"timestamp":1760000000000}}
S→ {"header":{"type":"pong","id":"a1b2c3d4-1111-4222-8333-444455556666"},
    "body":{"timestamp":1760000000000}}

# 3. 游戏 → 平台（每绑定频道一帧）
S→ {"header":{"type":"chat"},"body":{"channel":"114514","playerName":"Steve","content":"大家好"}}
S→ {"header":{"type":"join"},"body":{"channel":"114514","playerName":"Alex"}}
S→ {"header":{"type":"status"},"body":{"tps":20,"onlinePlayers":2,"uptimeSeconds":3600}}

# 4. 平台 → 游戏（命中绑定频道才进游戏广播）
P→ {"header":{"type":"chat"},"body":{"channel":"114514","sender":"群友A","content":"你好 MC"}}

# 5. 群指令往返（管理员判定在服务端）
P→ {"header":{"type":"command","id":"c0ffee00-0000-4000-8000-000000000001"},
    "body":{"command":"whitelist list","source":{"channel":"114514","userId":"10001"}}}
S→ {"header":{"type":"command_result","id":"c0ffee00-0000-4000-8000-000000000001"},
    "body":{"ok":true,"output":["There are 1 whitelisted player(s): Steve"]}}
# 非管理员同请求 → {"ok":false,"error":"forbidden"}

# 6. 查询往返
P→ {"header":{"type":"query","id":"c0ffee00-0000-4000-8000-000000000002"},"body":{"kind":"bindings"}}
S→ {"header":{"type":"query_result","id":"c0ffee00-0000-4000-8000-000000000002"},
    "body":{"ok":true,"data":["114514","1919810"]}}
P→ {"header":{"type":"query","id":"c0ffee00-0000-4000-8000-000000000003"},"body":{"kind":"status"}}
S→ {"header":{"type":"query_result","id":"c0ffee00-0000-4000-8000-000000000003"},
    "body":{"ok":true,"data":{"tps":20,"onlinePlayers":2,"uptimeSeconds":3600}}}

# 7. 服务端配置热重载 → 绑定变更推送（完整列表）
S→ {"header":{"type":"bindings_updated"},"body":{"channelBindings":["114514","1919810","233333"]}}

# 8. 玩家死亡（message 可为空串；注意字段名是 player）
S→ {"header":{"type":"death"},"body":{"channel":"114514","player":"Steve","message":"Steve fell from a high place"}}

# 9. 服务端关机
S→ close(1001, "server shutdown")   → 对端指数退避重连（§7）
```

## 10. 版本演进与兼容速查

| 协议版本 | 增量 | 对端兼容性 |
|---|---|---|
| 0.2.0 | channel 体系、join/leave/status/bindings_updated、hello_ack.channelBindings | — |
| 0.2.1 | （IPC 侧 ready.autoRestart，WS 无变化） | 无感 |
| 0.3.0 | hello.token 鉴权（1008）、command/query 请求族、death 事件、未知帧容忍、主版本兼容协商 | 旧对端可连新服务端（主版本同为 0）；新帧未实现时靠 §5.3 容忍 |
| 0.3.1 | hello.client 自报身份（可选，仅日志辨识） | 完全可选，无感 |
