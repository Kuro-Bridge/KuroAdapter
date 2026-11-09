# 构建与发布

## 构建链

```
pnpm -r build                     # bridge/core (tsdown) + bridge/embedded (esbuild) + lse 双产物
  ↓
toolings/packaging/embed.ts       # 三平台 node + index.mjs + napuketto 嵌包 → paper/fabric resources
  ↓
gradlew :paper:shadowJar          # kurobridge-1.0.0.jar
  ↓
gradlew :fabric:remapJar          # kurobridge-fabric-1.0.0.jar
```

根命令 `pnpm build:jar` 依次执行以上四步（`toolings/packaging/build-jar.ts`）。顺序是硬约束：先有 TS 产物，才能嵌包，才能打 JAR。

## 产物

| 命令 | 产物 |
| --- | --- |
| `pnpm -r build` | `bridge/core/dist/`、`bridge/embedded/dist/index.mjs`、`platforms/be/lse/dist/{index.js,bin/index.mjs}` |
| `pnpm build:embed` | `platforms/je/{paper,fabric}/src/main/resources/embedded/`（三平台运行时 + shared 资产） |
| `pnpm build:jar` | `platforms/je/paper/build/libs/kurobridge-1.0.0.jar`、`platforms/je/fabric/build/libs/kurobridge-fabric-1.0.0.jar` |
| `pnpm smoke:handshake` | 无文件产物：对 `embedded/` 里的宿主平台二进制跑一次原生闭环（见下节） |
| `pnpm build:je` | 同上（gradle 全量 build，不重跑 embed；**新克隆须先跑过 `pnpm build:jar` 或 `pnpm build:embed`，否则 JAR 不含内嵌运行时**） |
| `pnpm build:endstone` | `platforms/be/endstone/build/core/`（portable 库 + 5 测试） |
| `cmake --preset windows-clang-cl` | `platforms/be/endstone/build/windows-clang-cl/endstone_kurobridge.dll` |
| `pnpm release:pack` | `dist-release/`：发布产物 + `SHA256SUMS.txt`（分片见下节） |

Endstone 的 dll 仍不在构建链里：`pnpm release:pack -- --only endstone` 会把 dll 与 embedded 的 win-x64 运行时收进 `kurobridge-endstone-<ver>.zip`；开发期真机仍按 SOP 手动预置（R3）。

## 嵌入式打包（embed.ts）

输入与输出：

- 输入：`bridge/embedded/dist/index.mjs`、Node 官方 **三平台** dist（`win-x64` 走 `.zip`，`linux-x64` / `linux-arm64` 走 `.tar.gz`）、`@napuketto/cli`（版本精确 pin 在 `bridge/embedded/package.json`）。
- 输出目录（`defaultEmbedTargets` 单一来源）：`platforms/je/{paper,fabric}/src/main/resources/embedded/`，两份内容相同。
- 文件：`node-win-x64.exe`、`node-linux-x64`、`node-linux-arm64`、`index.mjs`、`NODE_LICENSE`、`manifest.json`、`napuketto.zip`、`NAPUKETTO_LICENSES`。

`manifest.json`（schemaVersion 2）形状：

```json
{
    "schemaVersion": 2,
    "nodeVersion": "26.13.0",
    "shared": { "index.mjs": "<sha256>", "NODE_LICENSE": "<sha256>", "napuketto.zip": "<sha256>" },
    "runtimes": {
        "win-x64": { "file": "node-win-x64.exe", "sha256": "<sha256>" },
        "linux-x64": { "file": "node-linux-x64", "sha256": "<sha256>" },
        "linux-arm64": { "file": "node-linux-arm64", "sha256": "<sha256>" }
    },
    "napukettoZip": { "name": "napuketto.zip", "sha256": "<sha256>", "cliVersion": "0.2.0" }
}
```

行为：

- Node 分发版本钉 **26.13.0**（Active LTS），SSOT = `toolings/runtime-manifest.json`（`embed.ts` 与 `check-runtime-versions` 门禁共读，ADR-044）；下载后对官方 `SHASUMS256.txt` 做 sha256 校验；缓存缺省 `.cache/node-dist/`。
- Linux 归档用 `node:zlib` + 自研 tar 读取器（`toolings/packaging/tar.ts`）只取需要的条目：支持 ustar prefix、PAX `x` 扩展头、GNU `L` 长文件名，命中即返回，校验和逐块验证。零新依赖，不用 `.tar.xz`（要外部解压器且官方 tar.gz 已覆盖所需路径形态）。
- napuketto 依赖树用 npm 安装到缓存（真实文件，非 symlink），打成单一 `napuketto.zip`；许可聚合为 `NAPUKETTO_LICENSES`。
- 幂等：产物已存在且 sha256 一致则跳过；写盘走临时文件 + rename。
- 切换目标会自动清理上一次的 `node*` 产物（`pruneStaleRuntimes`），Lean / Universal 来回切不会把旧二进制留在 JAR 里。
- **红线断言**：写 zip 前扫描三类腾讯闭源件（`wrapper.node`、`QQNT*.dll/exe/so/dylib`、`QQ*.exe/apk/dmg/msi`），命中直接失败。

