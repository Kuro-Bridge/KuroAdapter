# MVP-4 执行实录与决策（MVP4-NOTES）

> 任务书：`docs/MVP4-PROMPT.md`（无人值守）。本文件是 MVP-4（JAR 内嵌 napuketto）的全部
> 决策记录（M4-xx）、嵌包清单与许可、沙盒验收实录、债务更新与用户协作清单。
> 提交链：17b9bb7（设计先行 + core embedded 段）→ 阶段 2（spawner + bootstrap）→
> 阶段 3/4（打包链 + EmbeddedRuntime + QR + /kurobot qr）→ 本册收尾。

## 0. 结论速览

**「装个 JAR、扫一次码即得群服互通」的最后一块拼图落地——embedded 形态完成。**
进程树 `Java → node(kurobot WS 服务端) → napuketto CLI(supervisor) → boot → self-host`
（最深四层）全链贯通并实证；沙盒无人值守验收推进到 QR 层（真扫码留协作清单）；
协议 0.3.1 一字未动（目标零协议变更达成）；napuketto 仓零改动。

- 门禁：`pnpm check` / `pnpm test`（167 用例，146 → +21）/ `pnpm -r build`；
  `gradlew build` + `:core:test --rerun`（:core 69 用例，65 → +4）全绿。
- 打包链：`pnpm build:jar` 一条命令产出含 napuketto 嵌包的 JAR（41MB → **48.5MB**，
  增量 = napuketto.zip 7.6MB + NAPUKETTO_LICENSES 124KB）。
- 红线：wrapper.node / QQ 安装包 / QQNT 腾讯二进制 **零命中**（清单 grep 证据见 §3）。

## 1. 决策记录（M4-01 起，均自行拍板）

### M4-01 嵌入入口与拉起参数：不传 `-q`，走 CLI 的 autoStart

- **拍板**：`spawn(node.exe, [<bin>/napuketto/node_modules/@napuketto/cli/dist/index.mjs])`，
  不带账号参数——CLI 走 autoStart（读 TOML `[[accounts]]` 拉起全部 `enabled` 账号，
  自身充当 supervisor），QQ 账号 SSOT 完全归 napuketto.toml。
- **放弃**：`-q <uin>` 单账号模式（KuroAdapter 得解析 TOML 提取账号，SSOT 破裂且引入
  TOML 解析依赖）；直接拉 loader self-host（绕过 CLI = 重造 supervisor/QR/凭据三层）。
- env 只注入 `NAPKETTO_CONFIG` / `NAPKETTO_DATA`（绝对路径），其余原样透传
  （`NAPUTO_QQ_PATH` 等由沙盒/服主按需设置——实测透传链 java → node → napuketto 有效）。

### M4-02 优雅关停 = `taskkill /PID <cli> /T /F` 树杀（不用 child.kill/信号）

- **依据（NapukettoQQ 仓考据）**：boot 层**无 SIGINT/SIGTERM 处理器**，全链无父进程
  监测；supervisor 的 stopAll 仅在其自身收到信号时生效，超时 5s 后也只自退不补刀。
  Windows 上 `child.kill()` = TerminateProcess——只杀 CLI 本体必留 boot/self-host 孤儿
  （持 instance.lock + 账号数据目录）。napuketto 自家的 `napuketto stop` 同款 taskkill
  树杀——这不是「不优雅」，是对其进程模型的如实适配。
- 有界等待 exit（5s，对齐 napuketto FORCE_EXIT_MS）后 node 自退；杀不死也不挂死关停链。
- **实测**（沙盒 E2）：stop → 「napuketto CLI 已退出（code=1，关停路径）」→ 全树灭、零孤儿。
  锁残留由 napuketto 的 pid 探活 + cmdline 比对自动接管，二次启动无感恢复。

### M4-03 CLI 意外退出 → node exit(1) → 沿用 Java 看护器退避

- spawner 以「报告点收敛」处理 exit/error 双事件（spawn ENOENT 只有 error 没有 exit，
  两者只报告一次）；关停路径（stopping=true）的退出不触发意外回调。
