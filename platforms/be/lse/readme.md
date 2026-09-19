# platforms/be/lse —— LeviLamina（LSE）平台适配（WS 回环薄壳）

> 面向服主的部署与运维手册（SOP）。设计裁决见 `docs/role-adjudication.md`（SSOT）与 `docs/design.md`。

## 这是什么

把 Minecraft 基岩版 BDS 服务端（LeviLamina + LSE）接入 kurobridge 群服互通的适配包：QuickJS 壳
把游戏事件（聊天/进服/退服/死亡）转成 JSON 帧发往本机回环 WS 游戏通道；壳拉起的 Node shim 宿主
业务核心（`bridge/core`），对 koishi 提供真 WS 服务端。koishi 群消息经 shim → 壳 → `say` /
`runcmdEx` 进入游戏。

```
koishi(WS 客户端)
   │ WS（子协议 kurobridge-ws.v1）
   ▼
node shim（KurobridgeServer + Relay，plugins/kurobridge/bin/）
   ▲ 游戏通道 WS（127.0.0.1 回环，首帧令牌鉴权）
   │
LSE 壳（QuickJS，mc.listen / mc.runcmd）
   ▼
  BDS
```

## 部署清单

LeviLamina 与 LSE 本身的安装见官方文档（[docs.levimc.org](https://docs.levimc.org)，LiteLDev），此处不复制。

构建产物位于本仓 `platforms/be/lse/dist/`，按下表布局放入 `<BDS 根>/plugins/kurobridge/`：

| 路径 | 说明 |
| --- | --- |
| `plugins/kurobridge/plugin.json` | LeviLamina 插件清单（与 `index.js` 同目录） |
| `plugins/kurobridge/index.js` | QuickJS 壳（本仓 esbuild 产物） |
| `plugins/kurobridge/bin/index.mjs` | Node shim（本仓 esbuild 产物） |
| `plugins/kurobridge/bin/node.exe`（Windows）/ `bin/node`（Linux） | Node ≥ 20 运行时，服主自备（建议 Node 26，与内嵌形态基线一致，ADR-015） |
| `plugins/kurobridge/config.json` | 配置；首次运行缺失时自动生成默认，服主手工编辑 |

## 配置（config.json 契约）

首次运行缺失时由 shim 生成默认（无绑定、不鉴权、无管理员、动态端口）。语义权威是
`bridge/core/src/business/config.ts` 的 `KurobridgeConfig` 注释：

| 字段 | 语义 |
| --- | --- |
| `channels` | 绑定的聊天频道列表（去重保序）；缺省 `[]` = 无绑定，平台消息不进游戏 |
| `token` | koishi WS 握手鉴权令牌；空串 = 不鉴权（向后兼容） |
| `admins` | 群管理员映射（`{ channel, users }[]`）：channel 命中且 userId 在 users 内 → 视为管理员，可经 command 执行服务器命令；缺省 `[]` = 无人可执行 |
| `runtime.autoRestart` | node 异常退出后壳是否自动重启；缺省 `true` |
| `ws.host` | koishi WS 监听地址；缺省 = 全部接口（如 `127.0.0.1` 只听本机） |
| `ws.port` | koishi WS 监听端口；缺省 = 动态端口，实际端口经 `ready` 帧与壳日志可见 |
| `server.id` | 服务器标识，经 hello_ack 上报给 koishi；缺省 `kurobridge` |

- **token 契约**：koishi 侧连接后的 hello 帧必须携带相同 `token`，不匹配即拒绝；空串 = 不鉴权。
  壳 ↔ shim 的回环游戏通道用的是壳每轮生成的会话令牌，与该字段无关，服主无需配置。
- **端口取舍**：`ws.port` 缺省动态端口（每次重启换号，看日志里的实际值）；显式固定端口便于 koishi
  写死地址，但 node 卡死占位时会导致后续绑定失败（见「已知限制」），无特殊理由建议保持缺省。
- 另有可选 `embedded` 段（JE JAR 内嵌 napuketto 形态专用），本平台的 shim 不消费。

## 对端连入方向

- koishi 侧安装 `koishi-plugin-kurobridge`（独立仓库，ADR-018），作为 **WS 客户端**连
  `ws://<BDS 主机>:<wsPort>`，子协议 `kurobridge-ws.v1`。
- 游戏侧（壳与 shim）不对外主动连接；唯一出站连接是壳 → 本机回环的游戏通道（127.0.0.1）。
  koishi 与 BDS 不同机时放行 `ws.port`（或保持缺省监听全部接口）。

## 运行与看护行为

启动顺序：LSE 加载插件 → 壳拉起 node shim（随机游戏端口 + 会话令牌）→ shim 先绑 koishi WS、再绑
127.0.0.1 游戏通道 → 首帧令牌鉴权 → shim 发 `ready{wsPort, autoRestart}` → 壳日志报出 koishi WS
实际端口，事件桥接开通。

| 故障 | 表现 | 行为 |
| --- | --- | --- |
| node 缺失 | `newProcess` 返回 false | 记 WARN，进入退避 |
| node 崩溃 / 30s 内未 ready | 退出回调先于 ready，或握手超时 | 进入退避 |
| 通道断连（shim 退出/崩溃） | `onLostConnection` | 看护重启（全新 spawn：新端口新令牌） |

- 退避序列 1s / 5s / 15s；**10 分钟滑动窗累计 3 次失败 → 放弃**：停止自动重启，游戏事件静默丢弃，
  BDS 继续正常跑。控制台命令 `kurobridgeretry` 手动重新看护。
- `runtime.autoRestart = false`：崩溃只记 WARN，不自动重启。

## 已知限制（与 JE/paper 的差异）

- **无杀子进程 API**：node 卡死（不再 accept 连接）时壳只能 30s 超时放弃该次尝试，旧进程要等 BDS
  退出才消失（可手工 taskkill）。显式固定 `ws.port` 时，卡死的旧进程会占住端口导致后续绑定失败。
- **无 status 帧**：LSE 无 TPS API（不造假数据），koishi 侧在线人数等状态不更新。
- **死亡消息恒为空串**：LSE 死亡事件无死亡文案参数。
- **无 config_reload**：LSE 无插件重载触发点；修改 config.json 需重启 BDS 生效。
- **停服通知靠通道断开兜底**：LSE 无停服事件；BDS 停服/崩溃 → 游戏通道断 → shim 自杀（等价 JE 的
  stdin-EOF 脐带，无孤儿）。

## 待真机验证清单

以下前提由裁决册 §6 背书，全文见 `docs/role-adjudication.md`；若任一前提被真机推翻，以裁决册的
重裁结论为准：

1. `newProcess` 参数串解析/quoting、子进程工作目录与环境继承（shim 已用 `--server-root` 显式传参消解 cwd 依赖）。
2. `WSClient` 回环连接目标串格式与 `listen` 回调线程语义（影响 `mc.runcmd` 安全性）。
3. `runcmdEx` 输出串的编码/合流/截断；`mc.runcmd("say …")` 的实际呈现。
4. `ll.getCurrentPluginInfo().filePath` 实际取值与 `system.randomGuid` 格式。
5. BDS 硬杀时通道断开触发 shim 自杀的及时性（TCP RST 时序）；LeviLamina 是否替子进程兜底 reap。
6. 长驻 node 进程在 `newProcess` 下是否被 LSE/BDS 干扰。
7. `ready` 前退出的 `output` 内容可读性（引导失败的 stderr 是否并入）。

## 构建（开发者）

仓库根执行：

```
pnpm install && pnpm -r build
```

产物：`platforms/be/lse/dist/index.js`（壳）与 `platforms/be/lse/dist/bin/index.mjs`（node shim）。
连同 `plugin.json` 按上面部署清单布局拷入 `<BDS 根>/plugins/kurobridge/`
（`dist/index.js` → `plugins/kurobridge/index.js`，`dist/bin/index.mjs` → `plugins/kurobridge/bin/index.mjs`）。
