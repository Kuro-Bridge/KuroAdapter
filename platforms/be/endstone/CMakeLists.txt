# Endstone 插件 CMake 骨架（预留，尚未实现）
#
# 参考 Endstone 官方插件模板：https://github.com/EndstoneMC/endstone-plugin-template
# 当前仅骨架占位，接入 Endstone API 后启用。
#
# 依赖方向（ADR-020）：
#   C++ 薄壳（事件桥接 + IPC + 进程管理）→ 内嵌 Node（bridge/core）
#   薄壳不做业务逻辑。

cmake_minimum_required(VERSION 3.20)
project(kurobridge-endstone CXX)

# TODO(endstone)：接入 Endstone C++ API 后启用
# find_package(Endstone REQUIRED)

add_library(kurobridge MODULE
    src/main.cpp
    src/bridge.cpp
    src/ipc.cpp
    src/process.cpp
)

target_compile_features(kurobridge PRIVATE cxx_std_20)

# TODO(endstone)：链接 Endstone + 内嵌 Node 后启用
# target_link_libraries(kurobridge PRIVATE Endstone::endstone)
# set_target_properties(kurobridge PROPERTIES PREFIX "" SUFFIX ".dll")
