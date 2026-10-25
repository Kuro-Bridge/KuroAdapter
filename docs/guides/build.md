# 构建与发布

## 构建链

```
pnpm -r build                     # bridge/core (tsdown) + bridge/embedded (esbuild) + lse 双产物
  ↓
toolings/packaging/embed.ts       # node.exe + index.mjs + napuketto 嵌包 → paper/fabric resources
  ↓
gradlew :paper:shadowJar          # kurobridge-0.1.0.jar
  ↓
gradlew :fabric:remapJar          # kurobridge-fabric-0.1.0.jar
```

根命令 `pnpm build:jar` 依次执行以上四步（`toolings/packaging/build-jar.ts`）。顺序是硬约束：先有 TS 产物，才能嵌包，才能打 JAR。

## 产物

| 命令 | 产物 |
| --- | --- |
| `pnpm -r build` | `bridge/core/dist/`、`bridge/embedded/dist/index.mjs`、`platforms/be/lse/dist/{index.js,bin/index.mjs}` |
| `pnpm build:jar` | `platforms/je/paper/build/libs/kurobridge-0.1.0.jar`、`platforms/je/fabric/build/libs/kurobridge-fabric-0.1.0.jar` |
| `pnpm build:je` | 同上（gradle 全量 build，不重跑 embed；**新克隆须先跑过 `pnpm build:jar` 或 embed 步骤，否则 JAR 不含内嵌运行时**） |
| `pnpm build:endstone` | `platforms/be/endstone/build/core/`（portable 库 + 5 测试） |
| `cmake --preset windows-clang-cl` | `platforms/be/endstone/build/windows-clang-cl/endstone_kurobridge.dll` |

Endstone 的 dll 目前**不在**自动打包链里：`bin/` 四件由真机 SOP 手动预置（R3）。

## 嵌入式打包（embed.ts）

输入与输出：

- 输入：`bridge/embedded/dist/index.mjs`、Node 官方 win-x64 dist、`@napuketto/cli`（版本精确 pin 在 `bridge/embedded/package.json`）。
- 输出目录（`defaultEmbedTargets` 单一来源）：`platforms/je/{paper,fabric}/src/main/resources/embedded/`。
- 文件：`node.exe`、`index.mjs`、`NODE_LICENSE`、`manifest.json`、`napuketto.zip`、`NAPUKETTO_LICENSES`。

行为：

- Node 分发版本钉 **26.7.0**（与 `mise.toml` 的 26 线一致，补丁版本由嵌包固定）；下载后对官方 `SHASUMS256.txt` 做 sha256 校验；缓存缺省 `.cache/node-dist/`。
- napuketto 依赖树用 npm 安装到缓存（真实文件，非 symlink），打成单一 `napuketto.zip`；许可聚合为 `NAPUKETTO_LICENSES`。
- 幂等：产物已存在且 sha256 一致则跳过；写盘走临时文件 + rename。
- **红线断言**：写 zip 前扫描三类腾讯闭源件（`wrapper.node`、`QQNT*.dll/exe/so/dylib`、`QQ*.exe/apk/dmg/msi`），命中直接失败。

环境覆盖：

| 变量 | 作用 |
| --- | --- |
| `KUROBRIDGE_NODE_DIST_BASE` | Node 分发镜像（默认 `https://nodejs.org/dist`） |
| `KUROBRIDGE_NODE_CACHE_DIR` | 下载/嵌包缓存目录 |
| `KUROBRIDGE_NPM_REGISTRY` | napuketto 安装镜像 |
| `KUROBRIDGE_NODE_DIST_STRICT=1` | SHASUMS 在线拉取失败即失败，不回退缓存（发布用） |

> 换镜像不改变校验逻辑：仍对官方 SHASUMS 的 sha256 校验。

## JAR 布局

`kurobridge-0.1.0.jar` 包含：

- `:core` 与 Jackson（shadow 合并）；
- `embedded/` 资源（node.exe / index.mjs / NODE_LICENSE / manifest.json / napuketto.zip / NAPUKETTO_LICENSES）；
- `plugin.yml`（经典清单，1.12.2 ~ 26.3 全版本可加载；`paper-plugin.yml` 为 1.19.4+ 专属格式，ADR-038 弃用）。

首次启动把 embedded 解压到 `plugins/kurobridge/bin/`（逐文件 sha256 幂等），napuketto zip 解压到 `bin/napuketto/`（哨兵文件记 zip sha256）。

Fabric 产物是 loom 重映射后的 mod jar；`:core` 与 Jackson 由 shadow 白名单合并，fabric-api/loader 不吞入。

## CI

`.github/workflows/ci.yml` 三个 job（push `main` / PR）：

| job | runner | 命令 |
| --- | --- | --- |
| `ts` | ubuntu-latest | `pnpm install --frozen-lockfile` → `pnpm check && pnpm test` |
| `java` | ubuntu-latest | mise 提供 JDK 25 → `sh ./gradlew build` |
| `endstone` | windows-latest | `cmake --preset core && cmake --build --preset core && ctest --preset core` |

ts job 与本地 pre-commit 同构；`pnpm check` 自含 `pnpm -r build` 首环。endstone job 只跑 portable 层，dll 轨道仍是手动 SOP。

## 发布检查清单

1. 改版本：六点同改（见 [开发指南](development.md#版本对齐)），协议升级时同步 `KurobridgeVersions.java`。
2. `pnpm install --frozen-lockfile` 绿。
3. `pnpm check && pnpm test` 绿。
4. `pnpm build:all` 绿（JE + Endstone）。
5. 设置 `KUROBRIDGE_NODE_DIST_STRICT=1` 后跑 `pnpm build:jar`，确认 JAR 内无腾讯闭源件、`manifest.json` 的 sha256 与文件一致。
6. 冒烟：Paper 沙盒起服 → ready 汇总行 → `/kurobridge send` → 协议端收到；`/kurobridge reload` 推 `bindings_updated`。
7. 更新 [status.md](../status.md) 与 [decisions.md](../decisions.md)（如有新决策）。

## 排障

| 现象 | 排查 |
| --- | --- |
| `pnpm check` 版本门禁红 | 六点/两份版本不一致；见上表 |
| 构建期 Node 下载失败 | 设置 `KUROBRIDGE_NODE_DIST_BASE` 镜像；发布环境加 `KUROBRIDGE_NODE_DIST_STRICT=1` 暴露问题 |
| `WS 服务端启动失败` | 端口被占；换 `ws.port` 或释放端口，看护器会退避重试后放弃 |
| 看护器 SEVERE 放弃 | 修根因后重启服务器 / 重载插件；LSE 用 `kurobridgeretry` |
| JAR 解压失败 | 检查 JAR 内 `embedded/manifest.json` 与资源；失败会降级为无 IPC，不崩服 |
| `/kurobridge send` 报通道不可用 | 看 `[NodeIpc]` 日志；Node 是否 ready、是否已放弃 |
| fabric gradle 解析失败 | loom 只在 Fabric maven，`settings.gradle.kts` 已加 `pluginManagement` |
| gradle 输出卡住 | 不要把 gradlew 输出接管道；重定向到文件再读 |
