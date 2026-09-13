# KuroBot MVP 阶段二决策记录（MVP2-NOTES）

> 配套任务书：`docs/MVP2-PROMPT.md`（打包闭环）。本文记录 MVP 阶段二期间的全部自主决策、
> 放弃的替代方案、架构发现与后续债务。无人值守规则：所有决策自行拍板并记于此。
> 前置：原型结论见 `docs/PROTOTYPE-NOTES.md`（D-01~D-15），MVP 阶段一见 `docs/MVP1-NOTES.md`（M-01~M-20）。

## 环境与基线（阶段 0 前，2026-09-13）

- `mise exec -- pnpm check` / `pnpm test`（70 用例）/ `pnpm -r build` / `gradlew build`（22 任务
  up-to-date）全绿；沙盒 paper.jar 在位（1.21.4-232），`plugins/kurobot/config.json` 仍绑
  `stub-channel`（MVP1 验收后状态）。
- 沙盒冒烟：paper-start.sh（旧环境变量形态）→ 插件加载 → node 拉起 → stub 握手 → Done(20s)；
  paper-stop.sh 优雅退出。
- mise node 实测 v26.7.0，与任务书钉的 node 版本一致。

## 决策记录

### M2-01 embed 工具用 `scripts/embed.ts`（Node 原生 TS 剥离），非任务书字面的 `.mjs`

任务书 §3 阶段 1 写的是 `scripts/embed.mjs`。落地改为 `.ts`：根 tsconfig 的 include 含
`scripts/*`，`.mjs` 方案要么给测试导入引入 implicit any（tsc 红），要么手写 `embed.d.mts`
声明桥（双份签名维护）。`.ts` 直接受 tsc + biome + vitest 三套门禁覆盖，且 Node ≥ 23.6
原生 TS 剥离直接执行（本仓 tsconfig 锁 `erasableSyntaxOnly`，产物天然可剥离），零构建步骤。
放弃方案：`.mjs` + `.d.mts`；`.mjs` 无类型放行。

### M2-02 node dist 直连失败 → npmmirror 镜像（任务书 §1.2 预案生效）

`https://nodejs.org/dist` 直连下载 zip 报 `TypeError: terminated`（跨境网络不稳，重试同果）。
按任务书预案经 `KUROBOT_NODE_DIST_BASE=https://npmmirror.com/mirrors/node` 换镜像，
**校验逻辑不变**（sha256 仍对 SHASUMS256.txt，镜像文件与官方同内容）。一次成功。
后续构建优先走本地缓存（`.cache/node-dist/`），SHASUMS 在线拉取失败时回退缓存文件（离线可复用）。

### M2-03 `pnpm build:jar` 的 gradle 步骤用 `gradlew.bat`（非 `./gradlew`）

pnpm 在 Windows 用 cmd.exe 跑 script，`./gradlew` 报「'.' 不是内部或外部命令」。
AGENTS.md 本就规定「gradlew.bat 日常构建」。这是 `pnpm build:jar` 首次跑通 embed 之后的
完整链路（MVP1 期间 embed 步骤暂缺，gradle 均在 platforms/je 目录直跑，未暴露此问题）。
代价：script 写法 Windows 专属（本仓开发环境即 Windows，POSIX 贡献者债务记录在案）。

### M2-04 最小 zip 读取器手搓（EOCD → 中央目录 → 本地头）

「只用内置依赖」约束下 Node 无内置 zip 解压 API。实现三段式解析：EOCD 定位中央目录 →
条目元数据（method/comp 大小/crc32/本地头偏移）→ 本地头跳过自身 name/extra 后取数。
stored（method 0）直取、deflate（method 8）`inflateRawSync`，一律过 crc32 与解压长度双校验。
**不支持 zip64**（>4GB）——node 官方 win-x64 zip 远小于此，命中即抛错（防御性）。
放弃方案：外部 `tar.exe`（Win10+ 可解 zip，但引入宿主工具依赖）；第三方 unzip 库（违反约束）。

### M2-05 缓存与镜像的环境变量命名

