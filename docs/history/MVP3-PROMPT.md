# KuroBot MVP 阶段三任务书（无人值守）——external 协议端接入基座（MVP-3）

> 本文件是一次**无人值守任务**的完整任务书。执行智能体拿到本文即视为唯一指令来源，与任何对话历史无关。
> 完成后本文件保留，作为 MVP-3 的存档。
> 前置状态：原型、MVP-1/2、DEBT-1/2 全部完成并验收（master；结论见 `docs/STATUS.md`，决策与踩坑见各 NOTES）。
> 协议现状 v0.3.0（token / 兼容协商 / command-query 族 / death / reload 均已落地）。
> **范围由用户拍板（2026-09-13 开题对齐）**：
> ① MVP-3 只做 **external 形态**——napukettoqq 独立部署、经配置端口 + token 连入；「JAR 内嵌
>    napukettoqq + 扫码登录」留 MVP-4。
> ② 对接机制：**napukettoqq 原生新增 kurobot 协议适配器**（其 `packages/adapter` 新目录，
>    复刻 satori 模式）——该侧改动在 **NapukettoQQ 仓库另行任务书**执行，本册不做、也不改
>    `C:\Dev\Bot-Dev\` 下任何文件。
> ③ 多平台 node 三进制矩阵（linux/macOS + SHASUMS 严格模式转默认）拆出本阶段。
> ④ 两册任务书分开：本册是 **KuroAdapter 侧**（external 基座 + 对端接入指南）；napukettoqq
>    册待本册完成、指南定稿后另拟。本册产出 `docs/protocol/peer-guide.md` 是 napukettoqq
>    册的实现 SSOT。
> **本册预计零 Java 改动**（:core/:paper 不动，gradle 门禁照跑回归）。

---

## 0. 边界与纪律（先读，违反即任务失败）

- **工作区**：`C:\Dev\MC-Ecosystem\KuroAdapter`。所有文件的创建/修改**只允许发生在此目录内**。
- **禁止修改** `C:\Dev\Bot-Dev\` 下任何项目（napukettoqq / Koishi-CE 均在其中）。
- **无人值守规则：禁止向用户提问。** 所有决策自行拍板，并全部记入 `docs/MVP3-NOTES.md`
  （新建，决策编号 M3-01 起；做了什么决定、为什么、放弃了哪些替代方案）。只有遇到不停止
  就无法继续的硬阻塞时才允许结束任务，结束时在 NOTES 写清阻塞点。
- **Git**：直接在 `master` 上小步提交（简体中文提交说明，每阶段至少一个提交）。**不 push、
  不改写历史**。pre-commit 钩子（lefthook：`pnpm check` + `pnpm test`）被拒就修到绿再提交。
- **GPG 注意**：仓库开了 commit 签名。若 `git commit` 超过约 2 分钟无输出，疑似 gpg-agent
  口令缓存过期挂起——**禁止 `--no-gpg-sign`**；结束任务并在 NOTES 写明已暂存的变更清单，
  交由用户交互提交。
- 不要修改 `AGENTS.md` 与 `docs/DECISIONS.md` 中既有 ADR 的结论；本阶段新决策**追加**新
  ADR（**编号从 ADR-028 起**，动笔前先读 `docs/DECISIONS.md` 末尾确认最大号——当前已知
  最大号为 ADR-027）。
- **一切构建/测试命令统一经 `mise exec -- <cmd>`**（PATH 直连的 node/java 版本不对；mise
  提供 node 26.7.0 / java 25.0.2 / gradle 9.7.0）。
- **卡住规则**：任一阶段超过约 30 分钟无实质进展 → 降级目标并记 NOTES，继续推进不原地打转。

## 1. 目标与范围

现状：kurobot-ws 服务端只会 `listen(0)` 动态端口（`bridge/embedded/src/ws-server.ts` 硬编码
`port: 0`，无 host 概念）；config 无任何 WS 监听配置（`bridge/core/src/business/config.ts`
仅 channels/token/admins/runtime）；外部对端没有可实现的接入文档（协议知识散在 zod schema
与各包 design.md）；stub 只能作为孙进程连 `ws://127.0.0.1:<argv 端口>`。真实协议端
（napukettoqq）因此无处可连、无据可依。本阶段补齐 external 接入基座。

### 1.1 必须守住的红线（同 AGENTS.md，违反即任务失败）

1. 消息类型一律 `import { ... } from "@kurobot/protocol"`，禁止手写；协议 SSOT 是
   `bridge/protocol` 的 zod schema。
