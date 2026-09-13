# KuroBot MVP 阶段三决策记录（MVP3-NOTES）

> 配套任务书：`docs/MVP3-PROMPT.md`（external 协议端接入基座）。本文记录 MVP-3 期间的
> 全部自主决策、放弃的替代方案、架构发现与债务清单更新。无人值守规则：所有决策自行拍板
> 并记于此。前置：原型 D-01~D-15、MVP1 M-01~M-20、MVP2 M2-01~M2-11、DEBT-1 D1-01~06、
> DEBT-2 D2-01~10。

## 环境与基线（阶段 0，2026-09-13）

- 门禁基线全绿：`mise exec -- pnpm check` / `pnpm test`（138 用例）/ `pnpm -r build`；
  `platforms/je` 下 `mise exec -- ./gradlew.bat build` 全绿（输出重定向文件）。
- 沙盒冒烟通过：paper-start → node 拉起 → stub 握手（0.3.0）→ stub 消息进游戏 → Done；
  paper-stop 优雅退出。
- **ADR 编号确认**：动手前重读 `docs/DECISIONS.md` 末尾，最大号 ADR-027，本册新决策
  ADR-028 起（任务书预设正确）。
- ws 库行为实验（设计依据，Node 26.7.0 + ws 8.x）：`new WebSocketServer({port, host})`
  构造时同步发起 listen；**EADDRINUSE 不在构造时抛**，经底层 http server 以 `error`
  事件异步转发（ws 源码 `addListeners` 转发 listening/error/upgrade）；`address()` 构造后
  同步可得（listen(0) 立即返回真实端口）。

## 决策记录

### M3-01 绑定失败判据：一次性 error 监听 + listening 事件竞态收口

任务书要求「异步 error 事件须验证并挂 error 处理」。实现取 `start()` 内 Promise 收口：
先挂 `once("error")`（失败判据）、再挂 `once("listening")`（成功判据），二选一触发后
互移对方——不依赖 `address()` 的同步可得性（当前 Node 26 同步可得，但跨版本行为是
实现细节，listening 事件是 ws 库的公开契约）。绑定失败 reject 类型化 `WsBindError`
（message 含 host/port 与原因）；**绑定失败的实例不登记 `this.server`**（stop() 维持
no-op，进程清理路径安全）。放弃方案：① 轮询 `server.address()`（竞态 + 丑）；② 构造后
同步读 address 判成功（当前 Node 可行但依赖未定契约）；③ `listening` 后再补挂 error
（EADDRINUSE 窗口内漏检）。
listening 之后的 error 事件（accept 层等非绑定失败）经注入 logger 打 error 日志、不退出
——仅防未处理 error 事件炸进程，超出本册范围的处置明确记录。

### M3-02 config.ws 形状：core 可选段 + parseConfig 条件展开

`KurobotConfig.ws?: { host?: string | undefined, port?: number | undefined }`。
exactOptionalPropertyTypes 下成员显式 `?: T | undefined`（bootstrap 可直接透传
`config.ws?.host`，不产生字面量 undefined）；`parseConfig` 用条件展开
（`...(ws === undefined ? {} : { ws })`）保证「整段缺省 = 结果对象无 ws 键」；
`defaultConfig()` 不含 ws 段（生成的默认配置维持动态端口现状，external 由服主显式添加）。
形状归 core 的 SSOT 论证见 ADR-028。zod 校验：port 1-65535 整数、host 非空串；
`ws: "25580"` 等整段非对象 → ConfigError（config.test.ts 覆盖）。

### M3-03 空 token WARN 打点在 embedded bootstrap，core 零行为

安全基线是宿主事务（external 暴露面判断与启动日志都在引导层），core 只定义形状——
与「监听参数是宿主事务」同一条红线推论。文案点明「任何对端均可免鉴权连入」+「建议配置
token」，不阻断启动（保持空 token 向后兼容语义，任务书拍板）。

### M3-04 client 日志展示：后缀拼接，无 client 时格式与旧版完全一致

`server.ts` 握手成功日志：有 client → `（platform=stub，client=napukettoqq/1.0）`；
无 client → `（platform=stub）`（逐字节对齐 0.3.0 格式，验收 grep 不受影响）。
「仅日志辨识、不做行为分支」的红线靠实现最小化保证：client 不进 PeerState、不参与任何
判定。