`KUROBOT_NODE_DIST_BASE`（dist 基址，默认官方）/ `KUROBOT_NODE_CACHE_DIR`（缓存目录，默认
`<仓库根>/.cache/node-dist/`，已 gitignore）。命名对齐既有 `KUROBOT_*` 前缀族。下载器做成
可注入参数（`EmbedOptions.download`），vitest 全程不发真网（假 dist：手搓 zip + 真 sha256）。

### M2-06 产物四件套与 manifest 形状

`embedded/` 下四文件：`node.exe`、`index.mjs`（bridge/embedded/dist）、`NODE_LICENSE`
（zip 内 Node 的 MIT 许可证，任务书建议名）、`manifest.json`
（`{"nodeVersion":"26.7.0","files":{名: sha256}}`，运行期比对 SSOT）。幂等：产物 sha256 一致
跳过，不符 tmp+rename 原子覆盖；manifest 内容一致也跳过（稳定构建不反复触碰 JAR 输入）。

### M2-07 EmbeddedRuntime 放 `:core` 而非 `:paper`

解压加载链零 Bukkit API（Path/流/Jackson/MessageDigest），且 Jackson 已是 `:core` 的
implementation 依赖（放 `:paper` 要么再引一遍要么暴露 api）。`:core` 有现成 JUnit 设施 →
新增 EmbeddedRuntimeTest 8 例（幂等复用/损坏重建/越权名/资源哈希不符/manifest 损坏）；
`:paper` 维持「零单元测试、沙盒兜底」政策不变。

### M2-08 不用 java.util.zip，zip slip 防护落在 manifest 名单校验

任务书 §3 阶段 2 提示「java.util.zip + 防 zip slip」。落地改为 classloader
`getResourceAsStream("embedded/<固定名>")` 按名读资源——不枚举 zip entry，天然没有 entry
名注入面（比遍历解压更窄的攻击面）。防护落在 manifest 内容：文件名必须匹配
`[A-Za-z0-9][A-Za-z0-9._-]*`（单段、不以点开头），且 resolve+normalize 后仍在 bin 目录内
（双保险）；**校验整体前置**——任何越权名在触碰磁盘前拒绝整个 manifest（单测断言零落盘）。

### M2-09 bin 目录推导：cwd 相对 `plugins/kurobot/bin/`（任务书 §1.2 预拍板，坑实录）

不用 `getDataFolder()`——paper-plugin.yml 的 name 是 `KuroBot`，大小写敏感文件系统上
`plugins/KuroBot/` 与 Node 侧的 `plugins/kurobot/` 是两个目录。两侧统一以 cwd（=服务器根）
为基准推导（Node 读 config.json 本就如此），语义对称、Windows 大小写不敏感下自然合流。
沙盒实测落点 `sandbox/server/plugins/kurobot/bin/` ✓。

### M2-10 解压在 onEnable 同步执行（STARTUP 期）

首启解压+哈希 ~1s（Boot 16.2s，含 Paper 自身 ~15s），复用路径零成本（15.1s）。换来加载
顺序天然正确（解压完成才拉进程），无异步竞态。node.exe 只在启动路径解压（必然未运行，
无文件占用），不做运行期覆盖——任务书红线照办。

### M2-11 KuroBotPlugin 日志去掉手写 `[KuroBot]` 前缀

Paper 插件 logger 输出自动带 `[KuroBot]` 前缀，原先手写会出现 `[KuroBot] [KuroBot] …`
双前缀。本阶段触及的日志行已清理（EmbeddedRuntime 消息不带前缀，经插件 logger 自动获得）；
验收 grep `[KuroBot]` 不受影响。

## 架构发现（随做随记）

- **pnpm script-shell 的 cmd.exe 转发会把 node 子进程的 UTF-8 中文日志在 GBK 代码页下显示成
  乱码**（直接 `node scripts/embed.ts` 显示正常）。纯显示层问题——产物文件均为 UTF-8 写盘，
  不影响功能；不改代码（控制台代码页是宿主环境属性）。
- **shadowJar 的 deflate 把 103MB 的 node.exe 压到 JAR 总量 41MB**（node.exe 内部有大量可压缩
  段）。JAR 体积可接受（ADR-014 预期内），解压后磁盘占用 ~104MB（bin/ 三件套）。