2. `bridge/core` 平台无关（零 Node API）；logger/clock/scheduler 一律注入。**WS 监听参数
   （host/port）是宿主事务**：config schema 可归 core（SSOT 惯例），但消费方在 embedded。
3. Java 薄壳不做业务；IPC 只走 stdin/stdout JSON-lines；**kurobot 永远是 WS 服务端**，
   对端主动连入。
4. 依赖方向遵守 AGENTS.md 第 7 条；不引入未指明的新依赖；不复制 HuHoBot / NapCat /
   NapukettoQQ 代码。
5. **workspace 跨包解析走 dist 产物**：改 `bridge/protocol` 源后必须先 `pnpm -r build` 再
   `pnpm check`/`pnpm test`（症状：新字段在消费方「不存在」，MVP1-NOTES 架构发现）。

### 1.2 已拍板的关键决策（按此实现，若有更优方案须在 NOTES 论证后仍自行拍板）

- **协议 → 0.3.1（patch）**：`hello` body 增**可选** `client: string`——对端自报身份串
  （建议 `名称/版本` 形如 `napukettoqq/1.0`），服务端仅用于连接日志辨识（握手成功日志展示），
  **不做任何行为分支**。可选字段对 0.2.x/0.3.0 对端双向兼容（zod 剥离未知键；先例：0.2.1
  的 ready 可选 autoRestart）。`WS_SUBPROTOCOL` 与兼容协商规则均不动。
- **config 新增顶层 `ws` 段**：`ws: { host?: string, port?: number }`（可整段缺省）。
  - 缺省（无 ws 段）= 现状不变：`listen(0)` 动态端口、不指定绑定地址（全部接口）。
  - `port` 配置 → 固定端口（external 对端连入点）；`host` 配置 → 绑定指定地址（如
    `127.0.0.1` 只听本机）；只配 host 不配 port = 动态端口 + 指定地址（合法）。
  - 段语义与字段校验进 core 的 `configSchema` / `defaultConfig()`（SSOT），同步更新
    `docs/config-schema.md`（本册必改，别忘）。
- **`NodeWsServer` 参数化**：构造器收 `{ host?, port? }`（embedded bootstrap 从 config 读
  出传入）；core 的 `KurobotServer` 与 `WsServer` 接口**不感知**监听参数（`start()` 返回
  实际端口的现状不变，ready 帧照报实际端口）。
- **固定端口绑定失败的语义**：绑定失败（含异步 `error` 事件 EADDRINUSE——ws 库的
  WebSocketServer 端口占用不一定在构造时抛，须验证并挂 error 处理）→ 打**明确的 error
  日志（含端口与原因）**→ Node 进程非零退出。Java 看护器（NodeSupervisor）按 1s/5s/15s
  退避自然重试、10 分钟窗 3 次失败放弃——长期端口冲突收敛为「放弃 + 日志」，与既有语义
  吻合，**不新增重试机制**。
- **安全基线（external 部署暴露面变大）**：config 含 `ws` 段且 `token` 为空 → 启动打
  **WARN**（提示 external 模式建议配置 token），不阻断启动（保持空 token 向后兼容语义）。
- **stub 扩展**（`bridge/embedded/stub/peer.mjs`）：
  - 新增 `KUROBOT_STUB_WS_URL`：覆盖连接地址（缺省维持 `ws://127.0.0.1:<argv[2]>` 现状）——
    使 stub 能以**独立进程**（不经孙进程拉起）模拟 external 对端连入。
  - 新增 `KUROBOT_STUB_CLIENT`：hello 携带 `client` 自报身份。
  - 既有钩子（PROTOCOL_VERSION/TOKEN/ADMIN_SOURCE/SEND_*）不动。
- **对端接入指南**：新建 `docs/protocol/peer-guide.md`——外部对端（napukettoqq 侧任务书、
  未来其它实现）的**唯一实现依据**，至少覆盖：
  1. 连接与子协议：`Sec-WebSocket-Protocol: kurobot-ws.v1` 必带（不带即被拒，现状
     `handleProtocols` 返回 false）。
  2. 握手时序与字段表：hello 全字段（含可选 token/client）、版本兼容规则（主版本号相同
     即兼容；`hello_ack ok:false` + close 1002 / 鉴权失败 close 1008 的区分）、
     `channelBindings` 快照语义。
  3. 心跳：空闲阈值（缺省 30s，任何入帧重置）、对端保活建议周期、超时关闭码（1001）。
  4. 重连：指数退避建议；1002（版本不符）应停止重连等待升级、1008（token 错）应停止
     重连等待配置修正——盲目重连风暴反模式要点名。
  5. 帧目录：逐帧列方向（Peer→Server / Server→Peer）、id 规则（请求带 UUID、事件无 id）、
     body 字段——**逐个对照 `bridge/protocol/src` schema 核对，禁止凭记忆写**。
  6. 业务约定：channel = QQ 群号字符串（绑定表 SSOT 在服务端 config.channels）；admins
     的 userId = QQ 号；command 触发形式（前缀）由协议端定义、`source` 提取职责在协议端；
     富文本段（@/图片/表情）→ 文本降级占位的建议。
  7. 安全基线：token 必配建议；明文 WS 仅限可信网络，跨公网走隧道（TLS/wss 不做，记债务）。
  8. 完整时序示例（hello → hello_ack → ping/pong → 双向 chat → command/query 往返）。
