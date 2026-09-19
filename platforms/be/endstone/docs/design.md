# platforms/be/endstone —— Endstone 适配设计（C++ 薄壳，实况）

> 本文件是包级设计文档（AGENTS.md：写代码前先更新对应包的 `docs/design.md`）。
> 落地裁决与取证：`docs/feasibility.md`（工作块 0 裁决册，先行于一切代码）；本文记录落地实况。

## 职责

KuroBridge 的 Endstone 服务端适配：C++ 薄壳，把 BDS 事件桥接给内嵌 Node 子进程（`bridge/core`）。
C++ 侧零业务：事件→出帧、Node 请求→游戏操作（回主线程）、Node 子进程拉起/看护/IPC 通道。

## 硬性约束

- **C++ 薄壳不做业务**（ADR-020）：事件/命令/IPC/进程管理，与 Java 薄壳同构；转发规则、
  权限语义等决策全部在 Node 侧 `bridge/core`。
- 不写 Python（技术栈不匹配）。
- IPC 走 stdin/stdout JSON-lines（ADR-010），Java/Node/C++ 统一。
- 业务核心只在 `bridge/core`（TS），经内嵌 Node 子进程运行（ADR-007 平台无关）。

## 组件图（双层结构）

```
BDS + Endstone（插件 API v0.11，加载器强校验 API 版本相等）
    ↓ 游戏事件（chat 可能非主线程；join/quit/death 主线程）
endstone 面（src/ 根，依赖 endstone 头，待 clang-cl 出 dll）
    │  main.cpp      入口与生命周期：ENDSTONE_PLUGIN、onEnable 组装/start（降级不崩服）、
    │                onDisable 优雅关停；日志中继接线
    │  events.cpp    四事件→出帧：game_chat / player_join / player_quit / player_death
    │                + join/quit 后 status 快照
    │  bridge.cpp    Node→游戏请求处理：broadcast / execute_command（runTask 回主线程）
    │                + Message 取文本、日志行级别分流（共享工具）
    ↓ NodeIpcListener 回调缝 / NodeIpc::sendEvent 出帧
portable 层（src/core/，零 endstone 依赖、纯 std C++20，本机可构建测试）
    json（R4 最小 JSON）· ipc_frame（协议 0.4.0 zod 硬编码副本）· process_factory（Win32 拉起，
    R6 句柄精确继承）· node_ipc（JSON-lines 通道 + ready/请求-响应 + PID 文件 + 双关机路径）·
    node_supervisor（看护状态机：退避/600s 窗累计 3 次放弃/autoRestart）· node_runtime（路径
    解析 + 通道工厂 + 看护器组装）
    ←→ JSON-lines（stdin/stdout） ←→ 内嵌 Node 子进程（bridge/core，TS）
```

portable 层可独立测试（`cmake --preset core` + ctest，5 目标）；endstone 面源码就绪，dll
待 clang-cl 工具链解锁（`cmake --preset windows-clang-cl`，操作单 feasibility.md §4）。

## 与架构的关系

- 与 `platforms/je` 的 Java 薄壳完全同构，仅宿主 API 不同（Endstone API vs Paper API）：
  事件注册、runTask 调度回主线程、收集型命令 sender、看护器参数、日志前缀契约逐条对位。
- 语义对照物：`KuroBridgePlugin.java` / `ChatListener` / `ConnectionListener` / `DeathListener` /
  `NodeRequestHandler`（回执时序的裁决基准）。
- `bridge/core` 平台无关在此复用：C++ 薄壳 + 内嵌 Node 即可带全部业务上 BE。

## 实现顺序（原规划四步，落地状态）

1. **构建骨架**：官方 CMake 模板路线核实为 FetchContent + `endstone_add_plugin`（非 vcpkg/
   find_package，旧文假设已纠正）——完成，见 feasibility.md §2 与本包 CMakeLists dll 分支。
2. **事件桥接（chat/join/quit/death）**：完成（本次），对 v0.11.11 头文件语法验证通过（R1）。
3. **IPC 客户端 + Node 子进程管理**：完成（portable 层，ctest 5/5 绿）。
4. **复用 `bridge/core`（内嵌 Node 运行）**：组装面完成（node_runtime 看护拉起）；真机联调
   待 dll 解锁，步骤见 readme.md 真机 SOP。

## 语法验证记录（2026-09-19）