- **gradle 对 gitignored 的 `resources/embedded/` 目录照常打进 processResources**——gitignore
  只影响版本库，不影响 source set 扫描，无需额外配置。
- **Java 侧 `-Xlint:all -Werror` 下 `String + byte[].getBytes()` 的拼接优先级坑**：链式拼接中
  `.getBytes()` 只绑定最后一个字面量（编译错），须整串加括号。测试里两处踩中。

## 沙盒端到端验收实录（2026-09-13，任务书 §4）

沙盒前置：`plugins/kurobot/config.json` 绑定 `stub-channel`（MVP1 遗留状态）；JAR 模式启动
（无 `KUROBOT_NODE`/`KUROBOT_BUNDLE`，仅 `KUROBOT_STUB_PEER` 指仓库内 stub）。

| 项 | 结果 | 证据（sandbox/server/logs/latest.log） |
|---|---|---|
| §4.3 首装（bin/ 清空） | ✅ | 「embedded 文件缺失，从 JAR 解压：node.exe / index.mjs / NODE_LICENSE」→「embedded 运行时就绪（node 26.7.0）：解压 3 / 复用 0」→「Node 进程已拉起：[…\bin\node.exe, …\bin\index.mjs]」→ stub 握手成功（protocolVersion=0.2.0）→ Done (16.179s)；bin/ 三件落盘（node.exe 103,173,960 B） |
| §4.3 stub→游戏 | ✅ | `[Server thread/INFO] <stub-群友> 大家好，我是 stub 协议端`（握手后广播进游戏） |
| §4.3 游戏→stub | ✅ | 控制台 `kurobot send 你好来自JAR模式` →「已发送」→ stub「收到游戏聊天：[stub-channel] <CONSOLE> 你好来自JAR模式」 |
| §4.4 幂等（二次启动） | ✅ | 「embedded 文件已就绪，复用（sha256 一致）×3」→「解压 0 / 复用 3」；Boot 回落 15.148s（复用零成本）；握手正常 |
| §4.4 自愈（删 bin/ 再启） | ✅ | 「缺失，从 JAR 解压 ×3」→「解压 3 / 复用 0」→ node 拉起 + 握手成功；Done (17.042s)；bin/ 三件恢复 |
| §4.2 JAR 内容物 | ✅ | `unzip -l`：embedded/node.exe（103,173,960 B）+ embedded/index.mjs + embedded/NODE_LICENSE + embedded/manifest.json + paper-plugin.yml；JAR 总量 41MB |

门禁终态（§4.1）：`pnpm check` / `pnpm test`（80 用例，含 embed 10 例）/ `pnpm -r build` /
`gradlew build` + `:core:test --rerun`（44 用例 = 36 旧 + EmbeddedRuntime 8 新，全过）全绿。
三轮启停均 `paper-stop.sh` 优雅退出，无孤儿进程。

## 债务清单更新（MVP-3 候选输入）

- **napukettoqq 协议端接入**（本阶段任务书明示的下一阶段主体；当前 stub 仍是测试件）。
- **多平台 node 三进制矩阵**（linux/macOS；win-x64 单平台是任务书 §1.2 批准的简化）。
- **`pnpm build:jar` 的 gradle 步骤写死 `gradlew.bat`**（Windows 专属；POSIX 贡献者需改回
  `./gradlew` 或引入跨壳方案）。
- **cmd.exe GBK 代码页下中文构建日志乱码**（显示层；如需根治可在 script 前置 `chcp 65001`）。
- **embed 的 SHASUMS 回退缓存**：镜像拉取失败时信任上次缓存值（npmmirror 与官方同源的信任
  假设）；对官方源的强校验以在线 SHASUMS 为准。
- **JAR 41MB / 磁盘解压 ~104MB**：体积可接受，但 release 分发可考虑 LZMA/分层下载（低优先）。
- **运行期覆盖/升级提示**：当前升级路径=换 JAR 重启；无版本变更的用户提示（INFO 日志里有
  nodeVersion，够 grep 不够运营）。
- MVP1 债务清单（`docs/MVP1-NOTES.md`）全部延续未动：白名单/权限、Watchdog/重启、重连、
  协议 command/query 族、status 周期上报、配置管理命令、`:paper` 单测、CRLF/.gitattributes。

