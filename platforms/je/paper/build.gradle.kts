// :paper —— Paper 服务端适配（薄壳的业务桥接层）
// 依赖 :core（纯逻辑）+ Paper API（compileOnly）
// 产物：shadowJar fat JAR（内含 :core + embedded 资源）

plugins {
    id("com.gradleup.shadow")
}

dependencies {
    implementation(project(":core"))
    compileOnly("io.papermc.paper:paper-api:1.21.4-R0.1-SNAPSHOT")
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
