# platforms/be/endstone —— Endstone 适配设计（C++ 薄壳）

> 本文件是包级设计文档（AGENTS.md：写代码前先更新对应包的 `docs/design.md`，设计先行）。

## 职责

KuroBridge 的 Endstone 服务端适配：C++ 薄壳，把 BDS 事件桥接给内嵌 Node 子进程（`bridge/core`）。

## 硬性约束

- **C++ 薄壳不做业务**（ADR-020）：事件/命令/IPC/进程管理，与 Java 薄壳同构。
- 业务核心只在 `bridge/core`（TS），经内嵌 Node 子进程运行。
- 不写 Python（技术栈不匹配）。
- IPC 走 stdin/stdout JSON-lines（ADR-010），Java/Node/C++ 统一。

## 与架构的关系

```
BDS + Endstone
    ↓ 事件
C++ 薄壳（本包）  ←→  JSON-lines IPC  ←→  内嵌 Node 子进程（bridge/core，TS）
    ↑ 命令/广播
```

- 与 `platforms/je` 的 Java 薄壳完全同构，仅事件 API 不同（Endstone API vs Paper API）。
- `bridge/core` 平台无关（ADR-007）在此体现：C++ 薄壳 + Node 即可复用全部业务。

## 实现顺序（另行评估）

1. Endstone 官方 CMake 模板骨架。
2. 事件桥接（chat / join / leave / death）。
3. IPC 客户端 + Node 子进程管理。
4. 复用 `bridge/core`（内嵌 Node 运行）。

## 依赖

- Endstone C++ API。
- 内嵌 Node 运行时（MIT，随插件分发，wrapper.node 类闭源件运行期发现拷贝）。