### M3-05 Java 侧唯一改动 = KurobotVersions 常量同步

`:core` 的硬编码副本 0.3.0 → 0.3.1（D2-05 维护约束：改协议须同步，集成测试 stub 握手
断言兜底暴露漂移）。任务书「预计零 Java 改动」成立（该常量是展示用途的同步义务，
非功能改动）；gradle 门禁照跑回归（build + `:core:test --rerun` 65 用例）。

### M3-06 沙盒验收前发现：插件 JAR 内嵌的是构建期产物，改 TS 后必须重建

阶段 3 首次启动沙盒出现 stub auth failed 且端口仍动态——溯源：`sandbox/server/plugins/
kurobot.jar` 是 DEBT-1 期构建的旧产物（不含 ws 段消费逻辑）。处置：`pnpm build:jar`
全链路重建后按预期。这是打包链的既定语义（JAR 自含 dist 产物），非缺陷；记入 NOTES
作为无人值守验收的流程提醒——**改 TS 后跑沙盒前先 `pnpm build:jar`**。

### M3-07 death 验收受阻与假人修复：teleport confirm 缺失导致玩家半生成态

- 症状链（2 小时排查）：FakePlayer 每次进服 `Health=0.0f`、僵尸不索敌、`/kill` 无效果、
  死亡事件从不触发；删除 playerdata 无效；`/damage` 报 invulnerable。
- 判别实验定位：换全新玩家名（FreshPlayer）立即正常（health 持续变化并被 Spider 击杀）
  ——问题锁死在 FakePlayer 专属状态：早期一次「僵尸在玩家完成进服流程前」的击杀把
  health=0 写进了 playerdata，此后每次进服都是「死人在场」的僵死态。
- 顺带修复假人缺陷（sandbox 资产，本地文件不入库）：1.21.4 的 synchronize_position
  （实测 S2C **0x42**）需回 confirm_teleportation（C2S **0x00**），不确认则玩家停在
  半生成状态（health 0、怪物索敌/死亡处理异常）。包号经「首见打印 + 长度特征（len=61）
  」实测确定（当前 minecraft.wiki 只载协议 776，包号不可直接引用）。
- 最终验收证据：`收到死亡：[stub-channel] FreshPlayer FreshPlayer was slain by Spider`
  ——PlayerDeathEvent → Java DeathListener → IPC player_death → core fan-out → WS
  death → stub 打印全链真实事件（击杀来源是蜘蛛而非僵尸，Bukkit 事件路径同一条）。
- 放弃方案：改用 `/kill` 触发（输出「Killed FakePlayer」但死亡事件同样被僵死态吞掉，
  不可用）；绕过 death 项只凭 :core 集成测试背书（DEBT-1 已有，但本册拒绝降级——
  死亡链是 MVP-3 对端要消费的核心事件）。
- 教训：假人资产「能登录」≠「完成进服」；验收用玩家名一旦僵死即换名判别，勿反复重试。

### M3-08 Windows 绑定语义发现：通配与特定地址绑定可并存

绑定失败验收首试：占位进程绑 `127.0.0.1:25580` 后，服务端绑 `0.0.0.0:25580` **成功
共存**（Windows 允许通配与特定地址各一个绑定，SO_EXCLUSIVEADDRUSE 未设）——没触发
EADDRINUSE，孙进程 stub 反而连上了占位进程。处置：占位进程改绑通配地址后复现成功。
结论：绑定失败的复现与测试必须**同地址形态**占位；`ws-server.test.ts` 的端口占用用例
用 `net.createServer().listen(0)`（同族 socket，语义一致）不受影响。

### M3-09 阶段顺序微调：绑定失败与空 token WARN 提前到阶段 3 验证

任务书把它们列在 §4 验收与阶段 5，但基础设施在阶段 3 冒烟期已就绪（占位进程、沙盒配置、
独立 stub），就地验证避免二次搭建；证据记于本文件「沙盒端到端验收实录」，阶段 5 复查
确认。属顺序优化而非范围变更。

### M3-10 peer-guide.md 的形态：实现 SSOT + napukettoqq 册的唯一输入

- 按任务书 8 项清单全覆盖；帧目录逐个对照 `bridge/protocol/src/messages/ws.ts` 现源
  编写（非凭记忆），含 body 字段表、id 规则、fan-out 语义、未知帧容忍行为。
