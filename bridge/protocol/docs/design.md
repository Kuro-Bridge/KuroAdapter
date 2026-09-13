# bridge/protocol 设计（@kurobot/protocol）

> 本文件是包级设计文档（AGENTS.md：写代码前先更新对应包的 `docs/design.md`，设计先行）。

## 职责

`kurobot-ws` 协议消息类型的 **zod schema SSOT**（ADR-008）。全项目唯一的消息类型来源，任何文件禁止手写消息类型。

## 约束

- 零框架依赖（仅 zod），零 Node API —— QuickJS（LSE）可跑。
- schema 即产物（`z.infer`），无生成步骤。
- 消费方用 `schema.safeParse()` 做协议层运行时验证（对端数据不可信）。

## 组成（规划）

- `src/meta.ts`：协议名 / 版本 / WS 子协议常量。
- `src/frame.ts`：帧格式 `{ header: { type, id? }, body }`。
- `src/messages/`：各消息 schema（hello / hello_ack / chat / join / leave / death / status / bindings_updated / command / query / ping / pong / msgContinue / msgEnd…）。
- `src/index.ts`：聚合导出。

## 实现顺序

1. 根骨架就绪（本文件所在阶段）。
2. 按 `docs/protocol/draft-v0.1.md` 逐消息细化 schema（STATUS.md 第 1 步）。
3. 每个 schema 配 vitest 单测（`safeParse` 合法/非法载荷）。

## 原型阶段（spike，2026-09-12）

> 任务书：`docs/PROTOTYPE-PROMPT.md` §4.1。本文档的完整设计不变，本节只标注原型裁剪。

最小 schema 集（可增不可减）：

- **WS 侧**（`src/messages/ws.ts`）：`hello`（Peer→Server，请求）、`hello_ack`（Server→Peer，响应，含 `protocolVersion` 协商）、`ping`/`pong`（心跳）、`chat`（Server→Peer 游戏聊天事件）、`chat`（Peer→Server 平台聊天）。
- **IPC 侧**（`src/messages/ipc.ts`）：`ready`（Node→Java，携带 WS 端口）、`game_chat`（Java→Node 事件）、`broadcast`（Node→Java 请求）、`broadcast_result`（Java→Node 响应）、`execute_command`（Node→Java 请求）、`execute_command_result`（Java→Node 响应）、`shutdown`（Java→Node 关机通知）。
- 帧格式（`src/frame.ts`）：WS 与 IPC 复用 `{ header: { type, id? }, body }`（决策 D-04）。
- 组织：`meta.ts` / `frame.ts` / `messages/ws.ts` / `messages/ipc.ts` / `index.ts`，不按单消息一文件（决策 D-02）。

原型裁剪掉的（正式版再上）：`join`/`leave`/`death`/`status`/`bindings_updated`/`command`/`query`/`msgContinue`/`msgEnd`、鉴权 token、channelBindings 字段。

实测备注（决策 D-09，见 `docs/PROTOTYPE-NOTES.md`）：zod 4.4.3 不支持嵌套判别路径（`z.discriminatedUnion("header.type", ...)` 抛错），帧层聚合 schema 用 `z.union([...])`；每个消息的帧 schema 单独导出，消费方按方向选用。

