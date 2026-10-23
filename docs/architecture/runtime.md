# 运行时与生命周期

本文描述一次“服务器启动 → 协议端连入 → 消息互通 → 关停”的完整运行语义。各平台的差异集中在文末矩阵。

## 1. 启动

### 1.1 JE（Paper / Fabric）

1. 服务端加载薄壳。`onEnable` / `SERVER_STARTING` 同步执行内嵌运行时安装：
   - `KUROBRIDGE_BUNDLE` 已设置 → 开发覆盖，直接用环境变量指定的 bundle 与 node；
   - 未设置 → `EmbeddedRuntime.install()` 把 JAR 内 `embedded/` 资源解压或复用到 `plugins/kurobridge/bin/`（逐文件 sha256 对比 manifest，缺失/不符才重写）。
2. 组装 `NodeSupervisor`，首次 `start()` 拉起 `node bin/index.mjs`，等待 `ready` 帧（上限 30s）。
3. Node 引导层装配 `bridge/core`，绑定 WS 服务端，向 stdout 发 `ready { wsPort, autoRestart }`。
4. 薄壳打印就绪汇总，事件监听与 `/kurobridge` 命令开始工作（两者都容忍 `ipc == null`）。

### 1.2 Endstone

`onEnable` 组装 `NodeRuntime` 并**同步阻塞**到 node ready 或失败（上限 30s），然后注册四事件。失败只记 critical 并保持插件加载（无 IPC 降级），不崩服。`onDisable` 停看护 + 优雅关停。

### 1.3 LSE（LeviLamina）

1. LSE 加载 QuickJS 壳，壳生成随机回环端口与会话令牌，`newProcess` 拉起 `node bin/index.mjs --server-root <BDS根> --game-port <port> --game-token <token>`。
2. shim 先绑对 koishi 的 WS 服务端（`config.ws` 固定端口或动态端口），再绑 `127.0.0.1:<game-port>` 游戏通道。
3. 壳作为 WS 客户端连入游戏通道，首帧明文发送令牌；shim 校验后发 `ready { wsPort, autoRestart }`。
4. 壳收到 ready 后开通事件桥接。此后游戏通道断开 = shim 的“脐带”断开 → shim 退出 → 壳看护器退避重拉（新端口、新令牌）。

## 2. 薄壳 ↔ Node IPC

仅 JE 与 Endstone 使用。**stdin/stdout，一行一个 JSON 帧，零端口零配置**（ADR-010）。日志只走 stderr，stdout 混入非 JSON 会被当坏行丢弃。

帧形状与 WS 共用：

```json
{ "header": { "type": "game_chat" }, "body": { "playerName": "Steve", "content": "hi" } }
```

- 事件帧无 `header.id`；请求帧有 UUID `header.id`，响应用同 id 的 `*_result`。
- 每条请求默认 10s 超时；通道断开时所有在途请求立即失败。
- ready 之前的 `start` 上限 30s；超时强制杀进程，由看护器重试。

