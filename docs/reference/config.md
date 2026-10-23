# config.json 参考

**形状 SSOT**：[`bridge/core/src/business/config.ts`](../../bridge/core/src/business/config.ts) 的 `configSchema` / `defaultConfig()`。本文与代码不一致时以代码为准。

## 文件与加载

- 位置：`<服务器根>/plugins/kurobridge/config.json`（cwd = 服务器根；LSE shim 用 `--server-root` 显式定位）。
- 缺失：首次加载自动生成默认配置（不覆盖已有文件）。
- 非法：启动时记 error 并降级为默认配置；运行期 watch 解析失败保留旧值，等修复。
- 热载：embedded 形态轮询 mtime+size（默认 2s）；`/kurobridge reload` 也可触发。LSE 不轮询、无 reload，需重启。
- 改完保存即生效的字段：`channels`、`admins`。其余字段见各条“生效”说明。

## 字段

### `channels`（必填）

```json
"channels": ["123456789", "987654321"]
```

WS 协议端绑定的频道列表。游戏侧事件按此表逐频道 fan-out；平台消息只有命中表内频道才进游戏。

- 类型：非空字符串数组，可为空数组。
- 去重保序（重复项只保留首个）。
- 缺省：无。旧配置只有本字段时仍可加载。

### `token`（可选，缺省 `""`）

WS `hello` 的共享鉴权令牌。

- `""` = 不鉴权。
- 非空 = 对端 `hello.token` 必须完全一致；失败 → `hello_ack {ok:false,reason:"auth failed"}` + close 1008。
- **生效**：Node 进程生命周期内固定，改后重启服务器 / 插件。
- 安全：配置了 `ws` 段但 token 为空时启动打 WARN（不阻断）。协议本身不做 TLS；跨公网请用隧道/反代。

### `admins`（可选，缺省 `[]`）

```json
"admins": [{ "channel": "123456789", "users": ["10001", "10002"] }]
```

群管理员映射。WS `command` 的 `source.channel` 命中条目且 `source.userId` 在 `users` 内 → 放行；否则回 `{ok:false,error:"forbidden"}`。

- `channel` / `users` 均为非空字符串；entry 按 channel 去重（保留首个），users 去重保序。
- 缺省 `[]`：无人可执行命令。
- 运行期可热载。

### `runtime`（可选）

```json
"runtime": { "autoRestart": true }
```

| 字段 | 类型 | 缺省 | 语义 |
| --- | --- | --- | --- |
| `autoRestart` | boolean | `true` | Node 异常退出后，薄壳看护器是否自动重启。随 `ready` 帧上报给宿主 |

- **生效**：启动时读取并随 ready 上报一次；改后重启。
- 看护参数（1s/5s/15s 退避、10 分钟窗 3 次放弃）不可配置。

### `ws`（可选）

```json
"ws": { "host": "127.0.0.1", "port": 25580 }
```

对端连入的 WS 监听段。

| 字段 | 类型 | 缺省 | 语义 |
| --- | --- | --- | --- |
| `host` | 非空字符串 | 缺省 = 全部接口 | 绑定地址，如 `127.0.0.1` |
| `port` | 1–65535 整数 | 缺省 = 动态端口 `listen(0)` | 固定监听端口 |

- 整段缺省 = 动态端口 + 全部接口。
- 只配 `host` 不配 `port` 合法（动态端口 + 指定地址）。
- 端口被占 → Node 启动失败并 `exit(1)`，由看护器按退避重试，最终放弃；服主需解决占用后重启。
- **生效**：监听在启动时绑定；改后重启。
- 建议避开 25565（MC）与 25575（RCON）。

### `embedded`（可选）

```json
"embedded": {
  "napuketto": {
    "enabled": true,
    "configPath": "plugins/kurobridge/napuketto.toml",
    "dataDir": "plugins/kurobridge/napuketto-data"
  }
}
```

JAR 内嵌 napuketto CLI 的开关与路径。整段缺省 = 不内嵌（external 形态）。

| 字段 | 类型 | 缺省 | 语义 |
| --- | --- | --- | --- |
| `napuketto.enabled` | boolean（**必填**） | 无 | 显式开启嵌入 |
| `napuketto.configPath` | 非空字符串 | `plugins/kurobridge/napuketto.toml` | napuketto 自己的 TOML（QQ 账号与 `[accounts.kurobot]` 在此）；经 `NAPKETTO_CONFIG` 指路 |
| `napuketto.dataDir` | 非空字符串 | `plugins/kurobridge/napuketto-data` | napuketto 数据目录；与服主日常实例隔离（`instance.lock` 冲突） |

- **固定端口强制**：`enabled: true` 时必须配置 `ws.port`，否则 Node 明确报错并 `exit(1)`。
- **平台**：napuketto self-host 仅 Windows。非 Windows 下 `enabled: true` 记 error 但不拉起，进程继续作为纯 WS 服务端。
- QR 交接：登录二维码写到 `plugins/kurobridge/qr.png` + `qr.json`，游戏内 `/kurobridge qr` 查看。
- **生效**：启动时读取并拉起；改后重启。
- LSE 不消费本段；Endstone 的 `bin/` 不随包 napuketto，开启会因 CLI 入口缺失而快速失败。

### `server`（可选）

```json
"server": { "id": "my-server" }
```

| 字段 | 类型 | 缺省 | 语义 |
| --- | --- | --- | --- |
| `id` | 非空字符串 | `"kurobridge"`（引导层兜底，不在默认配置里） | 经 `hello_ack.serverId` 上报给对端 |

- 当前仅用于日志辨识与协议上报；不做多实例路由/去重。
- **生效**：启动时注入 `CoreContext`；改后重启。

## 完整示例

### embedded（JAR 内 napuketto，固定端口）

```json
{
    "channels": ["123456789"],
    "token": "change-me",
    "admins": [{ "channel": "123456789", "users": ["10001"] }],
    "runtime": { "autoRestart": true },
    "ws": { "host": "127.0.0.1", "port": 25580 },
    "embedded": { "napuketto": { "enabled": true } },
    "server": { "id": "kurobridge" }
}
```

napuketto TOML 的 `[accounts.kurobot].url` 写 `ws://127.0.0.1:25580`，token 与 `config.json` 一致。

### external（外部协议端）

```json
{
    "channels": ["123456789"],
    "token": "change-me",
    "admins": [{ "channel": "123456789", "users": ["10001"] }],
    "runtime": { "autoRestart": true },
    "ws": { "port": 25580 },
    "server": { "id": "kurobridge" }
}
```

删掉 `embedded` 段即可；`ws.port` 可固定，也可整段缺省（动态端口，端口号见日志/ready）。

### 最小

```json
{ "channels": ["stub-channel"] }
```

其余字段走默认值：不鉴权、无管理员、自动重启、动态端口、不内嵌。