环境覆盖：

| 变量 | 作用 |
| --- | --- |
| `KUROBRIDGE_EMBED_TARGETS` | 覆盖本次要嵌的目标（逗号分隔，如 `win-x64` 或 `linux-x64,linux-arm64`）。缺省 = `runtime-manifest.json` 的 `targets`；未知目标直接抛错，不去重忽略（ADR-045） |
| `KUROBRIDGE_NODE_DIST_BASE` | Node 分发镜像（默认 `https://nodejs.org/dist`） |
| `KUROBRIDGE_NODE_CACHE_DIR` | 下载/嵌包缓存目录 |
| `KUROBRIDGE_NPM_REGISTRY` | napuketto 安装镜像 |
| `KUROBRIDGE_NODE_DIST_STRICT=1` | SHASUMS 在线拉取失败即失败，不回退缓存（发布用） |

> 换镜像不改变校验逻辑：仍对官方 SHASUMS 的 sha256 校验。

### Lean 构建（只嵌单平台）

```bash
KUROBRIDGE_EMBED_TARGETS=linux-x64 pnpm build:jar    # 产物只含 linux-x64 运行时
```

`release.ts` 的 JAR 必需条目由 manifest 的 `runtimes` 派生，所以 Lean 产物不会被「缺 win-x64」误判为失败。切换回默认（清空变量）后重跑 `pnpm build:jar` 即恢复三平台。

## 原生冒烟（smoke:handshake）

`toolings/smoke/node-handshake.ts` 在**当前宿主**上对 `embedded/` 里的那一个二进制跑最小闭环，跨平台（Windows / Linux）：

1. `node --version` 必须等于 manifest 里的版本（动态链接器、glibc 基线、可执行位的最小验证）；
2. 拉起 `index.mjs`，等 IPC `ready` 帧（拿 `wsPort`）；
3. 用 Node 内置 `WebSocket` 连入：`hello` → `hello_ack { ok: true }`，再 `query bindings` → `query_result`；
4. 关 stdin（等价 Java 关停）→ 期望 `exit 0`（ADR-041 优雅关停契约）。

失败时会打印子进程 stdout / stderr 的尾部 40 行；`KUROBRIDGE_SMOKE_KEEP=1` 保留临时目录供复盘。

## JAR 布局

`kurobridge-1.0.0.jar`（约 **147 MB / 140.6 MiB**，三平台内嵌）包含：

- `:core` 与 Jackson（shadow 合并）；
- `embedded/` 资源：`node-win-x64.exe`、`node-linux-x64`、`node-linux-arm64`、`index.mjs`、`NODE_LICENSE`、`manifest.json`、`napuketto.zip`、`NAPUKETTO_LICENSES`；
- `plugin.yml`（经典清单，1.12.2 ~ 26.3 全版本可加载；`paper-plugin.yml` 为 1.19.4+ 专属格式，ADR-038 弃用）。

首次启动把 `embedded/` 解压到 `plugins/kurobridge/bin/`：`shared` 全部落地，`runtimes` **只落当前平台那一个**，POSIX 上补 `+x`；napuketto zip 解压到 `bin/napuketto/`（哨兵文件记 zip sha256）。

Fabric 产物是 loom 重映射后的 mod jar；`:core` 与 Jackson 由 shadow 白名单合并，fabric-api/loader 不吞入。

## Linux 部署

JE（Paper / Fabric）的 `linux-x64` / `linux-arm64` 由 JAR 自带，服主无需安装 Node（ADR-046）。

官方 Linux 二进制的硬要求（构建期不变，运行期由预检识别）：

| 项 | 下限 | 检查命令 |
| --- | --- | --- |
| glibc | ≥ 2.28 | `ldd --version` |
| libstdc++（`GLIBCXX_`） | ≥ 3.4.25（GCC 8.1+） | `objdump -T plugins/kurobridge/bin/node-linux-x64 \| grep GLIBCXX \| sort -u` |
| 内核 | ≥ 4.18 | `uname -r` |

