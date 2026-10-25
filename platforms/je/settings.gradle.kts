// KuroBridge Java 多模块项目（root）
// 一个服务端平台 = 一个模块，共享 :core（纯逻辑，零服务端 API）
// 已实现：core（纯逻辑）+ paper（Paper 适配）+ paper-legacy（旧 Adventure 序列化器隔离层，
// ADR-038 universal 兼容：对 1.21.4 时代 paper-api 编译，随 shadowJar 分发）+ fabric（Fabric mod）
// 预留：neoforge（NeoForge mod）/ velocity（Velocity 代理）
rootProject.name = "kurobridge"

// 插件解析仓库：fabric-loom 只发布在 Fabric maven（Gradle Plugin Portal 无此插件），
// 须显式接入；既有 spotless/shadow 仍走 gradlePluginPortal（兜底），顺序不影响两者
pluginManagement {
    repositories {
        maven("https://maven.fabricmc.net/") {
            name = "Fabric"
        }
        gradlePluginPortal()
        mavenCentral()
    }
}

include("core", "paper", "paper-legacy", "fabric", "neoforge", "velocity")
