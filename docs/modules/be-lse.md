# platforms/be/lse（LeviLamina）

LeviLamina（BDS + LSE）平台适配。因 LSE 的 `system.newProcess` 不暴露 stdin/stdout 管道，宿主 ↔ Node 的通道改为 **127.0.0.1 回环 WS**（ADR-037，R2′「WS 回环薄壳」）；帧方言、业务核心与生命周期语义与 JE 一致。

## 拓扑

```
koishi（WS 客户端）
   │ kurobridge-ws.v1
   ▼
Node shim（KurobridgeServer + Relay）      ← 由壳经 newProcess 拉起
   ▲ 127.0.0.1 回环 WS 游戏通道
   │ 首帧明文会话令牌鉴权
QuickJS 壳（WSClient + mc.listen / mc.runcmd / runcmdEx）
   ▼
BDS
```

- **shim 宿主 core**：`platforms/be/lse/src/runtime/`，产物 `dist/bin/index.mjs`，跑在真实 Node。
- **壳**：`platforms/be/lse/src/`，产物 `dist/index.js`（IIFE，target ES2020），由 `manifest.json` 的 `entry` 加载。
- 对外角色不变：koishi 仍连 shim 的 WS 服务端；shim 仍是游戏侧部署体的一部分。

## 启动与握手

1. 壳启动看护器，每轮尝试生成随机端口 `20000–40000` 与会话令牌（`system.randomGuid()` 去连字符）。
2. `newProcess("<node> <bin>/index.mjs --server-root <BDS根> --game-port N --game-token T")` 拉起 shim。
3. shim 解析 argv（缺一即退）→ 读 `plugins/kurobridge/config.jsonc`（缺失写注释模板含随机 token，ADR-040；旧 `config.json` 回退；非法降级空绑定）→ 组装 core → 先绑 koishi WS（`config.ws` 或动态端口）→ 再绑 `127.0.0.1:N` 游戏通道。
4. 壳用 `WSClient` 连入游戏通道，首帧发送令牌原文；令牌不符或 10s 内未交 → close **1008**。
5. shim 校验通过后包装成 core 的 `IpcChannel`，发给壳 `ready { wsPort, autoRestart }`；壳随即开通事件桥接。

游戏通道是**单租户**的：已有通道时新连接直接被关闭；只有已鉴权连接断开才触发“脐带”（未鉴权连接的断开不杀 shim）。

## 事件与请求

上行（壳 → shim，core 帧方言）：

| 帧 | 触发 | 备注 |
| --- | --- | --- |
| `game_chat` | `mc.listen("onChat")` | 原文直出，无权限门 |
| `player_join` / `player_quit` | `onJoin` / `onLeft` | |
| `player_death` | `onPlayerDie` | LSE 无死亡文案参数，`message` 恒空串 |

下行（shim → 壳）：

| 帧 | 壳行为 | 回执 |
| --- | --- | --- |
| `broadcast` | `mc.runcmd("say <message>")` | 调度后立即 `broadcast_result ok`（对齐 JE） |
| `execute_command` | `mc.runcmdEx(command)` | 输出按行拆分；成功 `ok + output`，失败 `{ok:false,error}` |

不做 `status` / `config_reload` / `shutdown`：LSE 无 TPS API、无插件重载触发点、无停服事件，不造假数据。在线状态因此不会推给 koishi。

## 看护与关停

- 退避 1s / 5s / 15s；10 分钟滑动窗累计 3 次失败 → 放弃，打 error 并提示手动恢复。
- `runtime.autoRestart: false` → 失败只 warn；控制台 `kurobridgeretry` 重置放弃态、退避与窗口后立即重试。
- 每次重试全新 spawn：新端口、新令牌；旧进程卡死时因 LSE 无杀子进程 API，只能等 BDS 退出或手动结束。
- 脐带：已鉴权游戏通道断开（BDS 停服/崩溃/shim 退出）→ shim 自杀；无孤儿进程。
- 配置改动需重启 BDS 生效（shim 的 `ConfigStore.watch` 是 no-op）；`token` 本就进程内固定。

## 部署布局

构建后把产物放入 `<BDS 根>/plugins/kurobridge/`：

```
plugins/kurobridge/
├── manifest.json        # LeviLamina 插件清单（扁平格式），与 index.js 同目录
├── index.js             # 壳（dist/index.js）
├── bin/index.mjs        # Node shim（dist/bin/index.mjs）
├── bin/node.exe         # Windows 随包；其它平台用 PATH 上的 node（≥20，建议 26）
└── config.jsonc         # 首次运行生成注释模板（随机 token），服主编辑
```

`manifest.json` 的 `version`（字符串）、`src/runtime/index.ts` 的 `BRIDGE_VERSION` 与包版本当前均为 `0.1.0`，但 **LSE 未纳入 `check-versions` 六点门禁**，升级时需手动同步。

## 配置

与 [config.jsonc 参考](../reference/config.md) 相同的 schema。LSE 的差异：

- 不消费 `embedded` 段（无 napuketto 嵌入）。
- 不消费 `runtime.autoRestart` 之外的宿主参数；该值随 `ready` 上报。
- `ws.host` / `ws.port` 控制 koishi 连入点；缺省动态端口，实际端口见日志与 `ready`。
- `config.jsonc` 位于 `<BDS 根>/plugins/kurobridge/`；shim 用 `--server-root` 显式定位，不依赖子进程 cwd。

## 已知限制

- 无杀子进程 API：shim 卡死时只能放弃该轮，固定 `ws.port` 会被旧进程占用。
- 无 status：koishi 侧在线人数 / TPS 不更新。
- 死亡消息恒空串。
- 无配置热载、无 reload 命令。
- `ws` 8.21 的 `handleProtocols` 返回 `false` 并不会真正拒绝握手，只会省略子协议响应头——子协议不匹配的强制拒绝实际由 `hello` 版本协商兜底（与 `bridge/embedded` 同款缺口）。
- 真机前提（`newProcess` 引号解析、`WSClient` 回调线程、`runcmdEx` 编码、`filePath` 取值等）尚待 LeviLamina 实机验证，清单见包内 [readme](../../platforms/be/lse/readme.md)。

测试：壳侧帧编解码 / 通道 / 看护 / 事件桥接，shim 侧 config store / game gate / ws server / logger，另有真 core 组装 + 真 ws 客户端的回环 e2e。
