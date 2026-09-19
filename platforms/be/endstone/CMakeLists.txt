# KuroBridge Endstone 适配包构建脚本（ADR-020：C++ 薄壳零业务）
#
# 分层（见 docs/feasibility.md §0）：
#   - portable 静态库 kurobridge_core（src/core/）：JSON-lines 帧编解码，零 endstone
#     依赖、纯 std C++20，本机任意工具链（llvm-mingw/MSVC/clang-cl）均可构建测试；
#   - endstone 插件 dll（KUROBRIDGE_BUILD_DLL=ON）：经 FetchContent 拉取 endstone v0.11
#     （跟踪 0.11 补丁线，加载器强校验 API 版本），源文件 main/events/bridge 已落地
#     （c196564/ee3efab，头文件语法验证零错误），dll 分支默认 OFF（preset core 显式 OFF）。
#
# 工具链硬约束（docs/feasibility.md §1/§4）：endstone v0.11.4 起要求 clang-cl
# （MSVC 前端）+ Ninja + CMake ≥ 3.29；构建类型仅 Release/RelWithDebInfo
# （endstone.hpp 对 MSVC Debug 有 _ITERATOR_DEBUG_LEVEL 静态断言）。

cmake_minimum_required(VERSION 3.29)
project(kurobridge CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# MSVC 前端（cl/clang-cl）下源码按 UTF-8 解释——源码注释与协议文本均含中文
add_compile_options($<$<CXX_COMPILER_FRONTEND_VARIANT:MSVC>:/utf-8>)

# ---- portable 层：零 endstone 依赖，禁止引入任何 endstone 头 / 网络 / 平台专属 API ----
add_library(kurobridge_core STATIC
    src/core/json.cpp
    src/core/ipc_frame.cpp
)
target_include_directories(kurobridge_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
# 与 endstone 官方 Windows 构建一致的宏口径（排除 min/max 宏与 Windows.h 杂项污染）
target_compile_definitions(kurobridge_core PUBLIC NOMINMAX WIN32_LEAN_AND_MEAN)

# ---- 测试：零外部依赖的极简断言（tests/test_util.h），每文件一个可执行 ----
enable_testing()
foreach(test_name IN ITEMS test_json test_ipc_frame)
    add_executable(${test_name} tests/${test_name}.cpp)
    target_link_libraries(${test_name} PRIVATE kurobridge_core)
    add_test(NAME ${test_name} COMMAND ${test_name})
endforeach()

# ---- endstone 插件 dll 分支（本机缺 clang-cl 时不进入，须优雅跳过）----
set(KUROBRIDGE_MSVC_ABI OFF)
if(MSVC OR (CMAKE_CXX_COMPILER_ID MATCHES "Clang" AND CMAKE_CXX_COMPILER_FRONTEND_VARIANT STREQUAL "MSVC"))
  set(KUROBRIDGE_MSVC_ABI ON)
endif()
option(KUROBRIDGE_BUILD_DLL "构建 endstone 插件 dll（需 clang-cl/MSVC ABI，见 docs/feasibility.md §4）" OFF)
if(KUROBRIDGE_BUILD_DLL AND NOT KUROBRIDGE_MSVC_ABI)
  message(FATAL_ERROR "KUROBRIDGE_BUILD_DLL 需要 clang-cl（MSVC 前端）或 MSVC；本机只构建 portable 层请用 --preset core（docs/feasibility.md §3-4）")
endif()
if(KUROBRIDGE_BUILD_DLL)
  include(FetchContent)
  FetchContent_Declare(endstone GIT_REPOSITORY https://github.com/EndstoneMC/endstone.git GIT_TAG v0.11)
  FetchContent_MakeAvailable(endstone)
  # dll 分支源文件（main/events/bridge）由后续块落地；ENDSTONE_API_VERSION 经
  # endstone_add_plugin 的目标属性对齐 v0.11（产物 endstone_kurobridge.dll，前缀官方默认）
  endstone_add_plugin(kurobridge src/main.cpp src/events.cpp src/bridge.cpp)
  target_link_libraries(kurobridge PRIVATE kurobridge_core)
  target_include_directories(kurobridge PRIVATE src)
endif()

# ---- 追加（portable 半边·块 C 2026-09-19）：Node 子进程拉起 / IPC 通道 / 看护器 / 运行时组装 ----
# 库源以 target_sources 并入 kurobridge_core（不动上方既有 add_library 结构）；Win32 细节
# 全部收敛在 .cpp（头文件面保持 portable），链接面仅依赖默认 kernel32。
target_sources(kurobridge_core PRIVATE
    src/core/process_factory.cpp
    src/core/node_ipc.cpp
    src/core/node_supervisor.cpp
    src/core/node_runtime.cpp
)

# 新测试目标：test_supervisor（看护器状态机，全同步假件）/ test_node_ipc（真实 node.exe
# 集成，PATH 无 node 则面内跳过）/ test_node_runtime（路径解析 + 全链冒烟）。
# 集成面含真实子进程操作，统一给 TIMEOUT 60（正常总时长 <20s）。
foreach(test_name IN ITEMS test_supervisor test_node_ipc test_node_runtime)
    add_executable(${test_name} tests/${test_name}.cpp)
    target_link_libraries(${test_name} PRIVATE kurobridge_core)
    target_compile_definitions(${test_name} PRIVATE
        KUROBRIDGE_TEST_FIXTURE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures")
    add_test(NAME ${test_name} COMMAND ${test_name})
    set_tests_properties(${test_name} PROPERTIES TIMEOUT 60)
endforeach()
