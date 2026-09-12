# KuroBot 原型机决策记录（PROTOTYPE-NOTES）

> 配套任务书：`docs/PROTOTYPE-PROMPT.md`。本文记录 spike 期间的全部自主决策、放弃的替代方案、架构发现与 ADR 候选。
> 无人值守规则：所有决策自行拍板并记于此。

## 环境（阶段 0 验证，2026-09-12）

- `mise`（2026.8.2）提供 node 26.7.0 / java 25.0.2 / gradle 9.7.0，与 AGENTS.md 要求一致。
- **PATH 直连的 node 是 v24.16.0、java 是 21.0.12**（不满足 engines>=26 / Gradle toolchain 25）。
  → **决策：一切构建/测试命令统一经 `mise exec -- <cmd>` 执行**，不依赖 PATH。
  → 副作用观察：`mise exec -- pnpm install/check/test` 全部通过，但 pnpm 自身仍报 `Unsupported engine node>=26 (current v24.16.0)` 警告（pnpm 独立二进制内嵌运行时所致），无害，忽略。
- 基线：`pnpm install` ✅ `pnpm check` ✅（7 文件）`pnpm test` ✅（3 用例）。
- 分支：自 `master` 切出 `prototype/spike`（任务书 §0）。

## 决策记录

### D-01 握手语义收敛为「Peer 发 hello → Server 回 hello_ack」

draft-v0.1.md 同时列了 Server→Peer 的 `hello`（携带 serverId/channelBindings）与 Peer→Server 的 `hello`，双向注册语义重叠。
spike 收敛为**单程握手**：客户端连入后发 `hello`（peerId/platform/version/protocolVersion，带 id），服务端校验后回 `hello_ack`（同 id，携带 serverId/version/协商后 protocolVersion + ok/error）。服务端身份信息并入 `hello_ack` body，不再单发 Server 侧 `hello`。
理由：请求-响应模型与 UUID 关联机制天然对齐，少一种帧型；正式版若需要服务端主动注册可再拆出。

### D-02 消息 schema 按「WS 侧 / IPC 侧」两文件组织，不按单消息一文件

`bridge/protocol/docs/design.md` 原规划 `src/messages/` 每消息一文件。spike 最小集只有 ~10 个 schema，拆 10 个小文件徒增跳转。
→ `src/messages/ws.ts` + `src/messages/ipc.ts` + 顶层 `meta.ts` / `frame.ts` / `index.ts`。文件内按消息分段注释。正式版消息增多后再按域拆分。

### D-03 IPC 响应帧命名 `*_result`（broadcast_result / execute_command_result）

IPC 请求-响应用显式响应帧型（请求 `broadcast` → 响应 `broadcast_result`，同一 id 关联），不用通用 `result` 帧。
理由：zod discriminated union 按 `header.type` 判别，显式帧型让每条响应有自己的 body schema，Java/TS 两侧都不需要二次分发。放弃了「单一 `ipc_result` 帧 + body 里嵌 type」方案（判别信息重复、类型不收敛）。

### D-04 WS 与 IPC 复用同一帧格式 `{ header: { type, id? }, body }`

IPC JSON-lines 帧直接复用 WS 帧结构（header/body），只是 type 命名空间不同（IPC 侧 snake_case 事件/请求名）。
理由：一套 Frame schema、一套编解码心智模型；Java 侧 Jackson DTO 也只需一套。

### D-05 embedded 引导模型：core 与引导层同进程，stub 协议端为孙进程（ADR 候选）

任务书 §4.2 预设方案落地：Node 引导层（bridge/embedded）= IPC 端点 + WS 服务端宿主，同进程内实例化 `bridge/core`；`listen(0)` 拿到端口后以子进程拉起 stub 协议端（端口经 argv 传入）。
→ Java 只管一个子进程，生命周期级联 Java→node→stub；协议端走与 external 完全相同的 WS client 路径。
→ **ADR 候选 A：内嵌协议端 = 独立孙进程（由 Node 引导层拉起），而非与 core 同进程。**