- 支持面：`linux-x64`、`linux-arm64`（glibc）。**Alpine / musl 不在支持面**（官方只有实验性的 `linux-x64-musl`，arm64 无）；Debian 10（glibc 2.28）是理论边界，未上机验收。
- 运行期布局：`plugins/kurobridge/bin/node-linux-x64`（arm64 为 `-arm64`），启动时幂等 `chmod +x`（0755）。用**非插件目录属主**的账号运行、从备份/`rsync` 还原、Docker 镜像 `COPY` 都会丢执行位——插件每次启动都会补，不需要手工 chmod。
- 预检行为：非 Windows 且未设 `KUROBRIDGE_NODE` 时先跑 `node --version`；失败则 WARN 并回退 PATH 上的 `node`（就绪汇总里 node 版本记 `system`）；PATH 也没有则 SEVERE，插件保持加载但无 IPC，不崩服。
- 手工指定运行时：`KUROBRIDGE_NODE=/usr/bin/node`（显式值永远优先，不做预检、不被替换）。
- 容器/精简镜像：确保 `libstdc++` 存在（Debian/Ubuntu 基础镜像默认有；`debian:slim` 亦有，`scratch`/`distroless` 需自备）。

## 发布打包（release.ts）

`pnpm release:pack` 把已构建产物收拢到 `dist-release/`（不触发构建；先跑对应构建步骤）。分片可单跑：

| 分片 | 命令 | 产物 | 定位 |
| --- | --- | --- | --- |
| `jar` | `pnpm release:pack -- --only jar` | `kurobridge-<ver>.jar`（Paper shadowJar，内嵌 Node 26.13.0 三平台 + napuketto 0.2.0）、`kurobridge-fabric-<ver>.jar` | 正式 |
| `lse` | `pnpm release:pack -- --only lse` | `kurobridge-lse-<ver>.zip`：`manifest.json` + `index.js` + `bin/index.mjs`（解压到 `plugins/kurobridge/`，node 运行时服主自备） | 预览 |
| `endstone` | `pnpm release:pack -- --only endstone` | `kurobridge-endstone-<ver>.zip`：`plugins/endstone_kurobridge.dll` + `plugins/kurobridge/bin/`（`node.exe` / `index.mjs` / `NODE_LICENSE` / `manifest.json`，解压到 BDS 根） | 预览 |
| `all` | `pnpm release:pack` | 以上全部 + `SHA256SUMS.txt` | — |

- `SHA256SUMS.txt` 只覆盖本次分片的产物（`--only lse` 不会列出不存在的 JAR）。
- `jar` / `endstone` 分片先做 embedded 清单自校验（逐文件 sha256）；`lse` 分片与 embedded 无关，跳过该校验。
- Endstone 分发包内的 `node.exe` 是从 embedded 的 `win-x64` 取件后改名——C++ 侧 `node_runtime.cpp` 硬编码该文件名，契约不变。
- 打包前四道校验：产物齐全非空；`embedded/manifest.json` 逐文件 sha256 与磁盘一致；JAR 必需条目（`plugin.yml` / `embedded/*`，平台条目由 manifest 派生）齐全且体积 > 30 MB；JAR 条目名不命中腾讯闭源件红线。zip 生成后回读条目名，确保分隔符为 `/`。

> 预览件指 LSE / Endstone 真机联调尚未完成（见 [status.md](../status.md)）：产物结构与门禁已就绪，行为背书待补。

## CI

`.github/workflows/ci.yml` 四个 job（push `main` / PR）：

| job | runner | 命令 |
| --- | --- | --- |
| `ts` | ubuntu-latest | `pnpm install --frozen-lockfile` → `pnpm check && pnpm test` |
| `java` | ubuntu-latest | mise 提供 JDK 25 → `sh ./gradlew build` |
| `endstone` | windows-latest | `cmake --preset core && cmake --build --preset core && ctest --preset core` |
| `embed` | ubuntu-latest / ubuntu-24.04-arm / windows-latest | `pnpm -r build` → `KUROBRIDGE_EMBED_TARGETS=<本平台> pnpm build:embed` → `pnpm smoke:handshake` |

ts job 与本地 pre-commit 同构；`pnpm check` 自含 `pnpm -r build` 首环。endstone job 只跑 portable 层，dll 轨道仍是手动 SOP。embed job 是「二进制在这个内核上真能跑」的唯一机器证据：每个 runner 只嵌自己命中的目标，跑原生闭环（矩阵与 `runtime-manifest.json` 的 `targets` 必须同步）。24.04 runner 的 glibc 是 2.39，验的是「能跑」；2.28 底线靠真机验收。

