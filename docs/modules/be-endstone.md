# platforms/be/endstone

Endstone（BE 服务端，C++ / Python 插件）适配。走 C++ 薄壳路线：C++ 只做事件桥接、Node 子进程与 IPC 管理，业务仍在 `bridge/core`。结构与 JE 的 Java 薄壳完全同构。

## 双层结构

```
endstone 面（src/main.cpp、events、bridge）
    依赖 endstone API（header-only，CMake FetchContent，v0.11 补丁线）
    ├── main.cpp    插件入口：ENDSTONE_PLUGIN / onEnable / onDisable
    ├── events.cpp  四事件 → game_chat / player_join / player_quit / player_death + status
    └── bridge.cpp  broadcast / execute_command → runTask 回主线程 + 回执
          │ NodeIpcListener 回调缝
portable 层（src/core/，零 endstone 依赖，纯 std C++20）
    ├── json          最小 JSON（保序对象、最长往返、深度上限）
    ├── ipc_frame     帧编解码（协议 0.4.0 的 C++ 硬编码副本）
    ├── process_factory  Win32 进程拉起（三管道 + 句柄白名单）
    ├── node_ipc      JSON-lines 通道 + ready/请求-响应 + PID + 双关机路径
    ├── node_supervisor  看护状态机（退避 / 600s 窗 3 次放弃 / autoRestart）
    └── node_runtime  路径解析 + 通道工厂 + 看护器组装
          │ stdin/stdout JSON-lines
          ▼
    Node 子进程（bridge/embedded 产物，宿主 bridge/core）
```

portable 层可独立构建与测试；endstone 面依赖真实 API/ABI。

## 构建

| 预设 | 命令 | 产物 | 前提 |
| --- | --- | --- | --- |
| `core` | `cmake --preset core && cmake --build --preset core && ctest --preset core` | portable 静态库 + 5 个测试 | 任意 C++20 工具链 + Ninja + CMake ≥ 3.29 |
| `windows-clang-cl` | `cmake --preset windows-clang-cl && cmake --build --preset windows-clang-cl` | `build/windows-clang-cl/endstone_kurobridge.dll` | VS Build Tools + C++ Clang 组件 + Ninja |

- endstone v0.11.4 起要求 clang-cl（MSVC ABI）；仅 MSVC Debug 会被 `endstone.hpp` 的静态断言拒绝，构建类型用 Release / RelWithDebInfo。
- clang-cl 工具链已解锁并完成首构建（本地产物约 809 KB，导出 `init_endstone_plugin`，ABI 下 ctest 5/5）；构建产物在 `build/`，不入库。**真机联调仍待排期**。
- 根 `pnpm build:endstone` 等价于 `core` 三连。

## 运行与部署

cwd 契约与 JE 相同：以 BDS 根为基准定位 `plugins/kurobridge/`。

```
plugins/kurobridge/
├── config.json    # 同 schema；Node 按 cwd 定位
├── node.pid
└── bin/           # 手动预置四件（当前 embed 链未接 endstone，R3）
    ├── node.exe
    ├── index.mjs
    ├── NODE_LICENSE
    └── manifest.json
```

- dll 放 `<BDS 根>/plugins/`；endstone 服务端版本必须与构建时的 API 版本一致（加载器强校验）。
- 开发覆盖：`KUROBRIDGE_NODE` / `KUROBRIDGE_BUNDLE` 与 Java 侧同语义。
- 启动核对：插件加载 → `[NodeIpc][INFO] Node 进程已拉起` → ready（含 wsPort）→ 四事件出帧 → 停服双路径收敛、`node.pid` 清理。

## 行为

- **事件**：`PlayerChatEvent` / `PlayerJoinEvent` / `PlayerQuitEvent` / `PlayerDeathEvent`（死亡消息 `nullopt` → 空串；`Translatable` 经 `Server.getLanguage().translate`）。join/quit 后补 status。
- **status**：`tps` 固定 `0.0`（R2 诚实降级）；`onlinePlayers` 真值；`uptimeSeconds` 自插件启用起算（`steady_clock`，与 Java 的 JVM uptime 语义略有差异）。
- **broadcast**：`runTask` 回主线程广播，调度后立即回执 `ok`。
- **execute_command**：`CommandSenderWrapper` 同时收集 stdout/stderr，执行完回执 `{ok, output}`；`dispatchCommand` 返回 false 或抛异常 → `{ok:false,error}`。
- **超时**：IPC 请求 10s；关停发 `shutdown` 帧 → 关 stdin → 5s 宽限 → 强杀 2s。

## 简化登记（v1）

| # | 内容 |
| --- | --- |
| R1 | dll 构建/CI 已可本机构建；CI 只跑 portable 层（`core` preset） |
| R2 | status `tps=0.0`（`server.h` 已有 TPS API，接管时再核实采样口径） |
| R3 | dll 不内嵌 node.exe；`bin/` 靠真机 SOP 手动预置（embed 链未接 endstone） |
| R4 | 最小 JSON 实现，不引通用库 |
| R5 | 无自定义命令面（无 `/kurobridge` 等价物） |
| R6 | Win32 管道用 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 精确限定继承 |

## 已知缺口

- 无 chat relay 权限门（与 fabric 同根因）。
- 无自定义命令（R5）；无法在游戏内 reload / qr。
- `bin/` 未接入自动打包；升级需手动替换。
- 真机联调未做：事件线程语义、ABI 构建后的命令回执、停服时序仍需实机背书。

测试：ctest 5 目标（json / ipc_frame / supervisor / node_ipc / node_runtime），含真实 node.exe 集成（PATH 无 node 时该测试面自跳过）。