- **放弃**：node 内自建 napuketto 重启状态机——Java 看护器（1s/5s/15s、10 分钟窗 3 次
  放弃，DEBT-2）天然覆盖，第二套重试只会让「放弃终态」语义分裂。
- **实测**（沙盒 E1）：taskkill CLI 本体 → 「napuketto CLI 意外退出（code=1）」→ node
  exit(1) → 看护器 1000ms 重启 → 新 CLI 树四层拉起；被杀树的 boot/self-host 随 Job 级联
  消失、instance.lock 自愈接管，无人工干预。

### M4-04 快速失败语义的两个守卫，处理不同（任务书表述差异的拍板）

- **enabled 且无 `ws.port`** → 明确 error（含原因与修法）+ **exit(1)**——与 WsBindError
  同族：这是配置错误，静默降级为「无 napuketto 运行」会让服主以为配置生效；收敛于
  看护器退避（实测 3 次放弃，日志明确指向「补 ws.port 后重启」）。
- **非 Windows 宿主** → 明确 error + **不拉起、node 继续跑**（纯 WS 服务端，external
  对端不受影响）——这是宿主形态问题而非配置错误，进程继续运行提供最大可用性；
  wine 支持记债务。
- **CLI 入口文件缺失**（开发覆盖模式未装包）→ error + exit(1)：配置要求嵌入形态而
  产物缺失 = 快速失败（与上一条同族）。

### M4-05 QR 交接：双路信号 + 原子写状态文件

- **PNG 路（主）**：轮询（2s）扫 napuketto 数据目录各账号目录的 `cache/qrcode.png`，
  mtime+size 双指标判定变化（多账号并存取 mtime 最新），拷贝为 `plugins/kurobot/qr.png`；
  拷贝失败（napuketto 覆写中）不更新基线、下轮自然重试。
- **URL 路（best-effort）**：捕获流正则匹配 napuketto kernel 固定文案
  `请扫描二维码登录（保存: … | URL: …）`（全角括号；napuketto 无 TTY 检测，pipe 下
  ASCII 二维码照常输出——按 info 级透传，容忍即可）。
- 状态文件 `qr.json`：`{ pngPath?, url?, detectedAt }`，tmp+rename 原子写（node.pid 式
  运维文件先例）；消费方 `/kurobot qr` 纯文件只读展示（Java 不解析 napuketto 内部布局，
  零 IPC 零业务）。
- **放弃**：IPC 帧方案（协议 0.3.2 + napuketto golden 锁重对齐，任务书授权保留但实测
  文件交接完全可行，代价不成比例）。
- **实测**：QR 生成 → `qr.png`（604B）+ `qr.json` 落地；QR 过期自动刷新链路可见
  （detectedAt 与 URL 同步更新）。

### M4-06 嵌包打包形态：npm 真实文件树 → 零依赖 zip writer → 单一 zip 资源

- `scripts/embed.ts` 扩展：缓存目录 `<cache>/napuketto-cli-<version>/` 下
  `npm install @napuketto/cli@<pin> --omit=dev`（真实文件，规避 pnpm symlink；镜像经
  `KUROBOT_NPM_REGISTRY`）→ 递归收集 node_modules（跳过 `.bin` shim 与非普通文件，
  排序稳定）→ 手搓最小 zip writer（与 MVP-2 既有 reader 对称：deflate/stored 择优 +
  crc32 + UTF-8 名字标志）→ `embedded/napuketto.zip` 单一资源。
- 许可聚合 `NAPUKETTO_LICENSES`：依赖树全部顶层包（@scope 下钻）的 LICENSE* 文件 +
  特判收集 loader 自带 7zip 的 LGPL License 文件（M4-10），待遇对齐 NODE_LICENSE。
- 版本 SSOT = `bridge/embedded/package.json` 的精确 pin（embed.ts 读取并强校验
  精确 semver；升 napuketto = 改 pin + `pnpm build:jar`）。
- 依赖注入：`EmbedOptions.napuketto.install` 可注入（vitest 全程不发真网不装真包）。
- **放弃**：逐文件资源（manifest 数千条目、JAR entry 爆炸）；ZIP64/加密等 zip 特性
  （自包含依赖树用不到）。

