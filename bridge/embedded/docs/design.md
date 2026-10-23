# bridge/embedded 包级设计

> 系统级说明见 [docs/modules/bridge-embedded.md](../../../docs/modules/bridge-embedded.md)。本文件只记录包内布局与实现约束。

## 职责

`@kuro-bridge/bridge-embedded`：Node 引导层。装配 `bridge/core` 为可执行进程，承担全部 Node API 落点（stdin/stdout、`ws`、`fs`、子进程），可选拉起内嵌 napuketto 协议端。

## 目录

```
src/
├── index.ts           # 入口：配置装配 + WS 服务端 + IPC + 协议端分支 + 关停
├── config-store.ts    # Core ConfigStore 的 Node 实现（plugins/kurobridge/config.json + 2s 轮询）
├── ipc-stdio.ts       # stdin/stdout 实现 core 的 IpcChannel
├── logger.ts          # stderr logger，[KuroBridge][node][LEVEL] 唯一 writer
├── node-platform.ts   # NodeClock / NodeScheduler（定时器 unref）
├── ws-server.ts       # ws 库实现 core 的 WsServer（子协议 kurobridge-ws.v1）
├── napuketto.ts       # napuketto CLI spawner / 树杀 / QR URL 探测
├── qr-watcher.ts      # qrcode.png → plugins/kurobridge/{qr.png,qr.json}
└── version.ts         # BRIDGE_VERSION 单点
```

## 约束

- 本包是 Node API 的允许落点；core 侧不得反向依赖。
- 日志只进 stderr（stdout 是 IPC 通道）；不新增第二个 writer。
- 配置非法不致命：启动降级为空绑定，运行期 watch 保留旧值。
- 协议端分支的守卫是纯函数（`decideNapukettoLaunch`），便于测试。

## 构建与测试

- 构建：esbuild 单文件 ESM → `dist/index.mjs`（带 `createRequire` banner）。
- 打包：`toolings/packaging/embed.ts` 把产物与 node.exe / napuketto zip 写入 JE 各模块 resources。
- 测试：vitest（`logger` / `napuketto` / `qr-watcher` / `ws-server`），不发真实网络与真实进程。
