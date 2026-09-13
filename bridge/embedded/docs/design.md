# bridge/embedded 设计（@kurobot/bridge-embedded）

> 本文件是包级设计文档（AGENTS.md：写代码前先更新对应包的 `docs/design.md`，设计先行）。

## 职责

嵌入式瘦身对端（`mode=embedded` 默认形态）：

- 复用 `bridge/core` 框架，作为对端连接 kurobot 的 WS 服务端。
- 内嵌 **napukettoqq** 协议端（QQ 连接，控制台扫码）。
- **无 Koishi**：esbuild 单文件产物，随 JAR 分发（嵌入式打包工具打包，待重建）。

## 与架构的关系（ADR-005 / ADR-006）

- embedded / external 只是打包差异：本包 = "协议端在 JAR 里"的形态；
  external 形态由独立仓库 koishi-plugin-kurobot 承担（ADR-018），两者复用同一 core。
- `wrapper.node`（腾讯闭源）不进 JAR，运行期从 QQ 安装目录发现拷贝（ADR-014）。

## 目录规划

```
src/
├── index.ts       # 入口：拉起 core 客户端 + napukettoqq（嵌入引导）
└── bootstrap.ts   # 子进程引导（stdin EOF 自杀 / Watchdog / 崩溃兜底）
```

## 实现顺序（STATUS.md 第 4 步细化）

1. core 客户端接入（对端角色：连接/握手/心跳/重连）。
2. napukettoqq 嵌入引导。
3. 子进程生命周期（stdin EOF 自杀 + PID + Watchdog）。

## 依赖

- `@kurobot/bridge-core`（workspace:*）。
- `@kurobot/protocol`（workspace:*）。
- esbuild（devDep，单文件打包）。

## 原型阶段（spike，2026-09-12）

> 任务书：`docs/PROTOTYPE-PROMPT.md` §1.2 / §4.2。完整设计（内嵌 napukettoqq）不变，本节只标注原型裁剪。

本阶段本包退化为 **Node 引导层（bootstrap）**，不含 napukettoqq：

- `src/index.ts`：入口——stdin/stdout IPC 端点（JSON-lines，帧走 `@kurobot/protocol`）+ 以子进程拉起 stub 协议端（孙进程，端口经 argv，决策 D-05）。
- `src/ws-server.ts`：`ws` 库实现 core 的 `WsServer` 接口（`listen(0)` 动态端口 + 子协议 `kurobot-ws.v1` 校验），唯一的 Node API 落点。
- `src/ipc-stdio.ts`：stdin/stdout 实现 core 的 `IpcChannel` 接口。
- stub 协议端：`stub/peer.mjs`（零依赖，Node 内置全局 WebSocket，决策 D-06）。

启动序列：Java 拉起本入口 → 起 WS 服务端 `listen(0)` → IPC 发 `ready`（携带端口）→ spawn stub → stub 以 WS client 连入并 `hello` 握手。stdin EOF 或 `shutdown` 帧 → 杀 stub → 自行退出（决策 D-08）。

原型裁剪：node.exe 不进 JAR（用 PATH `node` 或 `KUROBOT_NODE`，决策 D-07）、bundle 从 `KUROBOT_BUNDLE` 指定的本地产物加载、无 napukettoqq / wrapper.node / 扫码、无 Watchdog / PID 文件 / 崩溃自动重启。
