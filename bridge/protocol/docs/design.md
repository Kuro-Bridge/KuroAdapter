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

## 债务清偿一（DEBT-1，协议 v0.3.0，2026-09-13）

> 任务书：`docs/DEBT1-PROMPT.md`。把「只有事件集的 v0.2」升级为「带鉴权、兼容协商、请求-响应族与权限模型的 v0.3.0」。

1. **版本协商改兼容区间**：hello 校验从「精确相等」改为「**主版本号相同即兼容**」（0.2.0 对端可连 0.3.0 服务端；1.x 拒绝）。规则实现为协议包纯函数 `isProtocolVersionCompatible(peerVersion, serverVersion)`（解析 `^\d+\.\d+\.\d+$` 三元组比主版本；任一解析失败 = 不兼容——虽然 hello schema 已强制格式，防御性兜底）。不兼容仍走既有拒绝路径（`hello_ack ok:false` + close 1002 + reason）。`hello_ack` 回服务端实际版本（现状保持）。
2. **未知帧容忍策略**（协商区间的安全网，WS 服务端收帧侧行为）：未识别的**请求帧**（header 带 UUID id）→ 回同 id 的 `<type>_result` 帧体 `{ok:false, error:"unknown frame type"}`，不断连；未识别的**事件帧**（无 id）→ 忽略 + debug 日志，不断连。补充规则（ADR-026）：未知 type 以 `_result` 结尾（对端回了我们不认识的响应帧）视为响应帧**不回执**、仅 debug 忽略——避免「响应回执响应」的乒乓循环。协议包为此导出**通用线格式帧 schema**（`wireFrameSchema`：`{header:{type,id?}, body:unknown}`，type 仍受 snake_case 约束）供消费方「先取 type、再分发到具体 schema」的两段式解析；容忍行为本身在 core（server.ts）实现。IPC 侧不做容忍（Java 与 Node 同仓同版发布，属 lockstep 通道，未知帧 = 版本错位 bug，保持 warn+丢弃响亮暴露）。
3. **hello 可选 token**：`hello` body 增可选 `token: string`。鉴权语义（draft §4.1）：服务端配置非空 token 且 hello 未带/带错 → `hello_ack ok:false "auth failed"` + close 1008（policy violation，区别于版本不匹配的 1002）。缺省 `""` = 不鉴权（向后兼容）。不做 token 过期/轮换（本机/可信内网场景）。
4. **`command` 请求族（Peer→Server）**：请求 body `{command, source: {channel, userId}}`（source 必填——协议端负责从群消息提取发送来源）；响应 `command_result`（同 id）body 复用 IPC `execute_command_result` 的结果体（ok 分支带可选 `output: string[]`，error 分支 `{ok:false, error}`）。管理员判定/命令执行在 core 与 Java 桥接层，协议只定形。
5. **`query` 请求族（Peer→Server）**：请求 body `{kind: "status" | "bindings"}`；响应 `query_result`（同 id）body `{ok:true, data}` | `{ok:false, error}`，`data: unknown`——具体形状由 kind 决定（status → StatusBody 同构、bindings → string[]），关联靠同 id；协议层不强校验 data 形状（消费方按请求的 kind 解释，避免一帧多态 schema 的复杂度）。
6. **death 事件**：IPC 新事件 `player_death`（Java→Node，body `{player, message}`——帧名对齐 `player_join`/`player_quit` 的事件源语义，无 channel 无 id）；WS 新事件 `death`（Server→Peer，body `{channel, player, message}`，按绑定频道 fan-out 对齐 join/leave）。字段名按任务书原文用 `player`/`message`（与 join/leave 的 `playerName` 存在命名不一致，任务书为唯一指令来源，照办并记录）。`message` 允许空串（Bukkit `PlayerDeathEvent#deathMessage()` 可为 null，Java 侧以空串兜底）。
7. **`config_reload` IPC 事件（Java→Node）**：body 为空对象 `{}`——重载无参数；未来若需携带来源等再以非必填字段扩展（zod 默认剥离未知键，旧 Node 收到带额外字段的帧不炸）。
8. **`execute_command_result` body 扩展 `output`**：ok 分支增可选 `output: string[]`（命令输出行，Java 收集型 CommandSender 回传）；缺省不带（空输出不产生字段）。该结果体同时复用为 WS `command_result` body。
9. **聚合 union 更新**：`wsInboundFrame` 增 command/query；`wsOutboundFrame` 增 command_result/query_result/death；`ipcNodeInboundFrame` 增 player_death/config_reload；`ipcJavaInboundFrame` 不变。
10. **PROTOCOL_VERSION `0.2.1` → `0.3.0`**（0.2.1 为 DEBT-2 顺延后的实际基线）；`WS_SUBPROTOCOL = "kurobot-ws.v1"` 不动（大版本未变）。

## MVP 阶段三（协议 v0.3.1，2026-09-13）：external 接入基座

> 任务书：`docs/MVP3-PROMPT.md`。本阶段服务端补「固定端口 + 绑定地址 + 安全基线」的
> external 接入能力（napukettoqq 独立部署连入）；协议变更刻意最小（patch），帧形设计
> 落点只有一处。

1. **hello 可选 `client`（对端自报身份串）**：body 增可选 `client: string`——建议 `名称/版本`
   形如 `napukettoqq/1.0`。服务端**仅用于连接日志辨识**（握手成功日志展示），不做任何行为
   分支（未来真正的能力开关应以显式字段/协商机制引入，不劫持该字段）。
   - 向后兼容双向成立：旧对端（0.2.x/0.3.0，不带 client）连 0.3.1 服务端正常握手（可选字段）；
     新对端连旧服务端，client 被非严格 object 剥离（先例：0.2.1 的 ready 可选 autoRestart）。
2. **`WS_SUBPROTOCOL`（kurobot-ws.v1）与版本兼容协商规则均不动**：主版本兼容区间（ADR-026）
   下 0.3.1 为 patch 增量，0.2.0 对端仍可连入。
3. **PROTOCOL_VERSION `0.3.0` → `0.3.1`**；Java 侧硬编码副本 `KurobotVersions` 同步（D2-05
   维护约束）。
4. vitest：client 携带/缺省均合法、非字符串拒绝；0.3.0 形状（无 client）握手回归。

### 实现回填（2026-09-13 验收后）

- client 仅经 core `server.ts` 握手成功日志展示（无则旧格式），未进任何状态或判定——
  「不做行为分支」的实现最小化成立。
- 对端接入语义沉淀至 `docs/protocol/peer-guide.md`（napukettoqq 册的实现 SSOT），
  帧目录与本文/schema 逐字段对照一致。

