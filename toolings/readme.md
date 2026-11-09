# toolings/ —— 仓库工具链

> 构建编排、门禁脚本与沙盒运维入口（Node 脚本，零新增运行时依赖）。各脚本的完整语义以
> 脚本头注与 [`../AGENTS.md`](../AGENTS.md) 工作流节为准，此处只做盘点与入口索引。

## gates/（门禁，挂在根 `pnpm check` / `pnpm check:docs` / `pnpm check:versions` / `pnpm check:runtime` 链）

| 脚本 | 入口 | 作用 |
|---|---|---|
| `gates/check-docs-scope.ts` | `pnpm check:docs` | 旧 npm scope 口径门禁（ADR-030） |
| `gates/check-docs-links.ts` | `pnpm check:docs` | 全仓 `*.md` 相对链接死链门禁 |
| `gates/check-versions.ts` | `pnpm check:versions` | 版本对齐：bridge 六点 + 协议两份（锚 = 已安装 npm 包清单 version，ADR-034/035） |
| `gates/check-runtime-versions.ts` | `pnpm check:runtime` | 内嵌 Node 版本七点对齐（manifest / mise / .nvmrc / engines / @types 主版本 / 全部 setup-node 工作流 / embed.ts 不写字面量，ADR-044） |
| `gates/lib/repo-walk.ts` | ——（被两个 docs 门禁共用） | 遍历/跳过语义单一权威 |

## build/（平台侧构建统一入口，挂在根 `pnpm build:je` / `pnpm build:endstone` / `pnpm build:all`）

| 脚本 | 入口 | 作用 |
|---|---|---|
| `build/platforms.ts` | `pnpm build:je` / `build:endstone` / `build:all` | 平台两侧构建收敛为根级一条命令：`je`（gradlew build）｜`endstone`（cmake 配置+构建+ctest）｜`all`（两者）；与 CI java/endstone job 逐条等价 |

## lib/（编排脚本共用助手，被 build/ 与 packaging/ 引用）

| 脚本 | 入口 | 作用 |
|---|---|---|
| `lib/proc.ts` | ——（被两个编排脚本共用） | 跨壳子进程直通 / gradle wrapper 选择 / UTF-8 注入的单一权威 |
| `lib/runtime.ts` | `pnpm check:runtime` / `packaging/embed.ts` | 内嵌 Node 版本与目标清单读数（SSOT = `runtime-manifest.json`），含 `KUROBRIDGE_EMBED_TARGETS` 校验（ADR-045） |

## packaging/（嵌入式打包与发布收拢）

| 脚本 | 入口 | 作用 |
|---|---|---|
| `packaging/build-jar.ts` | `pnpm build:jar` | 全链路编排：`pnpm -r build` → embed.ts → `:paper:shadowJar` → `:fabric:remapJar` |
| `packaging/embed.ts` | `pnpm build:embed`（`build:jar` 第二步） | 三平台 node + bridge/embedded 产物 + napuketto 嵌包进各平台 resources（产物目录 SSOT = `defaultEmbedTargets`；清单 v2） |
| `packaging/tar.ts` | ——（被 embed.ts 引用） | 零依赖 tar.gz 单条目读取（ustar prefix / PAX / GNU LongName / 校验和），Linux 归档取件用 |
| `packaging/release.ts` | `pnpm release:pack` | 发布产物收拢 + 校验 + SHA256SUMS；`--only jar\|lse\|endstone` 分片 |
| `packaging/embed.test.ts` | `pnpm test` | 打包纯逻辑单测（下载器可注入，不发真网；含 tar 边界与目标覆盖） |

## smoke/（原生冒烟，CI `embed` 矩阵与本地同款）

| 脚本 | 入口 | 作用 |
|---|---|---|
| `smoke/node-handshake.ts` | `pnpm smoke:handshake` | 宿主平台二进制 `--version` → IPC ready → WS hello/query 往返 → 关 stdin 得 exit 0（ADR-046） |
| `smoke/node-handshake.test.ts` | `pnpm test` | 纯函数单测：平台键映射（Darwin 回归锁）/ 帧解析 / 日志尾部截取 |

## paper/（沙盒运维，运行产物全 gitignore）

- `paper.cmd` / `paper.ps1`：沙盒 Paper 单一入口，子命令 `start | stop | cmd | qr`
  （启停走 `.sh`，cmd / qr 走 `.ps1`；`.cmd` 只是绕过 PowerShell 执行策略的跳板）。
- `fake-player.ts`：离线模式假人（MC 1.21.4 最小协议客户端，零依赖；真机验收测试资产，
  原 sandbox/ 散件 2026-09-20 入库，用法见脚本头注）。
