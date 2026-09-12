// :velocity —— Velocity 代理服务端适配（预留骨架，尚未实现）
// 依赖 :core（纯逻辑）+ Velocity API（compileOnly）
// 说明：Velocity 是代理服（非 Bukkit 系），插件形态为代理插件；
//       事件模型不同（玩家连接/后端切换），业务仍走 :core。

plugins {
    id("com.gradleup.shadow")
}

dependencies {
    implementation(project(":core"))
    // TODO(velocity)：接入 Velocity API（velocity-api）后启用
    // compileOnly("com.velocitypowered:velocity-api:3.3.0-SNAPSHOT")
    // annotationProcessor("com.velocitypowered:velocity-api:3.3.0-SNAPSHOT")
}

// 苛刻度：Spotless(Palantir)（ADR-011）
spotless {
    java {
        palantirJavaFormat("2.71.0") // JDK 25 兼容：>=2.71.0 才能用新版 javac 内部 API（spotless#2625）
        target("src/**/*.java")
    }
}