### M4-07 Java 侧展开：哨兵幂等 + 升级重建 + zip slip 防护

- `EmbeddedRuntime` 扩展：manifest 顶层 `napukettoZip: {name, sha256, cliVersion}` 指针
  → zip 本体走既有逐文件链解到 `bin/napuketto.zip` → 展开到 `bin/napuketto/node_modules/`。
- 幂等：哨兵 `napuketto/.kurobot-install.json` 记录上次展开的 zip sha256——一致复用
  （实测二次启动「嵌包已就绪，复用」）；不符/目录无哨兵 → 删目录重建（升级/损坏自愈）。
- zip 本体保留在 bin（10MB 磁盘换校验链统一：files 幂等管本体、哨兵管展开）。
- 防护：entry 名拒绝绝对路径/反斜杠/盘符，resolve+normalize 后必须落在目标目录内
  （JUnit 覆盖 `../evil` 逃逸拒绝）。

### M4-08 CLI 入口定位：固定布局 `<argv1 所在目录>/napuketto/...`

- node 引导层从 `process.argv[1]`（index.mjs 绝对路径）推导 bin 目录，CLI 入口 =
  `<bin>/napuketto/node_modules/@napuketto/cli/dist/index.mjs`——与 embed 打包、
  EmbeddedRuntime 展开三方约定的固定布局，无配置无发现逻辑。
- 决策函数 `decideNapukettoLaunch` 纯函数化（守卫/路径解析可单测），bootstrap 只接线。

### M4-09 :paper 显式声明 Jackson 依赖

- `KurobotCommand qr` 需要解析 qr.json；:core 的 Jackson 是 `implementation` 不传递。
  选 :paper 显式声明同版本（shadow 合并 runtimeClasspath 去重，fat JAR 不重复），
  **放弃**把 :core 的 Jackson 升 `api`（Jackson 不是 :core 对外契约的一部分）。

### M4-10 7zip（LGPL）许可特判收集

- loader 包自带 `assets/7zip/`（7z.exe/7z.dll/7zz + License.txt/License-linux.txt）随
  npm 包原样分发（与 `npm install` 等价）；许可收集器顶层扫描覆盖不到包内子目录，
  特判该两条路径追加进 NAPUKETTO_LICENSES（LGPL 合规）。资产缺失（包版本变动）时
  跳过不致命。

## 2. 架构发现

- **A（napuketto 自愈链自证）**：QR 120s 登录轮超时 → napuketto 内部 boot 退出 → 其
  supervisor 按 TOML `autoRestart/restartDelayMs` 自动重启 boot（kernel pid 28120 →
  4644，KuroAdapter 全程无感）——嵌入层拿到的「自动重启」能力比预想的更厚。
- **B（Job Object 级联对四层树成立）**：强杀 kurobot node → T+1s 旧四层全灭
  （16504→0）——DEBT-2 发现（Node 26 libuv 对子进程施加 kill-on-close Job Object）对
  更深树复验成立；T+6s 看护器新树已拉起。注意 MSYS pid ≠ Windows pid，全部经
  PowerShell Get-CimInstance 按 winpid 核对。
- **C（instance.lock 残留自愈）**：E1 杀 CLI 后旧 boot 的锁文件残留，新 boot 靠
  pid 探活 + cmdline 比对自动接管，二次拉起无感。
- **D（QR 三呈现实测）**：URL 日志（固定文案可正则）/ PNG 文件（覆写刷新）/ 终端
  ASCII（无 TTY 检测，pipe 下照发、被 `[napuketto]` 前缀捕获）三者并存；URL 的
  `k=` 参数每轮刷新。
- **E（上游小瑕疵，只记录不修）**：napuketto CLI `--version` 硬编码 0.0.1（与包版本
  0.1.17 不同步）；hello `client` 实测 `napukettoqq/0.2.1`（adapter 包版本）。
