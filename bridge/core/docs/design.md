# bridge/core 设计（@kurobot/bridge-core）

> 本文件是包级设计文档（AGENTS.md：写代码前先更新对应包的 `docs/design.md`，设计先行）。

## 职责

kurobot 的业务核心 + `kurobot-ws` 协议服务端（ADR-005：业务在 Node 侧）。

- 绑定/白名单/指令权限/转发规则等业务逻辑。
- WS 服务端：握手、鉴权、心跳、UUID 请求-响应、`msgContinue` 流式回报、指数退避重连。
- 与 Java 薄壳的 stdin/stdout JSON-lines IPC（ADR-010）。

## 硬性约束（AGENTS.md 硬约束 #3，ADR-007）

- **零 Node API**：禁止 `ws`/`process`/`fs`/`pino` 等。
- 传输层抽象为可注入接口：`WsServer/WsClient`、`Logger`、`IpcChannel`。
- target ES2020（根 tsconfig 已锁），保证 QuickJS（LSE）可跑。
- `erasableSyntaxOnly`：产物无 tslib/装饰器依赖。
- core 无全局单例（对齐 Napuketto ADR-015 推论）：logger/connection/state 均为实例化对象，由 `CoreContext` 持有。

## 目录规划

```
src/
├── context.ts        # CoreContext：注入的 logger/传输层/配置持有者
├── server.ts         # KurobotServer：WS 服务端（握手/心跳/连接生命周期）
├── ipc/              # 与 Java 薄壳的 JSON-lines IPC（inbound/outbound）
├── handlers/         # 消息处理：chat/command/query/…
├── business/         # 绑定列表 / 白名单 / 权限 / 转发规则（纯逻辑）
└── index.ts          # 聚合导出
```

## 实现顺序（STATUS.md 第 2 步细化）

1. 传输层接口 + `CoreContext`。
2. 握手状态机（hello/hello_ack，含协议版本协商）。
3. 心跳 + 假连接检测。
4. chat 收发最小闭环。
5. 业务模块（绑定/白名单/权限/转发）。

## 依赖

- `@kurobot/protocol`（workspace:*）——消息 schema SSOT。

## 原型阶段（spike，2026-09-12）

> 任务书：`docs/PROTOTYPE-PROMPT.md` §4 阶段 2。完整设计不变，本节只标注原型裁剪。

最小闭环（connect → hello 握手 → 心跳 → chat 收发）：

- `src/context.ts`：`CoreContext`（注入 logger + serverId）。
- `src/transport.ts`：`WsServer` / `WsConnection` / `IpcChannel` / `Logger` 可注入接口（零 Node API）。
- `src/server.ts`：`KurobotServer` —— 握手状态机（awaitingHello → established/rejected）、心跳应答（ping→pong）、连接生命周期；协议版本不匹配 → `hello_ack` error + 关连接。
- `src/relay.ts`：假转发规则（占位业务）——IPC `game_chat` → WS `chat` 推给已握手对端；WS `chat` → IPC `broadcast` 请求（UUID 关联，等 `broadcast_result`）。
- `src/index.ts`：聚合导出。

原型裁剪：无鉴权 token、无 `bindings_updated`、无 msgContinue、无指数退避重连（对端 stub 自行重连）、心跳只做应答 + 空闲超时关连接（不做多阈值假连接检测）、业务模块仅 `relay.ts` 假规则。