IPC 帧全集见 [协议参考](../reference/protocol.md#4-ipc-帧目录)。高层时序：

```
Node  ── ready {wsPort, autoRestart} ──▶ 薄壳
薄壳  ── game_chat / player_join / player_quit / player_death / status ──▶ Node
Node  ── broadcast {channel, message} / execute_command {command} ──▶ 薄壳
薄壳  ── broadcast_result / execute_command_result（同 id） ──▶ Node
薄壳  ── config_reload / shutdown（事件） ──▶ Node
```

## 3. 对外 WS 会话

`KurobridgeServer` 是唯一的协议服务端。每个连接经历：

1. **握手**：对端发 `hello { peerId, platform, version, protocolVersion, token?, client? }`。
   - 协议主版本必须与 `PROTOCOL_VERSION` 相同（`0.4.0` 的兼容区间是 `0.x`）；不匹配 → `hello_ack {ok:false}` + close **1002**。
   - 配置 `token` 非空时，`hello.token` 必须完全一致；失败 → `hello_ack {ok:false, reason:"auth failed"}` + close **1008**。
   - 成功 → `hello_ack {ok:true, serverId, version, protocolVersion, channelBindings}`。
2. **空闲检测**：连接建立后 `helloTimeout` 内未握手 → close **1002**；任意两帧间隔超过 `idleTimeout` → close **1001**。任何入帧（包括非法帧）都会重置空闲计时。默认 10s / 30s，值设 0 可禁用。
3. **业务**：心跳、聊天、命令、查询按 [转发规则](#4-消息路由) 处理。
4. **断开**：清理该连接的定时器与状态；已握手对端断开记 INFO。

`stop()` 向所有对端发 close **1001 "server shutdown"**。

### 未知帧容忍

- 带 `header.id` 的未知请求 → 回 `<type>_result { ok:false, error:"unknown frame type" }`。
- 以 `_result` 结尾的未知帧 → 静默忽略（防乒乓）。
- 无 `id` 的未知事件帧 → debug 日志后忽略。
- 以上均不断连，为协议小版本演进留安全网。

## 4. 消息路由

| 方向 | 输入 | 处理 | 输出 |
| --- | --- | --- | --- |
| 游戏 → 平台 | IPC `game_chat` / `player_join` / `player_quit` / `player_death` | 按绑定表**逐频道** fan-out；无绑定或对端未握手则不出帧 | WS `chat` / `join` / `leave` / `death` |
| 状态 | IPC `status` | 全服帧，无频道；同时更新 `query status` 缓存 | WS `status` |
| 平台 → 游戏 | WS `chat {channel,sender,content}` | 频道命中绑定表才放行 | IPC `broadcast {channel, message:"<sender> content"}`，等 `broadcast_result` |
| 群指令 | WS `command {command, source}` | `AdminTable.isAdmin(source.channel, source.userId)`；非管理员 → `{ok:false,error:"forbidden"}`，不触发 IPC | IPC `execute_command`，等结果原样回 `command_result` |
| 查询 | WS `query {kind}` | `status` 回最近快照（无则 `no status yet`）；`bindings` 回实时绑定表 | `query_result` |
| 绑定变更 | 配置 watch / IPC `config_reload` | 管理员表无条件刷新；绑定集合变化才推送 | WS `bindings_updated {channelBindings}` |
| 关机 | IPC `shutdown` | 通知引导层退出 | 进程退出 |

要点：

- 聊天从平台进游戏时，文本格式固定为 `<发送者> 内容`（core 侧拼装，平台渲染不在此处）。
- 游戏事件 fan-out 的“每频道一帧”由 `Relay` 完成；`KurobridgeServer.send*` 只负责发给全部已握手对端并返回送达数。
- `command` / `query` 的响应帧 ID 与请求相同；`command` 的执行结果体（含可选 `output`）原样回传。

## 5. 配置热载

| 改动 | 生效方式 |
| --- | --- |
| `channels`、`admins` | embedded：mtime 轮询（默认 2s）或 `/kurobridge reload`；绑定集合变化推 `bindings_updated`。LSE 不轮询，需重启 shim。 |
| `token` | 进程生命周期内固定；改后重启 Node / 服务器。 |
| `server.id` | 启动时注入 `CoreContext`；改后重启。 |
| `ws.host` / `ws.port` | 监听在启动时绑定；改后重启。 |
| `runtime.autoRestart` | 随 `ready` 上报一次；改后重启。 |
| `embedded.napuketto.*` | 启动时读取并拉起；改后重启。 |

解析失败不致命：启动时降级为空绑定（记 error）；运行期 watch 解析失败保留旧配置，等服主修复。配置缺失时首次启动自动生成默认 `{ "channels": [], "token": "", "admins": [], "runtime": { "autoRestart": true } }`。

## 6. 看护与关停

### 6.1 看护器（JE / Endstone / LSE 壳）

三端参数一致：

- 退避：连续失败第 1/2/3+ 次分别等 **1s / 5s / 15s**（封顶）。
- 放弃：**10 分钟滑动窗口内累计 3 次失败** → 停止重启，打 SEVERE/error；JE 手动恢复 = 重启服务器或 `/reload confirm`，LSE = 控制台 `kurobridgeretry`。
- `runtime.autoRestart: false` → 失败只告警，不自动重启。
- 重启总是新建实例：JE 重拉 `NodeIpc`；LSE 新 spawn 新端口新令牌；Endstone 新建 `NodeIpc`。

### 6.2 关停

| 平台 | 触发 | 动作 |
| --- | --- | --- |
| JE | 插件 disable / 服务器停服 | `supervisor.stop()` 取消挂起重启 → 发 `shutdown` 帧 → 关 stdin → 等 5s → `destroyForcibly()` → 再等 2s |
| Endstone | `onDisable` | 同上（portable 层双路径收敛） |
| LSE | BDS 停服 / 崩溃 / 通道断 | 游戏通道断开即 shim 自杀（无孤儿）；壳无杀子进程 API，卡死进程需等 BDS 退出或手动结束 |
| embedded napuketto | Node 关停 | `taskkill /PID <pid> /T /F` 树杀（CLI → boot → self-host），有界等待 5s |

JE / Endstone 的 `node.pid` 在 spawn 时写入、优雅关停时删除；异常退出的残留会在下次启动打 WARN，作为“上次可能异常退出”的证据。LSE 不写 PID 文件。

### 6.3 日志契约

- Node 侧唯一 writer：`bridge/embedded/src/logger.ts`（LSE shim 镜像同款），格式 `[KuroBridge][node][LEVEL] message`，LEVEL 为小写 `debug|info|warn|error`。
- `:core` 行格式：`[NodeIpc][LEVEL]` / `[NodeSupervisor][LEVEL]`，LEVEL 为 `INFO|WARN|SEVERE`。
- Java 侧级别解析单点：`IpcLogLevels.parse`；Endstone 侧同语义解析（`[NodeIpc]` / `[NodeSupervisor]` / node 行前缀）。

## 7. 平台差异矩阵

| 能力 | Paper | Fabric | LSE | Endstone |
| --- | --- | --- | --- | --- |
| 薄壳 ↔ Node | stdio | stdio | 回环 WS | stdio |
| 事件 | chat/join/quit/death | 同左（chat 为超集：含 `/me`） | 同左（death 文案恒空） | 同左 |
| status 快照 | TPS/在线/uptime，join+quit 时 | TPS 自测 60s 窗 | 不发送 | tps=0.0，在线/uptime 真值 |
| 群指令执行 | ✅（vanilla 命令走 console 回退） | ✅（原生收集输出） | ✅（`runcmdEx`） | ✅（`CommandSenderWrapper`） |
| 配置热载 | ✅ watch + reload | ✅ watch + reload | ❌ 重启 shim | ❌ 重启服务端 |
| `/kurobridge` 命令 | send / reload / qr | send / reload / qr | 仅 `kurobridgeretry` | 无（R5） |
| 权限门 | `kurobridge.relay` + `kurobridge.admin` | op level ≥2；无 relay 门 | 无 | 无 |
| embedded napuketto | ✅ | ✅ | ❌ | ❌（bin 不随包 napuketto） |
| 看护器 | Java | Java | JS 壳 | C++ |
| PID 文件 | ✅ | ✅ | ❌ | ✅ |

具体到模块的实现细节见 [modules/](../modules/) 下对应文件。
