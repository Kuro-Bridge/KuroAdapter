# 协议参考（kurobridge-ws + IPC）

## 1. SSOT 与外部来源

| 契约 | 权威来源 |
| --- | --- |
| 协议规格（逐帧字段表、时序、重连、安全） | KuroProtocol 仓 [`docs/peer-guide.md`](https://github.com/Kuro-Bridge/KuroProtocol/blob/main/docs/peer-guide.md) |
| 帧名与字段（zod schema） | KuroProtocol `src/`，发布为 npm 包 [`@kuro-bridge/protocol`](https://www.npmjs.com/package/@kuro-bridge/protocol) |
| 版本 | KuroProtocol `src/meta.ts` 的 `PROTOCOL_VERSION`（当前 **0.4.0**） |
| 金样本（JSON fixtures） | KuroProtocol `fixtures/v0.4/`（npm 包内随 `fixtures/` 发布） |
| 本仓协议消费方式 | 依赖 `@kuro-bridge/protocol@^0.4.0`，**无仓内副本** |

本仓不手写消息类型：所有帧必须 `import { ... } from "@kuro-bridge/protocol"`。Java / C++ 的帧编解码是人工维护的镜像，由门禁与集成测试兜底。

协议演进只能走 KuroProtocol 仓四件套（schema + peer-guide + fixtures + changelog）同改并发版，本仓只升依赖版本号。

## 2. 传输与帧格式

- **WS**：文本帧，一行一个 JSON。子协议 `Sec-WebSocket-Protocol: kurobridge-ws.v1`（大版本）。
- **IPC**：stdin/stdout，一行一个 JSON（JE / Endstone）。
- 线格式：

```json
{ "header": { "type": "chat", "id": "uuid（仅请求/响应）" }, "body": { } }
```

- `header.type`：snake_case（`^[a-z][a-z0-9_]*$`）。
- 事件帧**禁止** `id`；请求/响应必须有 UUID `id`，响应帧用同 id。
- 解析是两段式：先用 wire 骨架取 `type`/`id`，再用具体 schema `safeParse`。校验失败只丢弃该帧（warn），不断连。

## 3. WS 帧目录

### Peer → Server

| 帧 | id | body | 说明 |
| --- | --- | --- | --- |
| `hello` | ✅ | `{peerId, platform, version, protocolVersion, token?, client?}` | 握手；`token` 在服务端配置非空时必填且相等 |
| `ping` | ✅ | `{timestamp}` | 心跳请求 |
| `chat` | ❌ | `{channel, sender, content}` | 平台 → 游戏聊天（事件） |
| `command` | ✅ | `{command, source:{channel, userId}}` | 群指令；管理员判定在服务端 |
| `query` | ✅ | `{kind: "status" \| "bindings"}` | 查询 |

### Server → Peer

| 帧 | id | body | 说明 |
| --- | --- | --- | --- |
| `hello_ack` | ✅ | `{ok:true, serverId, version, protocolVersion, channelBindings}` 或 `{ok:false, reason}` | 握手结果 |
| `pong` | ✅ | `{timestamp}` | 心跳响应（同 id） |
| `chat` | ❌ | `{channel, playerName, content}` | 游戏 → 平台聊天 |
| `join` / `leave` | ❌ | `{channel, playerName}` | 进服 / 退服 |
| `death` | ❌ | `{channel, player, message}` | 死亡；`message` 可为空串，字段名是 `player` |
| `status` | ❌ | `{tps, onlinePlayers, uptimeSeconds}` | 全服状态，无 `channel` |
| `bindings_updated` | ❌ | `{channelBindings}` | 全量绑定列表（非增量） |
| `command_result` | ✅ | `{ok:true, output?}` 或 `{ok:false, error}` | 命令执行结果；`output` 为输出行 |
| `query_result` | ✅ | `{ok:true, data}` 或 `{ok:false, error}` | `status` → status 快照；`bindings` → `string[]` |

> `chat` 在两个方向的 body 形状不同：游戏侧用 `playerName`，平台侧用 `sender`。消费方按方向选类型。

## 4. IPC 帧目录

### Node → 薄壳

| 帧 | id | body | 说明 |
| --- | --- | --- | --- |
| `ready` | ❌ | `{wsPort, autoRestart?}` | WS 已监听；`autoRestart` 缺省按 true |
| `broadcast` | ✅ | `{channel, message}` | 请求游戏内广播；薄壳回 `broadcast_result` |
| `execute_command` | ✅ | `{command}` | 请求执行服务器命令；薄壳回 `execute_command_result` |

### 薄壳 → Node

| 帧 | id | body | 说明 |
| --- | --- | --- | --- |
| `game_chat` | ❌ | `{playerName, content}` | 聊天事件 |
| `player_join` / `player_quit` | ❌ | `{playerName}` | 进出服 |
| `player_death` | ❌ | `{player, message}` | 死亡；`message` 可空串 |
| `status` | ❌ | `{tps, onlinePlayers, uptimeSeconds}` | 状态快照 |
| `config_reload` | ❌ | `{}` | 请求重读配置 |
| `shutdown` | ❌ | `{reason}` | 关机通知；随后薄壳关 stdin |
| `broadcast_result` | ✅ | `{ok}` 或 `{ok:false,error}` | 广播回执 |
| `execute_command_result` | ✅ | 命令结果体 | 执行完回执，可带 `output` |

IPC 帧名描述平台事件源（`game_chat` / `player_join` / …），不带 `channel`；频道 fan-out 是 Node 侧业务。

## 5. 握手、版本与鉴权

```text
Peer                          Server
 │ ── hello {peerId, platform, version,
 │           protocolVersion, token?, client?} ──▶
 │ ◀── hello_ack {ok:true, serverId, version,
 │                protocolVersion, channelBindings}
 │
 │ ── ping / chat / command / query ──▶
 │ ◀── pong / *_result / 事件帧
```

- **版本兼容**：`hello.protocolVersion` 与服务端 `PROTOCOL_VERSION` **主版本号相同**即兼容（当前 `0.x`）。不匹配 → `hello_ack {ok:false, reason}` + close **1002**。
- **鉴权**：服务端 `token` 非空时，`hello.token` 必须完全一致；失败 → close **1008**。空 token = 不鉴权。
- **超时**：连接建立后 10s 内未完成 hello → close 1002；30s 内无任何入帧 → close 1001。两值可通过 `ServerTimeouts` 覆盖，0 = 禁用。
- **子协议**：服务端请求 `kurobridge-ws.v1`。注意 `ws` 8.21 中 `handleProtocols` 返回 `false` 只会省略响应头，不会中止握手；不兼容版本的实际拦截点是 `hello` 版本协商（已知缺口）。

## 6. 未知帧与错误

- 未知请求帧（带 id）→ `<type>_result {ok:false, error:"unknown frame type"}`。
- 未知响应帧（`*_result`）→ 忽略，防乒乓。
- 未知事件帧（无 id）→ debug 日志，忽略。
- JSON 非法 / 帧校验失败 → warn 丢弃。
- 以上均不主动断连。

关闭码：`1001` 对端失联/服务端关机；`1002` 协议错误（版本/握手超时）；`1008` 鉴权失败。

## 7. 健康与重连

- 对端应每 5–15s 发 `ping`；服务端回 `pong`。
- 重连由对端负责（服务端是被动方）。服务端在断连时清理该连接全部状态；`reconnect.test.ts` 覆盖断连 → 重连一致性。
- 多个已握手对端可同时存在，事件帧广播给全部对端。

## 8. 已知未实现

- **`msgContinue` / `msgEnd` 流式回报**：协议无此帧，未实装。
- **TLS/wss 直连**：不做；建议隧道/反代。
- **status 周期上报**：仅 join/quit 触发（LSE 不发送；Endstone tps=0）。
- **serverId 多实例路由**：仅上报，不做路由/去重。

## 9. 验证

- `bridge/core/src/__tests__/golden.fixtures.test.ts` 对已安装 npm 包内的 fixtures 做契约校验、SHA256 双向完整性、版本轴锚定，并用 `KurobridgeServer` 回放可观测行为。
- `:core` JUnit 的 `IpcFrameCodecTest` 校验 Java 侧 IPC 编解码与 zod 逐字段一致。
- 接入新对端时，以 KuroProtocol 的 `peer-guide.md` 与 fixtures 为准，不要以本页速查表替代字段级规格。