本机无 clang-cl（MSVC ABI），endstone 面的验证方式 = **对 endstone v0.11.11 官方头文件做
语法编译验证**（裁决册 R1 登记）。

- 头来源：endstone v0.11.11 浅克隆（系统临时目录，不入仓）+ expected-lite **v0.8.0** 单头
  （endstone `include/CMakeLists.txt` FetchContent 钉的 tag）+ `endstone/version.h` 按
  `version.h.in` 手填生成（configure_file 产物，0.11.11 → `ENDSTONE_API_VERSION "0.11"`）。
- 命令（llvm-mingw clang 22.1.8，target x86_64-w64-windows-gnu，仅作语法前端）：

  ```
  clang++ -std=c++20 -fsyntax-only -D NOMINMAX -D WIN32_LEAN_AND_MEAN \
      -I src -I src/core \
      -I <tmp>/endstone-headers/include -I <tmp>/endstone-headers/generated \
      -I <tmp>/expected-lite/include \
      src/main.cpp src/bridge.cpp src/events.cpp
  ```

- 结果：**零 error / 零 warning，退出码 0**（输出为空）。`-D NOMINMAX -D WIN32_LEAN_AND_MEAN`
  为 endstone 官方 Windows 构建同款宏口径，非 MinGW 噪音规避；本次验证未引入其他可移植性
  规避宏。
- **语法验证过 ≠ ABI 有效构建（正式构建必须 clang-cl，见 preset windows-clang-cl）。**
  MinGW ABI 产物入不了 endstone 进程，dll 链接只在 MSVC ABI 工具链上有效。

## 与 core API 对接的缝隙（实现期发现登记）

- **`ManagedIpc` 不含 `sendEvent`**：看护缝（`NodeSupervisor::currentIpc()`）暴露的接口只有
  start/shutdown，事件发送是 `NodeIpc` 具体能力。endstone 面以 `dynamic_cast` 收窄（工厂只造
  `NodeIpc` 实例，转换恒安全；失败即无 IPC 静默跳过，对齐 Java `ipc==null`）。
- **实例替换窗口**：看护器重启时 `current_` 整体替换（unique_ptr 赋值回收旧实例），在途发送
  与旧实例析构存在理论并发。薄壳每帧现取现用把窗口压到单次调用内；残余风险属 core 一次性
  实例设计的已知取舍，真机线观察。
- **`NodeRuntime::start` v1 同步阻塞**：首次拉起阻塞至 ready/失败（上限 30s），发生在 onEnable
  主线程——core 头注既定取舍（对齐 Java start future 的同步化收敛），薄壳如实承受。
- **`dispatchCommand` 返回 `bool`**：Java 侧 void + CommandException；C++ 侧 false（未知命令等）
  → 显式 `{ok:false}` 回执，语义对齐 Java 的异常路径。
- **Translatable 取文本路径**：`Message = variant<string, Translatable>`，非 string 分支经
  `Server::getLanguage().translate(Translatable)`（官方翻译序列化）。
- **TPS API 取证更新**：v0.11.11 `server.h` 已出现 `getCurrentTicksPerSecond` /
  `getAverageTicksPerSecond`（feasibility.md §2 取证时未及）。v1 仍按 R2 上报 0.0（口径未经
  真机证实），接管 R2 时优先核实这两个 API。

## 简化登记（正文见 feasibility.md §5，此处仅索引）

| # | 一句话 |
|---|---|
| R1 | dll 构建/CI 不接，endstone 面仅头文件语法验证 |
| R2 | status 帧 tps 固定 0.0（诚实降级），onlinePlayers/uptimeSeconds 真值 |
| R3 | dll 不内嵌 node.exe，bin/ 预置靠真机 SOP 手动清单；缺失 → 降级不崩服 |
| R4 | JSON 解析为按协议面定制的最小实现，不做通用库 |
| R5 | 自定义命令面（Java /kurobridge 等价物）不做 |
| R6 | 进程管道继承用 PROC_THREAD_ATTRIBUTE_HANDLE_LIST 精确限定三个管端 |

## v1 已知缺口

- **chat relay 权限门缺失**：Java 的 `kurobridge.relay` 检查（negate 即静音）是 paper 特有
  声明；fabric 线已登记缺失，C++ v1 同样不做——chat 原文直出，过滤归 Node 侧。
- **TPS=0.0**（R2，上文有取证更新）。
- **命令面缺失**（R5）：无自定义命令；codec 已预留 `config_reload` 等出帧能力。
