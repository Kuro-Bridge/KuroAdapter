# platforms/be —— BE 服务端家族（基岩版）

> BE 服务端生态：LeviLamina（LSE 脚本）+ Endstone（C++ 薄壳）。本册为家族入口；
> 状态速览以 [docs/STATUS.md](../../docs/STATUS.md) 为准（本文 2026-09-19 平台落地波后重写）。

## 子目录

| 目录 | 服务端 | 技术栈 | 状态（2026-09-19） |
|---|---|---|---|
| `lse/` | LeviLamina（LSE） | QuickJS 壳（TS→JS）+ Node shim 宿主业务核心 | ✅ 已实现——R2′「WS 回环薄壳」（ADR-037），10 文件 93 用例全绿 |
| `endstone/` | Endstone | **C++ 薄壳** + 内嵌 Node | ✅ 行走骨架已落地——portable 层 ctest 5/5 绿；**dll 待 clang-cl 工具链解锁**（工具链尚未安装，解锁操作单 = [endstone/docs/feasibility.md](endstone/docs/feasibility.md) §4） |

## 设计原则

- **LSE**：业务核心复用 `bridge/core`（平台无关，ADR-007），但**不是「TS 直接跑在 QuickJS」**——
  ADR-037 裁决 R2′：QuickJS 壳只做事件桥接与回环 WS 客户端（`mc.listen` 四事件 → JSON 帧 →
  127.0.0.1 游戏通道），壳经 `newProcess` 拉起本包 Node shim 宿主 `KurobridgeServer`/`Relay`，
  对 koishi 提供真 WS 服务端。角色拓扑 SSOT =
  [lse/docs/role-adjudication.md](lse/docs/role-adjudication.md)；部署 SOP 见 [lse/readme.md](lse/readme.md)。
- **Endstone**：C++ 薄壳（事件桥接 + 内嵌 Node 子进程 + JSON-lines IPC），与 Java 薄壳**同构**
  （ADR-020，本仓走 C++、不写 Python），业务仍走 `bridge/core`。双层交付：portable 层
  （`src/core/`，零 endstone 依赖）本机可独立构建测试；endstone 面源码就绪 + 对 v0.11.11
  头文件语法验证通过（≠ ABI 有效构建）。包级状态与真机 SOP 见 [endstone/readme.md](endstone/readme.md)。

## 排期

- `lse/`、`endstone/` 已于 2026-09-19 平台落地波交付（同波 JE 侧 fabric mod 壳首版亦已落地，
  五事件对齐 paper，见 platforms/je/fabric/docs/design.md）。
- lse / endstone 真机联调均未做，清单分别在 lse/readme.md「待真机验证清单」与 endstone
  readme SOP + feasibility §6；endstone dll 构建与联调排在 clang-cl 工具链解锁之后（用户侧
  操作，操作单 feasibility §4——不安装也不影响已交付层，portable 层 ctest 恒可复验）。
