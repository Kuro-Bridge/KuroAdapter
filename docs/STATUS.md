# KuroBridge 现状与路线（STATUS）

> 开始任何工作前先读本文 → `architecture.md`（架构书）→ 对应包 `docs/design.md`。
> 本文只讲「现在」；阶段史（原型 → MVP-1~4 → DEBT-1/2 → 改名）的任务书/实录全在
> [`history/`](history/README.md)，拍板依据在 [`DECISIONS.md`](DECISIONS.md)（ADR-001~030）。

## 当前状态（2026-09-15）

**JE（Paper）主链全部完成**：MVP-1~4 + 两轮债务清偿 + 品牌迁移（KuroBot → KuroBridge）。
当前可分发形态 = `kurobridge-0.1.0.jar`（**48.5MB**，内嵌 Node 26 + napuketto CLI，开箱
控制台扫码），协议 `kurobridge-ws` **0.4.0**（改名后唯一 breaking = 握手子协议字符串，
帧形状零变化，ADR-030）。

- **embedded 形态**（MVP-4，ADR-029）：进程树 `Java → node → napuketto CLI(supervisor) →
  boot → self-host`（最深四层）全链实证；QR 文件交接 + `kurobridge qr` 子命令；崩溃看护
  （1s/5s/15s 退避重启、10 分钟窗 3 次失败放弃）；config 顶层 `embedded` / `ws` 段
  （形状 SSOT 归 core zod，ADR-028）。
- **external 形态**（MVP-3）：固定端口 + 绑定地址 + token 鉴权（close 1008）+ 主版本
  兼容区间协商 + 未知帧容忍；外部协议端实现依据 = [`protocol/peer-guide.md`](protocol/peer-guide.md)。
- **业务面**（DEBT-1）：绑定表 / 转发规则（按频道 fan-out）/ 群管理员映射 / WS command
  透传执行 / query 本地作答 / death / 配置热重载（`kurobridge reload`）/ 白名单 SSOT =
  MC 原生 whitelist。
- **门禁基线**（改名收尾时点）：`pnpm check` / `pnpm test`（171 用例）/ `pnpm -r build` /
  `gradlew build` + `:core:test --rerun` 全绿。
- **napuketto 外部契约原样**：env 名、文件名、TOML `[accounts.kurobot]` 段名、client
  自报格式均不改（RENAME-NOTES R-03 豁免清单是全仓仅存的 3 处 kurobot 字样）。

## 进行中：真机终验（唯一卡点）

沙盒侧已通：扫码 → session → 凭据落盘（`sandbox/server/plugins/kurobridge/`，
napuketto-data 已平移，预期 quick-login 免扫码）。stub 链冒烟全过（子协议协商 + token
鉴权 + 三子命令 + 无孤儿关停）。

**卡点已解除（2026-09-15）**：NapukettoQQ 侧已发布 `@napuketto/cli` **0.1.19** /
`@napuketto/adapter` **0.3.1**（含 kurobridge 接线 + 协议镜像对齐 `kurobridge-ws.v1` /
0.4.0；`@kuro-bridge/protocol@0.4.0` 已发。注：0.1.18/0.3.0 因发布物泄漏 `workspace:*`
作废）。发布物已解包实测：运行时常量为 `kurobridge-ws.v1`、依赖为真实版本号。

**收官链（下一步）**：

1. 本仓 `bridge/embedded/package.json` pin `@napuketto/cli` 0.1.17 → **0.1.19** →
   `pnpm build:jar` 重打包。
2. 重启沙盒（`scripts\paper-stop.cmd` → `paper-start.cmd`）→ 预期 **quick-login 免扫码**
   （凭据已落盘）；若回 QR 层用 `scripts\paper-qr.cmd` 重扫。
3. 验握手：hello 自报 `client=napukettoqq/0.3.1`（对端 0.4.0 兼容连入，子协议
   `kurobridge-ws.v1`）+ 25580 出现 ESTABLISHED。
4. 群消息双向（用户协作）：config.json `channels` 填真群号、`admins` 加真号 →
   `scripts\paper-cmd.cmd kurobridge reload` → 群消息进服广播 + `kurobridge send <文本>`
   进群。
5. 全过 → 关闭发现 H，本节改写为「终验通过」结论（终验实录口径见
   [history/MVP4-NOTES.md](history/MVP4-NOTES.md) §6/§7 +
   [history/RENAME-NOTES.md](history/RENAME-NOTES.md) 协作清单）。

## 待定事项

- koishi-plugin-kurobridge 独立仓库（ADR-018）：官方参考对端 + 平台渲染唯一归属，
  JE 闭环后启动（Koishi v4 基线）。
- `platforms/be` 家族骨架已建：`lse/`（TS，复用 bridge/core，QuickJS 可跑是硬约束）、
  `endstone/`（C++ 薄壳预留），实现排期在 JE 闭环后。
- `platforms/je` 的 fabric/neoforge/velocity 为预留骨架，接入对应服务端 API 后启用
  （多版本策略 ADR-021：适配层按版本矩阵构建，`:core` 与 `bridge/core` 不动）。

## 债务索引

跨阶段债务汇总（详细背景与当时取舍点进来源册；已完成项已移除）：

| 债务 | 来源册 |
|---|---|
| 多平台 node 三进制矩阵（linux/macOS）+ SHASUMS 严格模式转默认 | MVP2-NOTES |
| wine / Linux QQ 宿主（napuketto self-host 目前 Windows-only） | MVP4-NOTES |
| 多平台构建矩阵（napuketto 嵌包按构建机平台 npm 安装） | MVP4-NOTES |
| msgContinue/msgEnd 流式回报 | DEBT1-NOTES |
| status 周期上报（当前事件驱动：join/quit 时机推送） | MVP1-NOTES M-04 |
| serverId 多实例互联 | DEBT1-NOTES |
| TLS/wss 直连（当前官方建议 = 隧道部署，见 peer-guide §8） | MVP3-NOTES |
| 看护器窗口参数可配置化（现写死 10 分钟窗/3 次） | DEBT2-NOTES |
| JAR 体积优化（LZMA/分层下载）、运行期升级提示 | MVP2-NOTES |
| vanilla 命令输出捕获窗口语义（log4j 主线程窗口，并发混行理论风险） | DEBT1-NOTES 小债 |
| fake-player.mjs play 态 keepalive 未实现（限 30s 验收窗） | DEBT1/MVP3-NOTES |
| QR URL 正则 best-effort（napuketto 改日志文案即失效；PNG 路径为主不受影响） | MVP4-NOTES |
| `:paper` 侧单测偏薄（IPC 集成测试覆盖，Bukkit 桥接层缺单测） | MVP1-NOTES |

## 阶段史

8 个阶段的任务书与执行实录（含逐条决策、放弃方案、沙盒实录、架构发现）全部归档于
[`history/`](history/README.md)，含提交链索引表。历史册正文不改写；册内旧路径按
history/README.md 的路径口径理解。