- **F（smoke/probe 结论）**：`NAPUTO_SMOKE`/`NAPUTO_PROBE` 均在**真登录之后**才触发，
  无免登录烟测路径——无人值守验收只能到 QR 层（任务书 §1.2 的探索项闭环）。

## 3. 嵌包清单与许可（进 JAR 的全部内容）

| 项 | 版本 | 许可 | 说明 |
|---|---|---|---|
| @napuketto/cli | 0.1.17 | MIT | 嵌入入口（supervisor/QR/凭据现成能力） |
| @napuketto/adapter | 0.2.1 | MIT | kurobot-ws 客户端（golden 锁 0.3.1 @ b0809ef） |
| @napuketto/kernel | 0.1.1 | MIT | 生命周期/配置/日志 |
| @napuketto/loader | 0.0.31 | MIT | QQ 定位/下载/wrapper 加载 |
| @napuketto/network | 0.0.2 | MIT | —— |
| @napuketto/media | 0.0.4 | MIT | —— |
| npm 传递依赖 | —— | 各自许可 | pino/pino-pretty/smol-toml/commander/qrcode/ws/zod/hono/@hono/node-server/execa/file-type/image-size/silk-wasm 等，全文聚合于 NAPUKETTO_LICENSES（124KB） |
| loader 自带 stub QQNT.dll | —— | MIT（自研） | **自研**转发 DLL 编译产物（源码 private submodule），非腾讯闭源；随 npm 包原样分发 |
| loader 自带 7zip | —— | LGPL | 7z.exe/7z.dll/7zz，QQ 安装包解包用；License 文件已聚合（M4-10） |

- **红线 grep 证据**：JAR 清单与 napuketto.zip 2980 entry 中 `wrapper.node` /
  QQ 安装包 / QQNT 腾讯二进制 **零命中**；`.exe` 仅 7z.exe（LGPL 资产）。
  QQ 运行期文件（wrapper.node 拷贝、QQ 下载缓存）落在 napuketto 数据目录
  （`plugins/kurobot/napuketto-data/`，gitignore 内），**运行期自取、不进 JAR 不进仓**。
- 体积：napuketto.zip 7,592,104B（2980 文件，deflate）；NAPUKETTO_LICENSES 124,190B；
  JAR 41MB → 48,466,866B。

## 4. 验收实录（任务书 §4 对照）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 门禁全绿 | ✅ | pnpm check / test **167**（146→+21）/ build；gradlew build + :core:test --rerun **69**（65→+4） |
| 2 | 打包链 | ✅ | build:jar 一条命令；manifest.napukettoZip 校验覆盖；二次启动「解压 0 / 复用 5」+「napuketto 嵌包已就绪，复用（哨兵 sha256 一致）」；红线 grep 0；JAR 48,466,866B（§3） |
| 3 | 无 embedded 段回归 | ✅ | 沙盒 A：config 无 embedded 段 → stub 孙进程拉起 + 握手成功 + 动态端口 55345 + stop 级联关停无孤儿；既有 stub 测试零修改全绿 |
| 4 | embedded 启动链 | ✅ | 沙盒 C：config embedded 段 + napuketto.toml + ws.port=25580 → `[napuketto]` 前缀日志 → 数据目录创建 → NAPUTO_QQ_PATH 定位本机 QQ（零下载）→ 登录会话启动到 QR 层；四层进程树实证（25596→4144→8776→28120） |
| 5 | QR 交接 | ✅ | qr.png/qr.json 落地且随刷新更新（detectedAt 1789388516637 → 1789388653147，URL 同步换 k=）；`/kurobot qr` 输出 PNG 绝对路径 + URL + 检测时间 + 指引 |
| 6 | 固定端口强制 | ✅ | 沙盒 B：enabled 无 ws.port → 明确 error + exit(1) → 看护器 1s 退避、10 分钟窗 3 次放弃；napuketto-data 目录未创建（不拉起） |
| 7 | 生命周期矩阵 | ✅ | E1 CLI 意外退出 → error → 看护器 1s 重启 → 重拉 CLI（E-实录）；E2 stop → taskkill 树杀 → 关停路径日志 → 零孤儿；E3 强杀 node → T+1s 四层级联死亡 → 看护器重启（发现 B）；附带 instance.lock 残留自愈（发现 C） |
| 8 | 红线回归 | ✅ | stub 路径零改动（stub/peer.mjs 与其测试 untouched，全绿）；`grep -rnE "from \"node:|process\.|setTimeout…" bridge/core/src` 零命中 |
| 9 | 文档收尾 | ✅ | 本文件 + STATUS「MVP 阶段四结论」+ embedded/core design 回填 + config-schema.md embedded 段 + ADR-029 定稿 |
| 10 | 用户协作清单 | ✅ 已写 | 见 §6（执行者不执行） |

