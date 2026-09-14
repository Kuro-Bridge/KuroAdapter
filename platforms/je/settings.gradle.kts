// KuroBridge Java 多模块项目（root）
// 一个服务端平台 = 一个模块，共享 :core（纯逻辑，零服务端 API）
// 已实现：core（纯逻辑）+ paper（Paper 适配）
// 预留：fabric（Fabric mod）/ neoforge（NeoForge mod）/ velocity（Velocity 代理）
rootProject.name = "kurobridge"

include("core", "paper", "fabric", "neoforge", "velocity")
