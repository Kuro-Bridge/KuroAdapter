# bridge/core

`@kuro-bridge/bridge-core`：与平台无关的业务核心 + `kurobridge-ws` 服务端。宿主（`bridge/embedded`、LSE shim）负责注入传输层、时钟、logger 与配置源。

## 职责与约束

- 绑定表、管理员映射、转发规则、配置解析、握手/鉴权/心跳/查询/命令分发。
- **零 Node API、零框架**：不使用 `ws` / `process` / `fs` / `pino` / `setTimeout` / `Date.now`。
- target ES2020，`erasableSyntaxOnly`，产物可被 QuickJS（LSE）直接执行。
- 无全局单例：所有状态由 `CoreContext` 与各实例持有，支持同进程多实例。

## 公开导出面

入口 [`src/index.ts`](../../bridge/core/src/index.ts)。

| 导出 | 类型 | 作用 |
| --- | --- | --- |
| `CoreContext` | class | 持有 logger、`serverId`、`version`、`token`、`newRequestId`、`clock`、`scheduler` |
| `KurobridgeServer` | class | WS 服务端：握手、鉴权、心跳、出帧、query、command 分发 |
| `Relay` | class | IPC ↔ WS 路由与 IPC 请求-响应 |
| `BindingTable` | class | 绑定频道集合，去重保序，`replace()` 返回集合是否变化 |
| `AdminTable` | class | 管理员映射，`isAdmin(channel, userId)` |
| `parseConfig` / `defaultConfig` / `ConfigError` | function / class | 配置 schema 与默认值（SSOT） |
| `platformChatTarget` / `gameEventChannels` | function | 纯转发规则 |
| `ManualClock` / `ManualScheduler` | class | 测试用确定性时钟 |
| `DEFAULT_HELLO_TIMEOUT_MS` (10s) / `DEFAULT_IDLE_TIMEOUT_MS` (30s) / `DEFAULT_IPC_REQUEST_TIMEOUT_MS` (10s) | const | 默认超时 |
| `IpcRequestError` | class | 类型化 IPC 失败/超时 |
| `Logger` / `WsServer` / `WsConnection` / `IpcChannel` / `Clock` / `TimerScheduler` / `CancelFn` / `CoreOptions` / `ServerOptions` / `ServerTimeouts` / `RelayOptions` / `ConfigStore` / `KurobridgeConfig` / `AdminMapping` | type | 宿主注入契约 |

## KurobridgeServer

构造参数：`{ context, wsServer, channelBindings: () => string[], timeouts? }`。

- `start(): Promise<number>` 启动底层 `WsServer` 并返回实际端口。
- `stop()` 关闭全部对端（close 1001）并停底层服务。
- `onPlatformChat(handler)`：WS `chat` 入站回调（Relay 挂接）。
- `onCommand(handler)`：WS `command` 入站回调，返回 `CommandResultBody`；未注册时回 `command handler not available`。
- `sendGameChat` / `sendJoin` / `sendLeave` / `sendDeath` / `sendStatus` / `sendBindingsUpdated`：编码并推给全部已握手对端，返回送达数；无对端时 debug 级提示。
- `establishedPeerCount`：观测/测试用。

内部行为：

- 每连接一份 `PeerState`（连接、是否已握手、peerId、hello/idle 定时器）。
- 握手成功后取消 hello 定时器；空闲定时器在每次入帧时重挂。
- 收帧两段式：`wireFrameSchema` 先取 `type`/`id`，已知类型再按具体帧 schema `safeParse`；校验失败 warn 后丢弃，不断连。
- 未知帧容忍见 [运行时 §3](../architecture/runtime.md#未知帧容忍)。
- `query status` 返回最近一次 `sendStatus` 的缓存；`query bindings` 返回 `channelBindings()` 实时快照。
- command 的执行委托给上层（`Relay`），本类只负责回同 id 的 `command_result`；handler 抛错也回 `{ok:false, error}`。

## Relay

构造参数：`{ context, server, ipc, bindings, admins, configStore, onShutdown?, ipcRequestTimeoutMs? }`。

| 入站 | 行为 |
| --- | --- |
| IPC `game_chat` / `player_join` / `player_quit` / `player_death` | `gameEventChannels(bindings)` 逐频道调用对应 `server.send*` |
| IPC `status` | `server.sendStatus`（同时更新 query 缓存） |
| IPC `broadcast_result` / `execute_command_result` | 按 id 结算在途请求；`ok:false` → `IpcRequestError` |
| IPC `config_reload` | `configStore.load()` 后走与 watch 相同的变更路径；读取失败保留旧配置 |
| IPC `shutdown` | 调 `onShutdown(reason)`，由引导层退出 |
| WS `chat` | 绑定频道过滤；命中则 `broadcast { channel, message: "<sender> content" }` |
| WS `command` | `AdminTable.isAdmin` 判定；非管理员回 `forbidden` 且不触发 IPC；管理员走 `execute_command` |

- IPC 通道关闭或 `dispose()` 时拒绝全部在途请求，之后不再接受新请求。
- `ipcOpen` 暴露通道健康状态（供上层降级判断）。
- 配置变更：`admins.replace()` 无条件执行；`bindings.replace()` 仅在集合变化时推送 `bindings_updated`（纯顺序调整不推送）。
- IPC 请求超时默认 10s，与 Java 侧 `NodeIpc` 一致。

## 业务模块

### config.ts

zod schema 的唯一定义处。解析规则：

- `channels: string[]` 必填；去重保序。
- `token: string` 缺省 `""`。
- `admins: {channel, users}[]` 缺省 `[]`；entry 按 channel 去重（保留首个），users 去重保序。
- `runtime.autoRestart: boolean` 缺省 `true`。
- `ws?: {host?, port?}`；`port` 为 1–65535 整数，`host` 非空串。
- `embedded?: {napuketto: {enabled, configPath?, dataDir?}}`；`enabled` 必填。
- `server?: {id?}`。
- 未知字段被 zod 剥离；旧配置缺新字段按默认值补齐。
- `defaultConfig()` 返回空绑定、空 token、空管理员、`autoRestart: true`，**不含 `ws` / `embedded` / `server` 段**。

### bindings.ts / admins.ts

两个纯逻辑表。`BindingTable.replace` 用集合语义判变化（重排不算）；`AdminTable.replace` 整表替换。二者都不做 I/O。

### forwarding.ts

- `platformChatTarget(channels, chat)`：频道在绑定表内 → 原样返回，否则 `null`。
- `gameEventChannels(channels)`：当前返回全部绑定频道（未来按频道/事件类型的差异化规则在此扩展，Relay 不感知）。

## 测试

`bridge/core/src` 下 8 个测试文件，覆盖：

- 握手（版本、鉴权、重复 hello、超时、关闭码）、心跳、空闲检测、未知帧、query、command 分发。
- Relay 双向路由、绑定变更推送、IPC 超时、断连一致性、配置重载、关机。
- 配置解析/去重/默认值、绑定表集合语义、管理员判定、转发规则。
- 金样本：协议包 `fixtures/` 的契约校验 + `KurobridgeServer` 行为回放（ADR-036）。

新增业务时优先在 `business/` 写纯函数并补 vitest；不要在 `server.ts` 里堆业务分支。