### D-06 stub 协议端用 Node 内置全局 WebSocket，不引 `ws` 依赖

Node 26 自带 Undici 全局 `WebSocket` 客户端。stub 只做客户端，用内置即可；`ws` 库只出现在 embedded 引导层（服务端角色）。

### D-07 Node 运行时与 bundle 路径经环境变量注入

- `KUROBOT_NODE`：node 可执行文件（缺省 `node`，走 PATH）。
- `KUROBOT_BUNDLE`：embedded 引导层产物 `dist/index.mjs` 绝对路径（Java 拉起子进程的入口）。
- 原型不做 JAR resources 解压 / tools/embed（任务书 §1.2 已批准的简化）。

### D-08 生命周期两条路径

1. 正常：Java onDisable → 发 `shutdown` IPC 帧 → 关 stdin → Node 收到帧或 stdin EOF 后自行退出（先杀 stub 孙进程）。
2. 兜底：Java destroyForcibly。无 Watchdog / PID 文件 / 自动重启（任务书 §1.2）。

### D-09 帧层 union 用 z.union，不用 discriminatedUnion

实测 zod 4.4.3：`z.discriminatedUnion("header.type", [...])` 抛 `Invalid discriminated union option`（不支持嵌套判别路径，判别键必须是 option 的顶层属性）。
→ 帧格式 `{ header: { type, id? }, body }` 保持不变，聚合 schema 用 `z.union([...各消息帧 schema])` 平铺。每个消息的帧 schema 单独导出，消费方按方向（发送方）选用精确 schema，聚合 union 只用于收帧侧的「接受任意已知帧」。放弃了「把 type 提到帧顶层」的方案（会偏离 draft-v0.1 已定稿的帧结构）。

### D-10 协议版本协商：spike 要求精确相等

大版本由 WS 子协议 `kurobot-ws.v1` 把关（握手期拒绝）；`hello.protocolVersion` 小版本在 spike 中要求与本端 `PROTOCOL_VERSION` **精确相等**，不匹配回 `hello_ack` error + 关连接（1002）。宽容的 semver 协商（兼容区间）留正式版。

### D-11 帧 schema 解析后 transform 为扁平消息 `{ type, id?, body }`

实测（TS 7/tsgo + tsc 行为一致）：**解构判别与嵌套属性判别都无法收窄 union**（`const { type } = frame.header` 与 `frame.header.type === "x"` 均不行——判别键必须是 union 变量的直接属性）。
→ protocol 包的帧 schema 在 zod `.transform()` 里把线格式 `{ header: { type, id? }, body }` 摊平成 `{ type, id?, body }`（线格式不变，Java 侧零影响）；消费方直接 `msg.type === "hello"` 原生收窄。出帧统一走 `encodeFrame(message)`。
→ 副作用：zod v4 对「泛型 body 成员的对象输出 + transform」推断不足（body 键在回调参数上丢失），SSOT 助手内用结构断言收拢（`frame as { header: …; body: z.output<B> }`），断言被限制在两个助手函数内。
→ 放弃的方案：①每分支二次 safeParse（重复解析、运行时多一次全量校验）；②把 type 提到线格式顶层（违背 draft 已定稿帧结构）。

## 架构发现（随做随记）

- **TS 生态摩擦**：嵌套判别不可收窄 + zod v4 泛型 transform 推断缺陷，是 SSOT「线格式=消费格式」设计的直接代价；D-11 的扁平 transform 层把它吸收在 protocol 包内，消费方零感知。正式版若消息变多，这个 transform 层就是「协议解析层」的雏形。

- （待补）

## ADR 候选清单

- **候选 A**（来自 D-05）：内嵌协议端以孙进程形态由 Node 引导层拉起，Java 只管一个子进程。
- （待补）

## MVP 阶段债务清单

- （待补）
