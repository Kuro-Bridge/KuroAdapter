// :neoforge —— NeoForge 服务端适配（预留骨架，尚未实现）
// 依赖 :core（纯逻辑）+ NeoForge API（compileOnly，经 ModDevGradle 提供）
// 说明：NeoForge 是 mod 加载器（非 Bukkit 系），插件形态为 mod；
//       每个 MC 版本需要独立构建（版本矩阵，见 AGENTS.md 多版本策略）。
//       构建用官方 ModDevGradle 插件（net.neoforged.moddev）。

plugins {
    // TODO(neoforge)：接入官方 ModDevGradle 后启用
    // id("net.neoforged.moddev") version "2.0.0"
}

dependencies {
    implementation(project(":core"))
    // TODO(neoforge)：按版本基线引入 NeoForge API
    // NeoForge 依赖由 moddev 插件管理，compileOnly 经插件注入
}

// 苛刻度：Spotless(Palantir)（ADR-011）
spotless {
    java {
        palantirJavaFormat("2.71.0") // JDK 25 兼容：>=2.71.0 才能用新版 javac 内部 API（spotless#2625）
        target("src/**/*.java")
    }
}

// TODO(neoforge)：moddev 插件配置（版本基线 + 发布名）
// neoForge {
//     version = "21.1.x"          // 对应 MC 1.21.x
//     runs { ... }
//     mods { ... }
// }
