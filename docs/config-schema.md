# KuroBot 配置说明（config.json）

> **SSOT 声明**：配置的形状与缺省值唯一来源是 `bridge/core` 的 zod schema
> （`bridge/core/src/business/config.ts` 的 `configSchema` / `defaultConfig()`）——本文件只是
> 人类可读的说明，二者不一致时以代码为准（发现漂移请修代码或本文件并记录 NOTES）。
>
> 文件位置：`<服务器根>/plugins/kurobot/config.json`（Node 子进程以服务器根为 cwd 读取）。
> 缺失时首次启动自动生成默认配置；解析失败不致命——启动降级为默认配置、运行期 watch 保留
> 旧值并等服主修复。改完保存即生效（mtime 轮询 watch，默认 2s）；`/kurobot reload` 也可手动
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
    }
}
```

## 最小示例（MVP1 时代旧配置，0.3.0 仍兼容）

```json
{
    "channels": ["stub-channel"]
}
```