- **沙盒配置（本地，不入库）**：`sandbox/server/plugins/kurobot/config.json` 验收期加
  `ws` 段（建议 port 25580，避开 25565/25575）+ token；动态端口回归项用无 ws 段配置。
  验完还原基线。

### 1.3 明确不做（防跑偏清单，出现即算偏航）

- napukettoqq 侧 kurobot 协议适配器（NapukettoQQ 仓库另册）；koishi-plugin-kurobot。
- embedded 形态（JAR 内嵌 napukettoqq、wrapper.node 运行期发现、扫码登录）——MVP-4。
- 多平台 node 三进制矩阵、build:jar SHASUMS 严格模式转默认。
- TLS/wss、token 过期/轮换、多服务器 serverId 互联、msgContinue/msgEnd 流式、status 周期
  上报。
- Java 侧（:core/:paper）功能改动（发现 bug 可修，须 NOTES 记录并保持最小）。
- fast-check 属性测试、:paper 新增 MockBukkit。

## 2. 动手前必读（顺序执行）

1. `AGENTS.md` —— 工程指南与硬约束
2. `docs/STATUS.md` —— 现状（原型 / MVP 一 / 二 / DEBT-一 / 二结论五节）
3. `docs/DEBT1-NOTES.md`（D1-01~06，重点 D1-04 vanilla 输出捕获、鉴权与协商实现细节）
   与 `docs/DEBT2-NOTES.md`（看护器/退避/放弃语义——绑定失败语义依赖它）
4. `bridge/protocol/src/`（meta.ts / ws.ts / frame.ts）+ `bridge/protocol/docs/design.md`
   的 0.2/0.3 小节
5. `bridge/core/docs/design.md` + `bridge/core/src/server.ts` / `business/config.ts` /
   `transport.ts`（WsServer 接口契约）
6. `bridge/embedded/docs/design.md` + `bridge/embedded/src/index.ts` / `ws-server.ts` +
   `bridge/embedded/stub/peer.mjs`（既有钩子族）
7. `docs/config-schema.md`（本册要扩展的文档）

然后：环境基线验证——`mise exec -- pnpm check && mise exec -- pnpm test`（138 用例）全绿；
`platforms/je` 下 `mise exec -- ./gradlew.bat build` 全绿（**输出重定向文件再读，勿用管道**）；
沙盒冒烟（`scripts/paper-start.sh` / `paper-stop.sh`）。

按「设计先行」：动代码前先在 `bridge/protocol/docs/design.md`、`bridge/core/docs/design.md`、
`bridge/embedded/docs/design.md` 增「MVP 阶段三（MVP-3）」小节（0.3.1 帧变更、ws 段语义、
监听参数化与失败语义、stub 独立模式）。

## 3. 实现顺序（每阶段至少一个提交，全部简体中文提交说明）

```
阶段 0  设计先行 + 基线验证（可并入阶段 1 提交）
阶段 1  bridge/protocol 0.3.1：hello 可选 client；PROTOCOL_VERSION bump；vitest
        （schema + 兼容回归；改完先 pnpm -r build 再 check/test——§1.1 红线 5）
阶段 2  bridge/core：configSchema/defaultConfig 增 ws 段 + core design 更新；
        bridge/embedded：NodeWsServer 参数化（host/port）+ bootstrap 接线 +
        绑定失败语义（含异步 error 事件验证）+ 空 token WARN + vitest
阶段 3  bridge/embedded/stub：KUROBOT_STUB_WS_URL / KUROBOT_STUB_CLIENT 钩子；
        沙盒配置加 ws 段（本地）；独立 stub 连入冒烟
阶段 4  docs/protocol/peer-guide.md 对端接入指南（§1.2 内容清单，逐帧对表 schema）
        + docs/config-schema.md 增 ws 段说明
阶段 5  沙盒端到端验收（§4 清单）+ MVP3-NOTES / STATUS「MVP 阶段三结论」收尾
        + design 回填实际差异
```

