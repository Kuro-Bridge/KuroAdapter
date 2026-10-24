# vendor/lse-types（Legacy Script Engine 类型声明副本）

LSE 全局对象（`mc` / `system` / `logger` / `network` / `file` 等）的 TypeScript ambient 声明，
原样内嵌自 npm 包 `@levimc-lse/types` **2.18.7**。

## 为什么内嵌

该包于 2026-10-23 前后从 npm registry 整包消失（scope 404，上游仓库
LiteLDev/legacy-script-engine-api 仍在、包名未改，判定为 registry 侧下架而非官方更名）。
frozen lockfile 安装因此必炸 CI。本副本自消失前的 node_modules 抢救而来，使类型检查脱离
registry 可用性。

## 约束

- 本目录为第三方原样副本：**不做手工修改**，biome 门禁已排除（`biome.jsonc` files.includes）。
- 许可证 LGPL-3.0-or-later，随附于本目录 `LICENSE`（仅构建期类型输入，不进入打包产物）。
- 刷新方式：上游恢复发布（或确认新包名）后，重新安装对应版本，整目录替换 `src/` 与
  `LICENSE`，并同步 `tsconfig.json` 的 include 入口与本 README 的版本号。
- 行号引用口径：本目录文件与 2.18.7 逐字节一致，`docs/role-adjudication.md` 等处对
  `src/SystemAPI/SystemCall.d.ts` 这类行号引用在本目录下依然成立。
