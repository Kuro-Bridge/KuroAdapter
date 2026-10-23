# bridge/core 包级设计

> 系统级说明见 [docs/modules/bridge-core.md](../../../docs/modules/bridge-core.md)。本文件只记录包内布局与实现约束。

## 职责

`@kuro-bridge/bridge-core`：平台无关的业务核心 + `kurobridge-ws` 服务端。宿主导入本包并注入传输层（`WsServer` / `IpcChannel`）、logger、时钟、配置源。

## 目录

```
src/
├── index.ts           # 聚合导出（公开 API 的唯一边界）
├── context.ts         # CoreContext：注入的 logger / serverId / version / token / 时钟
├── transport.ts       # WsServer / WsConnection / IpcChannel / Logger 接口
├── clock.ts           # Clock / TimerScheduler + ManualClock / ManualScheduler
├── server.ts          # KurobridgeServer：握手/鉴权/心跳/查询/command 分发
├── relay.ts           # Relay：IPC ↔ WS 路由与 IPC 请求-响应
├── test-fakes.ts      # 测试用内存传输层
└── business/
    ├── config.ts      # zod schema（配置形状 SSOT）+ parseConfig / defaultConfig
    ├── bindings.ts    # BindingTable
    ├── admins.ts      # AdminTable
    └── forwarding.ts  # platformChatTarget / gameEventChannels
```

## 硬性约束

- 零 Node API、零框架：不得 import `ws` / `process` / `fs` / `pino`，也不直接用 `setTimeout` / `Date.now`。
- target ES2020，`erasableSyntaxOnly`；产物可被 QuickJS 直接执行。
- 无全局单例：状态由 `CoreContext` 与实例持有。
- 传输层事件订阅可多次注册；实现方必须回调全部 handler（Relay 与引导层会各自订阅）。
- 依赖只有 `@kuro-bridge/protocol` 与 `zod`。

## 构建与测试

- 构建：`tsdown`，产物 `dist/index.mjs` + `dist/index.d.mts`。
- 测试：`vitest`，文件与源码相邻（`src/**/*.test.ts`）。时钟用 `ManualClock` / `ManualScheduler`，不真实等待。
- 金样本：`src/__tests__/golden.fixtures.test.ts` 校验 npm 包内 fixtures 的契约、SHA256 完整性与 `KurobridgeServer` 行为回放。

## 扩展规则

- 新业务：放 `business/` 的纯函数或表，在 `relay.ts` 接线；不要在 `server.ts` 加业务分支。
- 新协议帧：先改 KuroProtocol 并发版，再升依赖；不得在本包手写帧类型。
- 改导出面：同步 [docs/modules/bridge-core.md](../../../docs/modules/bridge-core.md) 的导出表。
