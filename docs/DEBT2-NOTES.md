# KuroBot 债务清偿二决策记录（DEBT2-NOTES）

> 配套任务书：`docs/DEBT2-PROMPT.md`（进程健壮性与工程收尾）。本文记录 DEBT-2 期间的
> 全部自主决策、放弃的替代方案、架构发现与债务清单更新。无人值守规则：所有决策自行拍板并记于此。
> 前置：原型 D-01~D-15（PROTOTYPE-NOTES）、MVP1 M-01~M-20、MVP2 M2-01~M2-11。

## 环境与基线（阶段 0，2026-09-13）

- `mise exec -- pnpm check` / `pnpm test`（80 用例）/ `pnpm -r build` / `gradlew build`
  （22 任务 up-to-date）全绿；沙盒冒烟：node ready → stub 握手（0.2.0）→ Done → 优雅退出。
- **基线判定：DEBT-1 未执行**（master 无其提交；仅并行会话的文档产物入库，见 D2-10）。
  任务书 §1.2 预案生效：协议变更按实际基线 0.2.0 → **0.2.1** patch 顺延；验收清单 §4.11
  中「若 DEBT-1 已合入」的回归项不适用，MVP1/2 路径照常回归。

## 决策记录

### D2-01 退出通知挂在 NodeIpcListener 上，优雅关停不发通知

`NodeIpcListener` 新增 `onProcessExited(Integer exitCode, String cause)`：由既有
`tearDownChannel`（幂等 CAS）触发恰好一次。`exitCode` 可为 null（stdin 写失败时进程
刚被 destroyForcibly / 退出码不可取）。判定「优雅」复用 `shutdownStarted`——shutdown()
路径不通知，看护器只由异常路径驱动；回调线程语义与既有 listener 一致（读取线程）。
放弃方案：独立 callback 注册器（多一套注册/生命周期管理，listener 本就是回调集合）。
**连带修复一处既有隐患**：非优雅 teardown 时若进程仍存活（stdin 写失败挂死场景）就地
`destroyForcibly()`，否则看护器重启会拉起第二个 node 造成双进程；同时把
`scheduler.shutdownNow()` 挪进 tearDownChannel——异常退出路径无人调 shutdown，原实现每次
崩溃泄漏一个调度器线程。

### D2-02 看护器 NodeSupervisor：factory 重建实例 + 失败 CAS 去重 + 双计数器

- 放 `:core`（零 Bukkit，可 JUnit；任务书「:core + :paper」的落位）。
- **重启 = 新建 NodeIpc**：NodeIpc 一次性设计（start 只能成功一次），看护器经
  `NodeIpcFactory` 每次重建，:paper 的 factory 闭包内更新 volatile `ipc` 字段——监听器/
  命令自动指向新实例。
- **失败两来源去重**：start future 异常完成（拉起失败/ready 前断开/超时）与
  `onProcessExited` 都可能对同一次尝试触发，`attemptActive` CAS 保证每次尝试只记账一次。
- **两个计数器语义分离**：连续失败数（驱动退避档位，成功 ready 归零——进程稳定运行视为
  恢复）；滑动窗口失败时间戳（驱动放弃判定，重启成功**不**擦除——任务书「累计」而非
  「连续」）。退避 1s/5s/15s 封顶末档，`backoffDelayMs` 纯函数可直测。
- 延迟调度注入 `DelayScheduler`（:paper 适配 ScheduledExecutorService 专用虚拟线程；
  测试用手动实现）。放弃方案：直接依赖 ScheduledExecutorService（:core 测试不可控）。
- autoRestart 开关：初值取 Options，**ready 帧上报后经 setAutoRestart 异步更新**（业务
  配置 SSOT 在 Node 侧，Java 只消费宿主参数，见 D2-03）。

### D2-03 autoRestart 经 onReady 签名携带，NodeIpc 归一化缺省

`NodeIpcListener.onReady(int wsPort, boolean autoRestart)`——ready.autoRestart（v0.2.1
可选字段）在 `NodeIpc.handleReady` 归一化（null → true，兼容旧 Node）后下发。
放弃方案：start future 的泛型改为携带 autoRestart 的 record（破坏既有
`CompletableFuture<Integer>` 形状，集成测试与消费方连带改动）；或 NodeIpc 存状态供查询
（竞态窗口 + 查询式 API 与既有回调风格不符）。

