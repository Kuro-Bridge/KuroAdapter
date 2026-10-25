# config.jsonc 参考

**形状 SSOT**：[`bridge/core/src/business/config.ts`](../../bridge/core/src/business/config.ts) 的 `configSchema` / `defaultConfig()`。本文与代码不一致时以代码为准。

## 文件与加载

- 位置：`<服务器根>/plugins/kurobridge/config.jsonc`（cwd = 服务器根；LSE shim 用 `--server-root` 显式定位）。
- 格式：JSONC——严格 JSON 的超集，额外支持 `//` 行注释、`/* */` 块注释与行尾逗号；VS Code 原生识别 `.jsonc`。注释里写的就是字段说明，改配置不用来回查文档。
- 缺失：首次加载自动生成带注释的 JSONC 模板并写入随机 token（32 位十六进制），开箱即鉴权；已有文件一律不覆盖。
- 旧版迁移：已存在旧 `config.json` 时按原样回退读取（JSONC 解析器是 JSON 超集），不迁移不重命名；启动日志会提示改名为 `config.jsonc` 以获得注释模板。两个文件都缺失才生成新模板。
- 非法：启动时记 error 并降级为默认配置（空绑定）；运行期 watch 解析失败保留旧值，等修复。报错行号与文件真实行号一致，可直接定位手改处。
- 热载：embedded 形态轮询 mtime+size（默认 2s）；`/kurobridge reload` 也可触发。LSE 不轮询、无 reload，需重启。
- 改完保存即生效的字段：`channels`、`admins`。其余字段见各条"生效"说明。

## 字段

### `channels`（必填）

```jsonc
"channels": ["123456789", "987654321"]
```

WS 协议端绑定的频道列表。游戏侧事件按此表逐频道 fan-out；平台消息只有命中表内频道才进游戏。

- 类型：非空字符串数组，可为空数组。
- 去重保序（重复项只保留首个）。
- 缺省：无。旧配置只有本字段时仍可加载。

### `token`（可选，缺省 `""`）

WS `hello` 的共享鉴权令牌。

- 首启自动生成 32 位十六进制随机值（全形态生效，与 Pure 线对齐）；`""` = 不鉴权。
- 非空 = 对端 `hello.token` 必须完全一致；失败 → `hello_ack {ok:false,reason:"auth failed"}` + close 1008。
- **生效**：Node 进程生命周期内固定，改后重启服务器 / 插件。
- 安全：配置了 `ws` 段但 token 为空时启动打 WARN（不阻断）。协议本身不做 TLS；跨公网请用隧道/反代。
- embedded 模式下本值经内联配置自动注入内嵌协议端，无需二次配置。

### `admins`（可选，缺省 `[]`）

```jsonc
"admins": [{ "channel": "123456789", "users": ["10001", "10002"] }]
```

群管理员映射。WS `command` 的 `source.channel` 命中条目且 `source.userId` 在 `users` 内 → 放行；否则回 `{ok:false,error:"forbidden"}`。

- `channel` / `users` 均为非空字符串；entry 按 channel 去重（保留首个），users 去重保序。
- 缺省 `[]`：无人可执行命令。
- 运行期可热载。

### `runtime`（可选）

```jsonc
"runtime": { "autoRestart": true }
```

| 字段 | 类型 | 缺省 | 语义 |
| --- | --- | --- | --- |
| `autoRestart` | boolean | `true` | Node 异常退出后，薄壳看护器是否自动重启。随 `ready` 帧上报给宿主 |

- **生效**：启动时读取并随 ready 上报一次；改后重启。
- 看护参数（1s/5s/15s 退避、10 分钟窗 3 次放弃）不可配置。

### `ws`（可选）

