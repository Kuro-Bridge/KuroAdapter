// :core —— 薄壳核心逻辑（IPC 客户端 / Node 子进程管理 / JSON-lines 解析）
// 平台无关：零 Bukkit API，可独立测试（类似 TS 侧 bridge/core）
// 依赖：Jackson（JSON-lines IPC 解析）

dependencies {
    implementation(libs.jackson.databind)

    testImplementation(platform(libs.junit.bom))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

// 苛刻度：Spotless(Palantir)（ADR-011）
spotless {
    java {
        palantirJavaFormat("2.71.0") // JDK 25 兼容：>=2.71.0 才能用新版 javac 内部 API（spotless#2625）
        target("src/**/*.java")
    }
}
