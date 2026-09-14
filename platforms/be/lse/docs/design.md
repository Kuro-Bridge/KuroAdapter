# platforms/be 设计（LeviLamina LSE 平台适配）

> 本文件是包级设计文档（AGENTS.md：写代码前先更新对应包的 `docs/design.md`，设计先行）。

## 职责

KuroBridge 的 LeviLamina（BDS）平台适配：复用 `bridge/core`（平台无关），把 kurobridge 业务跑进 BDS 的 LSE 环境（QuickJS）。

## 硬性约束（ADR-012 / ADR-007）

- **LSE TS 化**：TS 源码 → 编译为 JS → LeviLamina 加载（LSE 内核是 QuickJS，不原生跑 TS）。
- **复用 `bridge/core`**：核心协议逻辑零改动，只做 QuickJS 环境的传输层/logger 适配。
- 编译产物 target ES2020、无 tslib/装饰器（`erasableSyntaxOnly` 保证）——QuickJS 可直接跑。
- 使用官方 TS 声明 `@levimc-lse/types` + 脚手架 `@levimc-lse/scaffold`。

## 目录规划

```
src/
├── index.ts       # 入口：ll.registerPlugin + mc.listen 注册（占位）
├── adapter/       # bridge/core 传输层/logger 的 LSE 适配（ws/logger）
└── bootstrap.ts   # 拉起 core 客户端（对端角色）
```

## 与 Nukkit 的关系（重要）

`platforms/be` **只含 LeviLamina（LSE 脚本）** 一条路线（ADR-012）。
**Nukkit / PowerNukkitX 是 Java 服务端**（服务 BE 客户端，但插件是 Java），
归 `platforms/je` 下的 `nukkit/` 模块（共享 `:core`），不在本目录。
PocketMine-MP（PHP）工具链不匹配，明确不做。

## 实现顺序（STATUS.md 第 6 步细化）

1. 用 `@levimc-lse/scaffold` 生成官方插件骨架，替换本占位。
2. bridge/core 传输层/logger 的 LSE 适配（QuickJS 环境）。
3. 复用 core 客户端接入 kurobridge WS 服务端。

## 依赖

- `@kurobridge/bridge-core`（workspace:*）——业务核心（平台无关）。
- `@kurobridge/protocol`（workspace:*）——消息 schema。
- `@levimc-lse/types`（devDep）——LSE 全局对象类型。