```jsonc
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

```jsonc
"embedded": {
  "napuketto": {
    "enabled": true,
    "qq": "10001",
    "logLevel": "info"
  }
}
```

JAR 内嵌 napuketto CLI 的开关与托管面（ADR-029 / ADR-041）。整段缺省 = 不内嵌（external 形态）。

| 字段 | 类型 | 缺省 | 语义 |
| --- | --- | --- | --- |
| `napuketto.enabled` | boolean（**必填**） | 无 | 显式开启嵌入 |
| `napuketto.qq` | 非空字符串（**开启后必填**） | 无 | 机器人 QQ 号；缺失或占位值（`123456`）由启动守卫拦截 |
| `napuketto.logLevel` | 非空字符串 | `info` | napuketto 控制台日志级别（透传 `NAPKETTO_LOG_LEVEL`） |
| `napuketto.dataDir` | 非空字符串 | `plugins/kurobridge/napuketto-data` | napuketto 数据目录；与服主日常实例隔离（`instance.lock` 冲突） |
| `napuketto.configPath` | 非空字符串 | `plugins/kurobridge/napuketto.toml` | 仅旧版 CLI（无内联注入能力）回退使用，见下 |

**托管面（ADR-041）**：开启嵌入即全托管——连接参数（WS url、token、QQ 账号）由宿主按内嵌 CLI 版本注入，服主只编辑本文件：

- CLI 支持 `NAPKETTO_CONFIG_JSON`（0.3.0+，fix4 P0-A）：宿主把 `{autoRestart, restartDelayMs, accounts: [{qq, enabled, kurobot: {url, token}}]}` 整包经环境变量注入，`napuketto.toml` 无需存在、无需编辑。
- 旧版 CLI（无内联注入能力）回退 `NAPKETTO_CONFIG` 指路 TOML 文件并打 WARN 提示升级；此时 `configPath` 仍生效。
- **当前嵌包 pin 0.2.0 属旧版**：首启在 `configPath` 生成 `napuketto.toml` 占位模板，需按模板手工补齐账号与 `accounts` 段（占位 qq `123456` 会校验失败）；升级到 0.3.0+ 后自动转为内联托管，旧 TOML 不再读取。
- 无 `managed: false` 之类的逃生门：高级用法请走 external 形态（关掉 `embedded` 段，自行运行协议端连 `ws` 监听段）。

- **固定端口强制**：`enabled: true` 时必须配置 `ws.port`（连接 url 静态拼入），缺失为配置未就绪错误（`exit 2`）。
- **qq 守卫**：`qq` 缺失、空白或模板占位值 → 单行引导报错 + `exit 2`（配置未就绪语义，看护器不重启）。
- **平台**：napuketto self-host 仅 Windows。非 Windows 下 `enabled: true` 记 error 但不拉起，进程继续作为纯 WS 服务端。
- QR 交接：登录二维码写到 `plugins/kurobridge/qr.png` + `qr.json`，游戏内 `/kurobridge qr` 查看。
- **生效**：启动时读取并拉起；改后重启。
- LSE 不消费本段；Endstone 的 `bin/` 不随包 napuketto，开启会因 CLI 入口缺失而快速失败。

## 启动失败与退出码

Node 进程退出码契约（ADR-041，宿主看护器据此决定是否重启）：

| 退出码 | 语义 | 看护器行为 | 典型来源 |
| --- | --- | --- | --- |
| `0` | 优雅关停 | 不重启 | shutdown 帧 / stdin EOF / 服务器关闭 |
| `1` | 可重试崩溃 | 退避重启（1s/5s/15s，10 分钟窗 3 次放弃） | WS 端口被占、napuketto 意外退出、进程崩溃 |
| `2` | 配置/环境确定性错误 | **不重启**（重启必然复现） | `qq` 未配置/占位、`enabled` 无 `ws.port`、CLI 入口缺失、上游 napuketto exit 78 |

- `exit 2` 后的恢复路径：修复 `config.jsonc` 后重启服务器，或重载插件（paper：`/reload confirm`；LSE：控制台 `kurobridgeretry`）。
- 配置文件本身解析失败不走退出码：降级为默认配置（空绑定）继续运行并记 error。
- WS 端口被占保留 `exit 1`：属于环境竞态，退避重启有意义。

## 完整示例

### embedded（JAR 内 napuketto，固定端口）

```jsonc
{
    "channels": ["123456789"],
    "token": "3f9a1c7e5b2d48a0b6c1d4e7f8a9b0c3",
    "admins": [{ "channel": "123456789", "users": ["10001"] }],
    "runtime": { "autoRestart": true },
    "ws": { "host": "127.0.0.1", "port": 25580 },
    "embedded": { "napuketto": { "enabled": true, "qq": "10001" } },
    "server": { "id": "kurobridge" }
}
```

连接参数（url / token / QQ 账号）由宿主注入内嵌 CLI，无需再编辑 napuketto.toml；token 即本文件的 `token` 字段。

### external（外部协议端）

```jsonc
{
    "channels": ["123456789"],
    "token": "3f9a1c7e5b2d48a0b6c1d4e7f8a9b0c3",
    "admins": [{ "channel": "123456789", "users": ["10001"] }],
    "runtime": { "autoRestart": true },
    "ws": { "port": 25580 },
    "server": { "id": "kurobridge" }
}
```

删掉 `embedded` 段即可；`ws.port` 可固定，也可整段缺省（动态端口，端口号见日志/ready）。

### 最小

```jsonc
{ "channels": ["stub-channel"] }
```

其余字段走默认值：不鉴权、无管理员、自动重启、动态端口、不内嵌。
