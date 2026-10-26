// KuroBridge 根构建配置：所有模块共享的公共配置（版本/插件/苛刻度）

plugins {
    java
    id("com.diffplug.spotless") version "7.0.2" apply false
    id("com.gradleup.shadow") version "9.0.0" apply false
}

group = "com.kurobridge"
version = "1.0.0"

allprojects {
    repositories {
        // Paper API（compileOnly）等
        maven("https://repo.papermc.io/repository/maven-public/")
        mavenCentral()
    }
}

// 所有模块统一的 Java 工具链与编译苛刻度（ADR-011/ADR-015）
subprojects {
    apply(plugin = "java")
    apply(plugin = "com.diffplug.spotless")

    group = "com.kurobridge"
    version = "1.0.0"

    java {
        toolchain {
            languageVersion = JavaLanguageVersion.of(25)
        }
    }

    tasks.withType<JavaCompile>().configureEach {
        // 缺省 release 21（ADR-015）：fabric（MC 1.21.4 运行时要 Java 21）等现代模块用；
        // :core/:paper/:paper-legacy 在各自 build.gradle.kts 覆盖为 release 8（ADR-038 universal：
        // 1.12.2 ~ 26.3 单 jar，--release 同时是 Java 9+ SE API 误用的机器门禁）
        options.release = 21
        options.compilerArgs.addAll(listOf("-Xlint:all", "-Werror")) // 苛刻度（ADR-011）
    }

    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
    }
}
