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

## 架构发现（随做随记）

- **pnpm script-shell 的 cmd.exe 转发会把 node 子进程的 UTF-8 中文日志在 GBK 代码页下显示成
  乱码**（直接 `node scripts/embed.ts` 显示正常）。纯显示层问题——产物文件均为 UTF-8 写盘，
  不影响功能；不改代码（控制台代码页是宿主环境属性）。
- **shadowJar 的 deflate 把 103MB 的 node.exe 压到 JAR 总量 41MB**（node.exe 内部有大量可压缩
  段）。JAR 体积可接受（ADR-014 预期内），解压后磁盘占用 ~104MB（bin/ 三件套）。
- **gradle 对 gitignored 的 `resources/embedded/` 目录照常打进 processResources**——gitignore
  只影响版本库，不影响 source set 扫描，无需额外配置。

## 沙盒端到端验收实录（任务书 §4）

（阶段 3 回填）

## 债务清单更新

（阶段 3 回填）