### D2-04 PID 文件由 NodeIpc 承担，残留故意保留作「异常退出证据」

`setPidFile(Path)`（public，start 前调用）：spawn 成功写 winpid（`Process.pid()` 即 OS
pid），**优雅关停删除；异常退出（teardown）不删**——残留正是下次 spawn 前 INFO 提示
「上次可能异常退出」的证据，写新值自然覆盖。放 NodeIpc 而非看护器：开发覆盖模式（无
看护器重启语义差异）也需要 PID 卫生，且写入时机绑定 spawn。不做跨进程互斥/防双实例
（任务书 §1.2 拍板：Paper 插件单实例由容器保证）。

### D2-05 就绪汇总行的版本来源与「node v dev」表示

- 插件版本 = `getPluginMeta().getVersion()`（paper-plugin.yml 的 version）。
- node 版本 = `EmbeddedRuntime.Installed` 新增第三字段 `nodeVersion()`（manifest 值，
  install 结果顺带返回）；开发覆盖模式无 manifest → 显示 `dev`。
- 协议版本 = `:core` 新常量类 `KurobotVersions.PROTOCOL_VERSION`（**硬编码副本**，SSOT
  在 zod 包；维护约束：改协议须同步，stub 握手断言兜底暴露漂移）。
- 实现中发现并修正双前缀回归：汇总行与退出通知日志手写了 `[KuroBot]` 前缀，与插件
  logger 自动前缀叠加（M2-11 同款坑）——已去手写前缀。

### D2-06 stub 自杀：连续 10 次未成功连入 → 打印原因 + 退出码 1

计数语义：`close` 且未成功 open 累加，`open` 成功清零；10 次即退出（服务器重启场景的
运行期断开同样受限——stub 是测试件，简单一致优先）。Job Object / 父进程死亡检测不做
（任务书 §1.2 拍板）。**实施后发现该机制在当前形态已是第二道防线**（见架构发现 A：
Node 26 子进程级联死亡，孤儿根本不存活），保留作为纵深防御（external 对端形态、
未来 Node 行为变化）。

### D2-07 build-jar.mjs 的三个 Windows 坑

- `gradlew.bat` 是批处理：Node 自 CVE-2024-27980 修复起拒绝无 shell 直接 spawn（实测
  `exit=null` 失败），win32 下必须 `shell: true`；POSIX 走 `./gradlew` + `chmod 0755`
  兜底。
- shell:true + args 数组触发 DEP0190 弃用警告——shell 模式改为拼接命令字符串（本脚本
  参数均无空格/特殊字符）。
- gradle 输出 `stdio: "inherit"` 直通终端，避开 M-18 的管道挂起坑；`JAVA_TOOL_OPTIONS`
  拼接注入 `-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8`（保留既有值），实测 JVM
  「Picked up」可见；当前构建日志 gradle 侧无中文可对照，node/embed 侧输出本就 UTF-8
  正常（cmd 壳实测 `file` 判定 UTF-8）——任务书 §4.7 的「UTF-8 可读」按此记录。

### D2-08 SHASUMS 严格模式：显式参数优先，env 兜底

`EmbedOptions.strict?: boolean`，缺省读 `KUROBOT_NODE_DIST_STRICT=1`（runEmbed 内解析，
vitest 显式传参不受宿主 env 污染）。非严格回退路径的 WARN 明示「校验值来源=缓存而非官方
在线值」并提示严格模式开关。默认路径行为不变（既有 10 例不回归）。

### D2-09 .gitattributes 例外清单并入阶段 4 提交（偏离「单独提交」的说明）

仓库已有 `.gitattributes`（2026-08-07，`* text=auto eol=lf`），本册补二进制例外
（jar/exe/dll/so/zip/图片/字体等显式 binary）。`git add --renormalize .` 评估：全仓
117 个 i/lf w/lf + 1 个 -text（gradle-wrapper.jar），**零内容波及**。偏离说明：该文件
在评估时已被 renormalize 暂存，与阶段 4 功能件一并提交（fb70253，5 文件）——因零内容
波及，未违反「避免与功能提交混入 renormalization 改动」的本意，补记于此。

