# KuroBridge 配置说明（config.json）

> **SSOT 声明**：配置的形状与缺省值唯一来源是 `bridge/core` 的 zod schema
> （`bridge/core/src/business/config.ts` 的 `configSchema` / `defaultConfig()`）——本文件只是
> 人类可读的说明，二者不一致时以代码为准（发现漂移请修代码或本文件并记录 NOTES）。
>
> 文件位置：`<服务器根>/plugins/kurobridge/config.json`（Node 子进程以服务器根为 cwd 读取）。
> 缺失时首次启动自动生成默认配置；解析失败不致命——启动降级为默认配置、运行期 watch 保留
> 旧值并等服主修复。改完保存即生效（mtime 轮询 watch，默认 2s）；`/kurobridge reload` 也可手动
> 触发重读。**例外**：`token` 在 Node 进程生命周期内固定，改后需重启服务器（或重启插件）。

## 逐字段说明

### `channels: string[]`（必填，可空数组）

WS 协议端（QQ 侧）绑定到游戏的频道列表。游戏侧事件（聊天 / 进服 / 退服 / 死亡）按此表
fan-out 给协议端；协议端发来的聊天只有命中表内频道才会进游戏广播。

- 去重保序（重复项只保留首个）。
- 0.3.0 版本前本表是唯一字段（旧配置自动兼容）。

### `token: string`（可选，缺省 `""`）

WS 握手鉴权 token（协议 0.3.0，DEBT-1）。

- `""`（缺省）= 不鉴权（向后兼容，全部对端放行）。
- 非空 = 对端 hello 必须携带相同 token：缺失或不符 → 握手拒绝（`ok:false "auth failed"` +
  close 1008）。
- 边界（有意不做）：token 过期/轮换不支持——本机 / 可信内网场景，改 token 直接重启。

### `admins: Array<{ channel, users: string[] }>`（可选，缺省 `[]`）

群管理员映射（协议 0.3.0，DEBT-1）：决定哪些「频道 + 用户」来源可以通过 WS `command` 帧
执行服务器命令（白名单管理走 MC 原生 `whitelist` 命令，SSOT 是 MC 的 `whitelist.json`）。

- 判定规则：`command` 帧的 `source.channel` 命中某条目的 `channel` 且 `source.userId` 在该
  条目的 `users` 内 → 放行；否则拒绝（`command_result ok:false "forbidden"` + 服务端 warn）。
- `channel` 去重保序；`users` 内条目去重保序。
- 运行期改本字段经 watch / reload 生效（不像 token 需要重启）。

### `runtime: object`（可选，DEBT-2 引入）

宿主参数（业务配置的宿主形态）：当前唯一字段 `autoRestart: boolean`（缺省 `true`）——
Node 子进程异常退出后是否由 Java 看护器自动重启（1s/5s/15s 退避，10 分钟窗口 3 次失败
放弃）。该值经 ready 帧上报给 Java。

### `ws: object`（可选，MVP-3 引入）

WS 监听段：external 协议端（如独立部署的 napukettoqq）的连入点。**整段缺省 = 动态端口 +
监听全部接口**（内嵌形态现状不变）；对端接入实现依据见 KuroProtocol 仓 peer-guide
（本仓 `docs/protocol/peer-guide.md` 为迁移指针，ADR-031）。

- `port: number`（可选，1-65535 整数）：固定监听端口。external 部署**必须配置**（否则
  动态端口无从连入）；建议避开 25565（MC）与 25575（RCON）。
- `host: string`（可选，非空串）：绑定地址，如 `127.0.0.1`（只听本机，适合同机隧道/反代
  部署）。缺省 = 全部接口。
- **只配 `host` 不配 `port` 合法**：动态端口 + 指定绑定地址。
- 端口被占：Node 启动即失败（error 日志含端口与原因、非零退出），由 Java 看护器按既有
  退避语义重试（1s/5s/15s，10 分钟窗 3 次失败放弃）——长期端口冲突收敛为「放弃 + 日志」，
  请服主解决端口冲突后重启插件或等待看护器窗口外恢复。
