// :fabric —— Fabric 服务端适配（预留骨架，尚未实现）
// 依赖 :core（纯逻辑）+ Fabric Loader API（compileOnly）
// 说明：Fabric 是 mod 加载器（非 Bukkit 系），插件形态为 mod；
//       实现时按 Fabric 的 entrypoint 机制接入，业务仍走 :core。

plugins {
    id("com.gradleup.shadow")
}

dependencies {
    implementation(project(":core"))
    // TODO(fabric)：接入 Fabric Loader API（fabric-loader）后启用
    // compileOnly("net.fabricmc:fabric-loader:0.16.0")
}

// 苛刻度：Spotless(Palantir)（ADR-011）
spotless {
    java {
        palantirJavaFormat("2.71.0") // JDK 25 兼容：>=2.71.0 才能用新版 javac 内部 API（spotless#2625）
        target("src/**/*.java")
    }
}