### D2-10 并行 DEBT-1 会话：无冲突，文档产物已入库

DEBT-2 执行期间，另一并行会话按 DEBT-1 任务书启动并检测到本会话写码（其决策 D1-01），
**让行结束**，仅提交文档产物（941e5d7：DEBT1-PROMPT/DEBT1-NOTES + protocol design 增
DEBT-1 小节；4f27c9f：NOTES 修正）。两者均为 docs-only，与本册代码零冲突。DEBT-1 复跑
按其 NOTES 文末指引：协议版本将在 0.2.1 基线上继续（0.2.1 → 0.3.0）。

## 架构发现（随做随记）

- **A. Node 26 子进程级联死亡——「强杀 node 留 stub 孤儿」前提不再成立（重要）**：
  沙盒与最小环境双实测——taskkill 强杀 node.exe 后，node 亲自 spawn 的 stub（孙进程）
  **立即级联退出**（sandbox 16036 / manual 2584，10s 内消失且无重连日志），与 MVP1-NOTES
  「stub 无限重连」的行为相反；而 bash 直接 spawn 的 stub 连死端口则持续重连不受影响。
  推断 Node 26（libuv）在 Windows 上对子进程施加 Job Object（kill-on-close）语义。
  影响：本册的 stub 重连上限是纵深防御而非唯一治理；「孤儿治理」在当前运行时形态下
  天然成立。未来若换运行时/脱离 Job 场景，上限逻辑即主防线。
- **B. MSYS pid 坑重趟**：`$!` 是 MSYS pid，拿去 `Get-Process -Id` 会错查成无关进程，
  得出假「已退出」——两次误判后才想起 §6 与 paper-start.sh 注释（/proc/$!/winpid）。
  **验证进程存活一律 winpid**（已收录任务书级教训）。
- **C. 异步测试的快照必须先于触发动作**：NodeSupervisorTest 的日志等待基线
  （`base = logs.size()`）若在 `process.exit()` 之后取得，读取线程可能在两者之间写入
  目标日志——基线把目标行排除在外，等待必然超时。全量门禁下实测 5×15s 假超时（单跑
  5/5 通过掩盖了它），修法：exit 挪进 helper、严格在快照之后。等待窗 5s → 15s（全量
  跑集成测试真 node 负载下的调度延迟余量）。
- **D. spotless up-to-date 掩盖格式违规（M-18 教训二度应验）**：阶段 5 两次全量 build
  因 `spotlessJavaCheck FAILED` 回退修格式；跨阶段首跑一律 `spotlessApply` +
  `:core:test --rerun`。
- **E. KUROBOT_NODE 透传 = 放弃终态的沙盒复现手段**：paper-start.sh 保留透传，
  `KUROBOT_NODE=C:/nonexistent-path/node.exe` 注入坏路径，6s 内走完 1s→5s→第 3 次
  失败 → SEVERE 放弃，服务器不崩，/kurobot send 明确报「自动重启已放弃」。
- **F. cmd.exe 下 console.log 是 GBK 而 logs/latest.log 是 UTF-8**：控制台回显与
  logging.jsonl 的编码不一致（显示层既有认知，验收 grep 以 latest.log / 英文 token
  为主，python 按字节探测双编码兜底）。
- **G. 管道前缀的环境变量只作用于管道左端**（`FOO=x tail | node` 里 node 拿不到
  FOO）——最小环境复现 stub 行为时踩到，改 export 解决。

## 沙盒端到端验收实录（2026-09-13，任务书 §4）