## 4. 验收清单（全部打勾 = 任务完成）

1. **门禁全绿**：`mise exec -- pnpm check` / `pnpm test`（138 → 预期 150+ 用例）/
   `pnpm -r build`；`platforms/je` 下 `mise exec -- ./gradlew.bat build`（:core 65 用例，
   `--rerun` 真跑——本册无 Java 改动，纯回归）。
2. **动态端口回归**：config 无 ws 段 → 行为与现状逐项一致（孙进程 stub 握手、ready 上报
   动态端口、双向消息）。
3. **固定端口**：config 配 `ws.port` → ready/日志报该固定端口；`KUROBOT_STUB_WS_URL` 独立
   stub 连入握手成功 + 双向消息（日志 grep 证据）。
4. **绑定失败语义**：预占端口后再启动 → error 日志含端口与原因、Node 非零退出、看护器
   退避重启语义正常（不崩服、最终放弃日志可 grep）。
5. **安全基线**：ws 段 + 空 token → 启动 WARN 日志；非空 token → 正确 token 握手成功、
   错误/缺失 token 拒绝（close 1008）回归。
6. **client 自报**：stub 带 `KUROBOT_STUB_CLIENT` → 服务端握手成功日志可见该身份串。
7. **双对端并存**：两个独立 stub（不同 client）同时连入 → 游戏聊天双方都收到、
   送达数/日志无串扰。
8. **回归抽查**：DEBT-1 §4 关键路径复测——command（管理员/非管理员）、query（status/
   bindings）、death（假人击杀）、reload。
9. **指南完整性**：peer-guide.md 帧名/字段与 `bridge/protocol` schema 逐个一致；覆盖
   §1.2 第 4 条列出的 8 项内容；napukettoqq 侧可仅凭本指南 + schema 完成实现。
10. **文档收尾**：`docs/MVP3-NOTES.md`（决策 M3-xx 含放弃方案 + 债务清单更新——TLS/wss、
    embedded、矩阵等延续项）+ `docs/STATUS.md` 追加「MVP 阶段三结论」小节（只追加，不改
    既有内容）+ 各 design.md 回填实际差异。

## 5. subagent 使用策略

本册规模小（无 Java、跨包联动紧），预计**全部主做**，不派 subagent。若确需派发（如指南
文档初稿），prompt 必须自包含（含边界约束：只写本工作区、biome 风格、零新依赖、
`import type`、完成后自跑 `mise exec -- pnpm check`、**不要 git commit**）；subagent 返回
后主智能体必须亲自复核（读文件、跑门禁、亲测行为），不采信口头完成。

## 6. Windows / Git Bash 注意事项（实测踩坑，勿重趟）

- **无人值守跑沙盒服务器必须 `run_in_background` 承载主进程**——前台工具调用结束会杀
  tail|java 进程树（stdin EOF → 优雅停机）；该方式**不更新 paper.pid**，关停以
  TaskStop + 端口检查为准，勿依赖 paper-stop.sh 的 alive() 判断（DEBT1-NOTES D1-06）。
- **gradlew 输出经管道会挂起**（MVP1-NOTES M-18）→ 一律重定向文件再读；Spotless
  up-to-date 掩盖格式违规 → 跨阶段首跑 `:core:test --rerun`。
- mise 的 PATH **不传导**到 Java ProcessBuilder——开发覆盖模式需绝对路径（沙盒
  paper-start.sh 已处理）。
- 验证长驻进程靠 grep 日志（`[KuroBot]` 前缀；`logs/latest.log` 为准）；关服一律
  `scripts/paper-stop.sh`。
- 改 protocol 源后忘 `pnpm -r build` → 消费方「字段不存在」假红（§1.1 红线 5）。
- 测试坑：MSYS pid ≠ Windows pid（验进程用 winpid）；异步测试的日志基线快照必须先于
  触发动作（DEBT2-NOTES）。
- sandbox 配置改完记得还原基线；端口占用测试用完记得释放占用进程。

---

**一句话总结**：给 kurobot-ws 服务端装上「固定端口 + 绑定地址 + 安全基线」的 external
接入能力，写出 napukettoqq 侧可以照着实现的官方对端指南——真实 QQ ↔ MC 闭环的最后一段
在 NapukettoQQ 仓库接上。
