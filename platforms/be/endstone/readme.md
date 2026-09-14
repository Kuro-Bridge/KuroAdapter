# platforms/be/endstone —— Endstone 服务端适配（C++ 薄壳）

> Endstone：BE 服务端插件加载器，插件支持 **C++ / Python**。
> 我们走 **C++ 薄壳**路线（ADR-020）：C++ 只做事件桥接 + 内嵌 Node 子进程管理 + JSON-lines IPC，
> 业务核心仍在 `bridge/core`（TS），与 Java 薄壳完全同构。

## 为什么是 C++ 薄壳而非 Python

- Python 插件与技术栈（TS 核心）不匹配。
- C++ 薄壳 = 与 `platforms/je` 的 Java 薄壳同构：本地事件 → JSON-lines → Node 子进程（bridge/core）。
- 不写任何业务逻辑，只做桥接（几百行模板代码，与 Java 薄壳模式一致）。

## 构建（预留，尚未实现）

- 构建系统：**CMake**（Endstone 官方插件模板用 CMake）。
- 依赖：Endstone API（`endstone-core`）+ 内嵌 Node 运行时（`node.exe`，MIT，运行期发现拷贝）。
- 产物：`.dll`（Endstone 插件）+ 内嵌资源（bridge/embedded 产物 + node.exe）。

## 目录规划

```
src/
├── main.cpp          # 插件入口（Endstone Plugin 基类）
├── bridge.cpp/.h     # 事件桥接（聊天/进服/离服）→ IPC
├── ipc.cpp/.h        # JSON-lines IPC 客户端（stdin/stdout）
└── process.cpp/.h    # Node 子进程管理（生命周期/Watchdog）
```

## 实现顺序（另行评估启动时间）

1. 用 Endstone 官方 CMake 模板生成插件骨架，替换本占位。
2. 桥接层：Endstone 事件 → IPC 帧。
3. Node 子进程管理 + IPC 客户端。
4. 复用 `bridge/core`（内嵌 Node 运行）。

## 依赖

- Endstone C++ API（CMake FetchContent / 系统安装）。
- `@kurobridge/bridge-core` 产物（内嵌 Node 运行，非 C++ 直接调用）。