| 项 | 结果 | 证据（sandbox/server/logs/latest.log 为主） |
|---|---|---|
| 场景 1 正常启动 | ✅ | 「Node ready：wsPort=61190，autoRestart=true」+「就绪：插件 v0.1.0 / node v26.7.0 / 协议 v0.2.1」+ stub 握手 protocolVersion=0.2.1 + node.pid=9176 |
| §4.2 崩溃自动重启 | ✅ | taskkill 9176 →「退出通知：exit=1」+「异常退出…1000ms 后自动重启（连续第 1 次）」+「残留 PID 文件（上次可能异常退出）」提示 + 拉起 + ready + 看护中 + 新 stub 握手；node.pid → 11476；`kurobot send` → stub「收到游戏聊天：<CONSOLE> 重启后双向恢复测试」 |
| §4.3a autoRestart=false | ✅ | config 写 `runtime.autoRestart:false` → ready 上报 false → 强杀后仅「退出通知」+「autoRestart=false，不重启」，无重启尝试；send →「发送失败：Node IPC 通道不可用」（console.log 74 行） |
| §4.3b 放弃终态 | ✅ | KUROBOT_NODE=坏路径 → 失败×3（1s/5s 退避）→「[SEVERE] 放弃自动重启：600s 窗口内累计失败 3 次」+「手动恢复路径」；服务器不崩；send →「发送失败：Node 进程反复崩溃，自动重启已放弃」 |
| §4.4 优雅关停回归 | ✅ | paper-stop.sh → 关机通知→stdin EOF→stub 退出→看护停止全链；node.pid 删除；无重启尝试；kurobot node/stub 零残留 |
| §4.5 stub 自杀 | ✅ | 独立运行连死端口：连续失败计数 1→10（1+2+4+…退避）→「连续 10 次重连失败…放弃重连并退出（孤儿治理）」+ 进程退出；注：沙盒强杀场景下 Node 26 级联死亡使孤儿不存活（发现 A），本项为纵深防御验证 |
| §4.6 重连一致性 | ✅ | vitest 8 例（reconnect.test.ts）：断开送达数归 0/重连新快照/1001+1002 断开重连/20 轮零泄漏/server.stop/Relay 重建恢复 |
| §4.7 双壳 build:jar | ✅ | Git Bash 与 cmd 各跑一次 exit=0（bash4/cmd 日志）；日志 UTF-8（file 判定）+ JAVA_TOOL_OPTIONS Picked up 证据 |
| §4.8 SHASUMS 严格模式 | ✅ | vitest 2 例：strict+缓存可用 → rejects「拒绝回退缓存」；非严格 → 回退成功 + WARN「来源=缓存」+ 提示开关；既有 10 例不回归 |
| §4.9 .gitattributes | ✅ | 二进制例外补齐；`git ls-files --eol` 无 CRLF（117 lf + 1 -text）；renormalize 零波及；pnpm check 绿 |
| §4.10 升级提示 | ✅ | 篡改 bin/NODE_LICENSE → 重启：「检测到打包内容变更（升级），已重建 plugins/kurobot/bin 内文件：NODE_LICENSE」（解压 1/复用 2）+「就绪：插件 v0.1.0 / node v26.7.0 / 协议 v0.2.1」 |
| §4.11 回归 | ✅ | DEBT-1 未合入（不适用）；MVP1/2 路径：绑定表/双向消息/stop 级联/二次启动复用均在本轮各场景中经过 |
| §4.1 门禁终态 | ✅ | `pnpm check` / `pnpm test`（93 用例 = 80+13）/ `pnpm -r build`；gradle build + `:core:test --rerun`（57 用例 = 44+13）全绿 |

## 债务清单更新（下一阶段输入）

- **napukettoqq 协议端接入**（MVP-3 主体；其重连策略属自身实现——当前 stub 的 10 次
  上限是测试件语义，不构成对端行为约束）。
- **多平台 node 三进制矩阵**（linux/macOS；部署平台拍板后做）。
- **协议补全（DEBT-1 复跑）**：token/版本协商/command/query/death/白名单——DEBT-1
  已让行待复跑（D2-10），复跑时协议版本 0.2.1 → 0.3.0。
- **JAR 体积优化（LZMA/分层下载）、运行期自动更新**（延续，低优先）。
- **msgContinue / serverId 互联 / status 周期上报 / 配置管理命令**（MVP1 债务延续）。
- **看护器窗口参数可配置化**：当前 Options 写死生产值（10 分钟/3 次），服主不可调；
  若 napukettoqq 接入后有真实崩溃数据再评估是否暴露进 config（避免过早参数化）。
- **NodeIpcTask 泄漏类隐患清零确认**：tearDownChannel 就地释放调度器后，NodeIpc 实例
  无线程遗留；若未来加新异步资源须同步纳入 teardown 链（约束注释已写在代码里）。
