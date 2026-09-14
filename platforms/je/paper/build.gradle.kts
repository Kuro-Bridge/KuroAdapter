// :paper —— Paper 服务端适配（薄壳的业务桥接层）
// 依赖 :core（纯逻辑）+ Paper API（compileOnly）
// 产物：shadowJar fat JAR（内含 :core + embedded 资源）

plugins {
    id("com.gradleup.shadow")
}

dependencies {
    implementation(project(":core"))
    compileOnly("io.papermc.paper:paper-api:1.21.4-R0.1-SNAPSHOT")
    // vanilla 命令输出捕获（NodeRequestHandler 回退路径）：仅编译期需要，运行期由
    // Paper 服务端自带 log4j-core 提供（v0.3.0，DEBT-1，见 DEBT1-NOTES D1-04）
    compileOnly("org.apache.logging.log4j:log4j-core:2.25.1")
    // QR 状态文件解析（KurobotCommand qr 子命令，MVP-4）：:core 的 Jackson 是 implementation
    // 不传递，本模块显式声明同版本（shadow 合并 runtimeClasspath，fat JAR 不重复）
    implementation("com.fasterxml.jackson.core:jackson-databind:2.18.0")
}

// 苛刻度：Spotless(Palantir)（ADR-011）
spotless {
    java {
        palantirJavaFormat("2.71.0") // JDK 25 兼容：>=2.71.0 才能用新版 javac 内部 API（spotless#2625）
        target("src/**/*.java")
    }
}

// 全链路构建（AGENTS.md 构建顺序）：TS 构建 → 嵌入式打包（待重建）→ shadowJar
tasks.shadowJar {
    archiveFileName.set("kurobot-${project.version}.jar")
    archiveClassifier.set("")
    manifest {
        attributes("Implementation-Title" to "KuroBot", "Implementation-Version" to project.version)
    }
}

// 本地全链路构建（与根 pnpm build:jar 对应）
tasks.register("kurobotBuild") {
    dependsOn(tasks.shadowJar)
}
