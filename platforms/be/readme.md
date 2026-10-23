# platforms/be —— BE 服务端家族（基岩版）

> BE 服务端生态：LeviLamina（LSE 脚本）+ Endstone（C++ 薄壳）。本册为家族入口；
> 现状与缺口以 [docs/status.md](../../docs/status.md) 为准。

## 子目录

| 目录 | 服务端 | 技术栈 | 状态 |
| --- | --- | --- | --- |
| `lse/` | LeviLamina（LSE） | QuickJS 壳（TS→JS）+ Node shim 宿主业务核心 | ✅ 已实现；真机联调待做（R2′「WS 回环薄壳」，ADR-037） |
| `endstone/` | Endstone | **C++ 薄壳** + 内嵌 Node | 🟡 portable 层 ctest 全绿；clang-cl dll 已构建；真机联调待做（[feasibility](endstone/docs/feasibility.md)） |

## 设计原则

- **LSE**：业务核心复用 `bridge/core`（平台无关，ADR-007），但**不是「TS 直接跑在 QuickJS」**——
  ADR-037 裁决 R2′：QuickJS 壳只做事件桥接与回环 WS 客户端（`mc.listen` 四事件 → JSON 帧 →
  127.0.0.1 游戏通道），壳经 `newProcess` 拉起本包 Node shim 宿主 `KurobridgeServer`/`Relay`，
  对 koishi 提供真 WS 服务端。角色拓扑见
  [lse/docs/role-adjudication.md](lse/docs/role-adjudication.md)；部署 SOP 见 [lse/readme.md](lse/readme.md)。
- **Endstone**：C++ 薄壳（事件桥接 + 内嵌 Node 子进程 + JSON-lines IPC），与 Java 薄壳**同构**
  （ADR-020，本仓走 C++、不写 Python），业务仍走 `bridge/core`。双层交付：portable 层
  （`src/core/`，零 endstone 依赖）可独立构建测试；endstone 面经 clang-cl 构建出 dll，
  真机行为待实机背书。包级状态与真机 SOP 见 [endstone/readme.md](endstone/readme.md)。

## 排期

- lse / endstone 真机联调均未做，清单分别在 [lse/readme.md](lse/readme.md) 与
  [endstone/readme.md](endstone/readme.md) + [feasibility §6](endstone/docs/feasibility.md)。
- 两平台的已知限制（无 status、无权限门、命令面缺失等）见
  [docs/modules/be-lse.md](../../docs/modules/be-lse.md) 与
  [docs/modules/be-endstone.md](../../docs/modules/be-endstone.md)。