## 发布工作流

`.github/workflows/release.yml`（推 `v*` tag 或手动 dispatch）：

| job | 内容 |
| --- | --- |
| `verify` | tag 与根 `package.json` 的 version 必须一致 |
| `jar` | `mise x -- pnpm build:jar`（三平台 embed + shadowJar / remapJar）→ 本 runner 的原生冒烟 → `release:pack -- --only jar` |
| `lse` | `pnpm -r build` → `release:pack -- --only lse` |
| `publish` | 取回两个分片 → **对下载回来的字节重算** `SHA256SUMS.txt` → `gh release create/upload` |

Endstone 分片不在工作流内：它依赖 windows-clang-cl 手工产出的 dll，本地 `pnpm release:pack -- --only endstone` 收拢后手工挂到 Release。

## 发布检查清单

1. 改版本：六点同改（见 [开发指南](development.md#版本对齐)），协议升级时同步 `KurobridgeVersions.java`。
2. 改内嵌 Node 版本：只改 `toolings/runtime-manifest.json` 的 `nodeVersion`，再按 `check-runtime-versions` 的报错把 `.nvmrc` / `mise.toml` / `engines` 同步（门禁会逐条指路）。
3. `pnpm install --frozen-lockfile` 绿。
4. `pnpm check && pnpm test` 绿。
5. `pnpm build:all` 绿（JE + Endstone）。
6. 设置 `KUROBRIDGE_NODE_DIST_STRICT=1` 后跑 `pnpm build:jar`，再跑 `pnpm smoke:handshake`。
7. 构建 Endstone dll（`cmake --build --preset windows-clang-cl`）。
8. `pnpm release:pack` 生成 `dist-release/`；核对脚本输出的 sha256 与体积。
9. 冒烟：Paper 沙盒起服 → ready 汇总行 → `/kurobridge send` → 协议端收到；`/kurobridge reload` 推 `bindings_updated`。
10. Linux 验收（发布涉及 Linux 时）：Ubuntu 22.04 / 24.04 x64 与 arm64 各起一次服，确认就绪汇总里的 node 版本与平台键。
11. 更新 [status.md](../status.md)、[decisions.md](../decisions.md) 与 `CHANGELOG.md`。
12. 两个仓库同版打 tag `v<version>` → `release.yml` 自动产物；Endstone zip 手工挂上。

## 排障

| 现象 | 排查 |
| --- | --- |
| `pnpm check` 版本门禁红 | 六点/两份版本不一致；见上表 |
| `check-runtime-versions` 红 | 内嵌 Node 版本七点不一致；按报错逐条对齐（`.nvmrc` / `mise.toml` / `engines` / `@types/node` 主版本 / CI 的 `node-version-file`） |
| `release:pack` 报 JAR 缺失/版本不符 | 构建产物版本与 `package.json` 不一致；按当前版本重跑 `pnpm build:jar` |
| 构建期 Node 下载失败 | 设置 `KUROBRIDGE_NODE_DIST_BASE` 镜像；发布环境加 `KUROBRIDGE_NODE_DIST_STRICT=1` 暴露问题 |
| `KUROBRIDGE_EMBED_TARGETS` 报未知目标 | 只接受 `win-x64` / `win-arm64` / `linux-x64` / `linux-arm64`；拼写错误不静默忽略 |
| `smoke:handshake` 报 manifest 缺本平台 | 矩阵 runner 与 `runtime-manifest.json` 的 `targets` 不同步，或上一次用了 Lean 目标 |
| Linux 上 `node: cannot execute` / `GLIBC_2.xx not found` | 发行版 glibc < 2.28，或无 `libstdc++`；换发行版或 `KUROBRIDGE_NODE` 指向自备 node |
| `WS 服务端启动失败` | 端口被占；换 `ws.port` 或释放端口，看护器会退避重试后放弃 |
| 看护器 SEVERE 放弃 | 修根因后重启服务器 / 重载插件；LSE 用 `kurobridgeretry` |
| JAR 解压失败 | 检查 JAR 内 `embedded/manifest.json` 与资源；失败会降级为无 IPC，不崩服 |
| `/kurobridge send` 报通道不可用 | 看 `[NodeIpc]` 日志；Node 是否 ready、是否已放弃 |
| fabric gradle 解析失败 | loom 只在 Fabric maven，`settings.gradle.kts` 已加 `pluginManagement` |
| gradle 输出卡住 | 不要把 gradlew 输出接管道；重定向到文件再读 |
