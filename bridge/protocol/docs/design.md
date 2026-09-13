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

## MVP 阶段一（协议 v0.2，2026-09-13）

> 任务书：`docs/MVP1-PROMPT.md` §3 阶段 1。相对 spike 的增量：

1. **channel 概念落地**（对齐 ADR-004）：
   - WS `chat` 双向 body 各加 `channel: string`（游戏侧 `{channel, playerName, content}`，平台侧 `{channel, sender, content}`）——channel 是绑定表里的频道标识（如群号），由服务端绑定表决定 fan-out，对端按自己的频道映射渲染。
   - IPC `broadcast` 请求 body 加 `channel`（`{channel, message}`）——Java 侧 MVP 只广播不区分，字段保留给未来按频道渲染。
   - IPC `game_chat` **不加** channel：Java 零业务不知道频道，fan-out 是 Node 侧业务职责。
2. **新事件集**（Server→Peer，全部无 id 事件帧）：
   - `join` / `leave`：`{channel, playerName}`（玩家进出服，按绑定频道 fan-out）。
   - `status`：`{tps, onlinePlayers, uptimeSeconds}`（无 channel——是全服状态而非频道消息）。
   - `bindings_updated`：`{channelBindings: string[]}`（**变更后完整列表**，非增量；ADR-004）。
   - 对应 IPC Java→Node 事件：`player_join` / `player_quit`（`{playerName}`，无 channel）与 `status`（同 WS body）。命名对齐既有模式：IPC 帧名描述 Bukkit 事件源（如 `game_chat`），WS 帧名是协议事件（如 `chat`）。
3. **hello_ack ok 体加 `channelBindings: string[]`**：服务端绑定表快照随握手下发（ADR-004「绑定频道随 hello 上报」在单程握手（ADR-023）下的落点）。空数组合法（默认配置无绑定）。
4. **PROTOCOL_VERSION `0.1.0` → `0.2.0`**：新增字段/消息为向后不兼容的收帧集变化（新帧型旧对端不认识），在 D-10 精确相等策略下 stub 的 hello 同步升版本。

**status 推送时机（MVP 决策）**：Java 在玩家 join/quit 时顺带推送 status IPC 事件（在线数变化点），Node 转发给已握手对端——事件驱动、零定时器；周期上报与按需拉取留 MVP-2。

**取舍**：`tps` 为 1 分钟均值（Paper `getTPS()[0]`），`uptimeSeconds` 取 JVM uptime（JDK 标准接口，等价专用服的服务器 uptime，避免绑定不确定的 Paper API）。

