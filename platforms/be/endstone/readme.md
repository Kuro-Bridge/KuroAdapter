# platforms/be/endstone —— Endstone 服务端适配（C++ 薄壳）

> Endstone：BE 服务端插件加载器，插件支持 **C++ / Python**。
> 我们走 **C++ 薄壳**路线（ADR-020）：C++ 只做事件桥接 + 内嵌 Node 子进程管理 + JSON-lines IPC，
> 业务核心仍在 `bridge/core`（TS），与 Java 薄壳完全同构。

## 当前状态（2026-09-19，双层交付，见 docs/feasibility.md §0）

- **portable 层（`src/core/`）**：实现 + 单测/集成测试全绿（本机 llvm-mingw + CMake + Ninja）。
- **endstone 面（`src/` 根）**：源码就绪，对 endstone v0.11.11 官方头文件语法验证通过
  （R1；语法验证过 ≠ ABI 有效构建）。dll 产物待 clang-cl 工具链解锁。

## 构建双轨

| 预设 | 产物 | 要求 |
|---|---|---|
| `cmake --preset core` → `cmake --build --preset core` → `ctest --preset core`（5 目标） | portable 层静态库 + 测试 | 本机现有工具链即可复验 |
| `cmake --preset windows-clang-cl` → `cmake --build --preset windows-clang-cl` | `build/windows-clang-cl/endstone_kurobridge.dll` | VS Build Tools + 「适用于 Windows 的 C++ Clang 编译器（MSVC ABI）」组件 + Ninja；解锁操作单指 **docs/feasibility.md §4** |

工具链硬约束：endstone v0.11.4 起要求 clang-cl（MSVC 前端）+ CMake ≥ 3.29；构建类型仅
Release/RelWithDebInfo（`endstone.hpp` 对 MSVC Debug 有静态断言）。

## 真机 SOP（dll 构建绿之后、联调）

1. **工具链解锁**：按 docs/feasibility.md §4 安装 VS Build Tools + Clang 组件，vcvars64 环境
   内 `cmake --preset windows-clang-cl && cmake --build --preset windows-clang-cl`，得到
   `build/windows-clang-cl/endstone_kurobridge.dll`。
2. **下载 endstone 服务端**：GitHub release 取 `endstone-0.11.11-windows-x86_64.zip` 并解压出
   BDS 根；**插件 API 版本必须与构建时一致**（endstone 加载器强校验，0.x 阶段 endstone
   升级 = 插件必须重编）。
3. **预置 `<BDS 根>/plugins/kurobridge/bin/`**（四件）：`node.exe`、`index.mjs`（bridge/embedded
   的 esbuild 产物）、`NODE_LICENSE`、`manifest.json`。清单契约与 paper 一致（见
   `platforms/je/docs/design.md`「toolings/packaging/embed 打包工具」节；产物来自
   `toolings/packaging` embed 链）。endstone target 接入 embed 链是 **R3 接管点**，当前手动拷。
   开发覆盖：设 `KUROBRIDGE_NODE` / `KUROBRIDGE_BUNDLE` 环境变量可指向任意 node + bundle
   （与 Java 侧同语义）。
4. **预置 `<BDS 根>/plugins/kurobridge/config.json`**：token 契约与 paper 一致（node 侧按
   cwd 定位；cwd = BDS 根，插件以进程工作目录为基准解析 bin/、node.pid 与 config 路径）。
5. **启动核对清单**：dll 放 `<BDS 根>/plugins/`，启动服务端，依次核对——
   - 插件加载日志（`[KuroBridge]` 前缀）；
   - `[NodeIpc][INFO] Node 进程已拉起` → `[NodeIpc][INFO] Node ready` →
     `[KuroBridge][node][info]` ready 行（含 wsPort）；
   - 四事件出帧：聊天/进服/退服/死亡触发对应 `game_chat` / `player_join` / `player_quit` /
     `player_death`（node 侧可观测）；
   - 停服关停语义：shutdown 帧 + stdin EOF 双路径收敛、node 退出码 0、
     `plugins/kurobridge/node.pid` 被清理。

## 目录结构

```
src/
├── main.cpp          # 插件入口与生命周期（ENDSTONE_PLUGIN / onEnable / onDisable）
├── bridge.h/.cpp     # Node→游戏 请求处理（broadcast / execute_command）+ 日志中继工具
├── events.h/.cpp     # 游戏事件→出帧（chat/join/quit/death + status 快照）
└── core/             # portable 层（零 endstone 依赖，可独立构建测试）
    ├── json.h/.cpp           # 最小 JSON（R4）
    ├── ipc_frame.h/.cpp      # 帧编解码（协议 0.4.0 zod 的 C++ 硬编码副本）
    ├── process_factory.h/.cpp# Win32 进程拉起（R6 句柄精确继承）
    ├── node_ipc.h/.cpp       # JSON-lines 通道 + ready/请求-响应 + PID 文件 + 双关机路径
    ├── node_supervisor.h/.cpp# 看护器状态机（退避/放弃/autoRestart）
    └── node_runtime.h/.cpp   # 路径解析 + 通道工厂 + 看护器组装
tests/                # 5 个测试目标（json/ipc_frame/supervisor/node_ipc/node_runtime）
```

## 依赖

- Endstone C++ API v0.11（构建期 CMake FetchContent；运行期 endstone 服务端，版本须一致）。
- expected-lite v0.8.0（endstone SDK 唯一头依赖，FetchContent 自拉）。
- 内嵌 Node 运行时（MIT，`toolings/packaging` 产物，bin/ 预置，非 dll 内嵌——R3）。
