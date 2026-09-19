# toolings/ —— 仓库工具链

> 构建编排、门禁脚本与沙盒运维入口（Node 脚本，零新增运行时依赖）。各脚本的完整语义以
> 脚本头注与 [`../AGENTS.md`](../AGENTS.md) 工作流节为准，此处只做盘点与入口索引。

## gates/（门禁，挂在根 `pnpm check` / `pnpm check:docs` / `pnpm check:versions` 链）

| 脚本 | 入口 | 作用 |
|---|---|---|
| `gates/check-docs-scope.mjs` | `pnpm check:docs` | 旧 npm scope 口径门禁（ADR-030；docs/history/ 冻结归档豁免） |
| `gates/check-docs-links.mjs` | `pnpm check:docs` | 全仓 `*.md` 相对链接死链门禁（docs/history/ 不扫） |
| `gates/check-versions.mjs` | `pnpm check:versions` | 版本对齐：bridge 六点 + 协议两份（锚 = 已安装 npm 包清单 version，ADR-034/035） |
| `gates/lib/repo-walk.mjs` | ——（被两个 docs 门禁共用） | 遍历/跳过语义单一权威 |

## packaging/（嵌入式打包）

| 脚本 | 入口 | 作用 |
|---|---|---|
| `packaging/build-jar.mjs` | `pnpm build:jar` | 全链路编排：`pnpm -r build` → embed.ts → `:paper:shadowJar` → `:fabric:remapJar` |
| `packaging/embed.ts` | `pnpm build:jar` 第二步 | node.exe + bridge/embedded 产物 + napuketto 嵌包进各平台 resources（目标清单 SSOT = `defaultEmbedTargets`） |
| `packaging/embed.test.ts` | `pnpm test` | 打包纯逻辑单测（下载器可注入，不发真网） |

## paper/（沙盒运维，运行产物全 gitignore）

- `paper.cmd` / `paper.ps1`：沙盒 Paper 单一入口，子命令 `start | stop | cmd | qr`
  （启停走 `.sh`，cmd / qr 走 `.ps1`；`.cmd` 只是绕过 PowerShell 执行策略的跳板）。