- 明确「本文与 schema 不一致时以 schema 为准」的 SSOT 声明与漂移处理路径。
- 面向 napukettoqq 实现者的决策性内容：channel=群号字符串、admins.userId=QQ 号、
  command 前缀与 source 提取职责在协议端、富文本→文本降级占位建议（@提及/图片/表情）、
  重连反模式点名（1002/1008 停止重连）。
- 版本演进速查表（0.2.0→0.3.1）帮对端实现者理解兼容边界。

## 沙盒端到端验收实录（任务书 §4）

| # | 项 | 结果 | 证据（sandbox/server/logs/latest.log 为主） |
|---|---|---|---|
| 1 | 门禁全绿 | ✅ | pnpm check / test（146 = 138+8）/ pnpm -r build；gradlew build + `:core:test --rerun`（:core 65 用例） |
| 2 | 动态端口回归 | ✅ | 无 ws 段配置：`Node ready：wsPort=56507`（动态）→ 孙进程 stub 握手 0.3.1 → `kurobot send` 双向通 |
| 3 | 固定端口 | ✅ | ws.port=25580：ready/就绪行报 25580；`KUROBOT_STUB_WS_URL` 独立 stub 连入握手成功 + `kurobot send` 收到；netstat LISTENING 25580 |
| 4 | 绑定失败语义 | ✅ | 通配占位 25580 → `WS 服务端启动失败：…绑定失败（port=25580）：listen EADDRINUSE: address already in use :::25580` → node exit=1 → 看护器 1s/5s 退避 → 3 次 SEVERE 放弃；服务器不崩 |
| 5 | 安全基线 | ✅ | ws 段+空 token → `已配置 ws 监听段但 token 为空——…建议配置 token` WARN（不阻断，空 token 全放行）；非空 token：正确握手成功 / 错误与缺失均 `握手被拒：auth failed`（close 1008） |
| 6 | client 自报 | ✅ | `对端 stub-2360 握手成功（platform=stub，client=napukettoqq/1.0）`；另一对端 client=kurobot-test/2.0 同可见；无 client 时日志维持旧格式 |
| 7 | 双对端并存 | ✅ | 两个独立 stub（不同 client/peerId）同时连入：`kurobot send` 双方均收到同一广播；各自握手自动消息均进游戏（无串扰、送达数正确） |
| 8 | 回归抽查 | ✅ | command：管理员 `whitelist list` → `成功，输出行 [There are no whitelisted players]`；非管理员 → `失败（error=forbidden）` + warn；query status → `{"tps":20,"onlinePlayers":1,...}` / bindings → `["stub-channel"]`；death → `收到死亡：…FreshPlayer was slain by Spider`；reload → `收到绑定变更：[stub-channel,stub-channel-2]` |
| 9 | 指南完整性 | ✅ | peer-guide.md 覆盖任务书 8 项；帧名/字段对照 `bridge/protocol/src` 现源编写；napukettoqq 可仅凭本指南 + schema 实现 |
| 10 | 文档收尾 | ✅ | 本文 + STATUS「MVP 阶段三结论」+ 三份 design.md MVP-3 小节（实现回填）+ config-schema.md ws 段 |

沙盒还原：config.json 还原基线（无 ws 段）；world 地形修复（fill 回填 + 补草方块 +
清 94 实体）；paper-stop 优雅关服；占位/stub 后台任务全部 TaskStop 回收。

## 债务清单（下一阶段输入）

- **延续项**：embedded 形态（JAR 内嵌 napukettoqq + 扫码登录，MVP-4）、多平台 node
  三进制矩阵 / build:jar SHASUMS 严格模式转默认、TLS/wss（隧道部署已是官方建议路径，
  见 peer-guide §8）、msgContinue/msgEnd 流式、status 周期上报、serverId 互联、
  看护器窗口参数可配置化、JAR 体积优化。
- **新增小债**：① `sandbox/fake-player.mjs` play 态 keepalive 仍未实现（30s 超时窗口
  限制验收时长；teleport confirm 已补，死亡/击杀场景可用）；② 本地沙盒 world 地形经
  fill 修补与原始超平坦略异（仅本地，不影响验收证据）；③ 服务端 `ws.host` 绑定非本机
  地址（如容器内多地址）的失败语义未实测（单测与沙盒仅覆盖 127.0.0.1/通配）。