沙盒遗留状态：`sandbox/server/plugins/kurobot/config.json` 保持 embedded 验收形态
（enabled + ws.port=25580 + token），`napuketto.toml` 的 `qq` 为占位号 `10001`——
用户协作清单（§6）只需改真号 + 扫码。

## 5. 债务清单（新增/更新）

- **wine/Linux QQ 宿主**：napuketto self-host Windows-only（M4-04 守卫不拉起）。
- **QR URL 正则 best-effort**：napuketto 改日志文案即失效（PNG 路径为主，失效仅丢
  url 字段，不影响扫码主路径）。
- **多平台构建矩阵**：napuketto 嵌包按构建机平台 npm 安装（Windows 构建机产出 win
  依赖树）；Linux 构建机 + win 目标需 `--target-platform` 类方案（上游 npm 维度问题）。
- **napuketto CLI --version 硬编码 0.0.1**：上游瑕疵，嵌包版本探测不能依赖它
  （manifest 的 cliVersion 才是 SSOT）。
- **无人值守不可达项（转协作清单）**：真登录 → hello 握手 client 展示 → 群消息双向；
  quick-login 冒烟。
- **既有债务顺延**：多平台 node 三进制矩阵、SHASUMS 严格模式转默认（MVP-2）、
  wine（本册新增）；其余见 MVP3-NOTES。

## 6. 用户协作清单（真机终验步骤，执行者不执行）

> 前置：`pnpm build:jar` 已产出最新 JAR；沙盒配置已就位（embedded 验收形态）。

1. **填真号**：编辑 `sandbox/server/plugins/kurobot/napuketto.toml`，把
   `qq = "10001"` 改为你的 QQ 号（`[accounts.kurobot]` 的 url/token 保持
   `ws://127.0.0.1:25580` / `kurobot-sandbox-token`，与 config.json 一致）。
2. **启动**：`bash scripts/paper-start.sh`（可选：先 `export NAPUTO_QQ_PATH="C:\Program Files\Tencent\QQNT\QQ.exe"` 指向本机 QQ 免下载；不设则 napuketto 自动下载约 313MB 安装包）。
3. **扫码**：服务器控制台输入 `kurobot qr` → 按输出的图片路径用手机 QQ 扫码
   （或手机 QQ 打开登录链接）。约 120s 过期自动刷新，重跑 `kurobot qr` 看最新。
4. **验证登录成功**：日志 `grep -E "握手成功|client" sandbox/server/logs/latest.log`
   → 应见 hello 自报 `client=napukettoqq/0.2.1`（对端 0.3.1 兼容连入）。
5. **群消息双向**：把 QQ 群号写进 `plugins/kurobot/config.json` 的 `channels`
   （管理员映射 `admins` 同理加你的 QQ 号）→ 群里发消息应进游戏广播；
   `kurobot send <文本>` 应出现在群里（模板渲染效果主观确认）。
6. **/kurobot qr 体验**：确认输出文案、路径、链接可用性（反馈给 NOTES 记录）。
7. （可选）**quick-login 冒烟**：把 `embedded.napuketto.dataDir` 指向你日常
   napuketto 的 `.napuketto` 数据目录 → 重启 → 免扫码 quick-login 恢复。
   ⚠️ 同一账号数据目录单实例（instance.lock）：确认日常 napuketto 已停再试。
8. 验收后：`bash scripts/paper-stop.sh` 优雅关停（stop → 树杀 → 无孤儿可复验
   `tasklist | grep node`）。
