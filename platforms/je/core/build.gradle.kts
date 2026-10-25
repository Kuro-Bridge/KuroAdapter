// :core —— 薄壳核心逻辑（IPC 客户端 / Node 子进程管理 / JSON-lines 解析）
// 平台无关：零 Bukkit API，可独立测试（类似 TS 侧 bridge/core）
// 依赖：Jackson（JSON-lines IPC 解析）

// Java 8 字节码基线（ADR-038 universal 兼容：1.12.2/1.16.5 服普遍跑 Java 8 JVM）。
// 只约束 main 源集——测试源集保持工具链默认（JDK 25），测试代码可继续用现代语法。
// --release 8 同时是兼容性机器门禁：任何 Java 9+ SE API 误用在此直接编译失败。
// -Xlint:-options：压制 JDK 25 对 source/target 8 的「已过时」提示（预期内，非代码问题）。
tasks.named<JavaCompile>("compileJava") {
    options.release = 8
    options.compilerArgs.add("-Xlint:-options")
}

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