- **安全基线**：配置了 `ws` 段但 `token` 为空 → 启动打 WARN（external 模式暴露面大，
  建议配置 token）；不阻断启动。跨公网部署请走 TLS 隧道/反代（协议本身不做 wss）。
- `port`/`host` 修改经 watch / `/kurobridge reload` 重读，但**监听已在启动时绑定**——改后
  需重启服务器（或重启插件）生效。

### `embedded: object`（可选，MVP-4 引入）

嵌入段：JAR 内嵌 napuketto CLI（ADR-029）的开关与路径。**整段缺省 = 现状不变**
（stub 孙进程 / external 对端形态）。形状 SSOT 归 core zod（与 `ws` 段同款，ADR-028 先例），
消费方在 Node 引导层（bridge/embedded）。

```json
{
    "embedded": {
        "napuketto": {
            "enabled": true,
            "configPath": "plugins/kurobridge/napuketto.toml",
            "dataDir": "plugins/kurobridge/napuketto-data"
        }
    }
}
```

- `napuketto.enabled: boolean`（**必填**，不给缺省）：嵌入是重行为（拉起 QQ 协议端整树，
  含 napuketto CLI → boot → self-host 三层子进程），要求服主显式写明。
- `napuketto.configPath: string`（可选，非空串）：napuketto 自己的 TOML 配置路径
  （相对服务器根，也可绝对路径）。**napuketto 侧的配置 SSOT 是这份 TOML**（服主直接维护，
  QQ 账号 / kurobridge 连接段 `[accounts.kurobot]` 全在里面），KuroAdapter 只经 env
  `NAPKETTO_CONFIG` 指路。缺省 `plugins/kurobridge/napuketto.toml`。
- `napuketto.dataDir: string`（可选，非空串）：napuketto 数据目录（env `NAPKETTO_DATA`）。
  缺省 `plugins/kurobridge/napuketto-data`——与服主日常 napuketto 部署**隔离**（同一账号
  数据目录单实例锁 instance.lock，混用会互踢）。
- **固定端口强制**：`enabled: true` 时 config 必须有 `ws.port`——napuketto TOML 里的
  `url` 是静态的，动态端口无法喂给它。违反 → Node 启动明确 error + 非零退出（WsBindError
  同族快速失败），由 Java 看护器按退避语义重试至放弃。建议同时配 `ws.host: "127.0.0.1"`
  （本机孙进程不暴露公网）与 `token`（并与 napuketto.toml 的 `[accounts.kurobot].token`
  一致）。
- **平台**：QQ 宿主（napuketto self-host）仅支持 Windows；非 Windows 宿主下 `enabled: true`
  → 明确 error 日志 + 不拉起（Node 继续作为纯 WS 服务端，external 对端不受影响）。
- **QR 交接**：登录二维码会落地 `plugins/kurobridge/qr.png` + `qr.json`（随刷新更新），
  游戏内 `/kurobridge qr` 查看图片路径与登录链接。
- `configPath`/`dataDir` 变更需重启生效（napuketto 在 Node 启动时拉起，运行期不重读）。

## 完整示例

```json
{
    "channels": ["stub-channel"],
    "token": "",
    "admins": [
        {
            "channel": "stub-channel",
            "users": ["stub-admin"]
        }
    ],
    "runtime": {
        "autoRestart": true
    },
    "ws": {
        "host": "127.0.0.1",
        "port": 25580
    },
    "embedded": {
        "napuketto": {
            "enabled": true
        }
    }
}
```

> 上例为 embedded 形态（JAR 内嵌 napuketto + 固定端口 25580）：napuketto 以
> `ws://127.0.0.1:25580` 连入（写在 napuketto.toml 的 `[accounts.kurobot].url`，
> token 两边一致）。纯 external 部署（napuketto 独立机器/进程）删掉 `embedded` 段即可。

## 最小示例（MVP1 时代旧配置，0.3.0 仍兼容）

```json
{
    "channels": ["stub-channel"]
}
```
