// KuroBridge 根构建配置：所有模块共享的公共配置（版本/插件/苛刻度）

plugins {
    java
    id("com.diffplug.spotless") version "7.0.2" apply false
    id("com.gradleup.shadow") version "9.0.0" apply false
}

group = "com.kurobridge"
version = "0.1.0"

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
    version = "0.1.0"

    java {
        toolchain {
            languageVersion = JavaLanguageVersion.of(25)
        }
    }

    tasks.withType<JavaCompile>().configureEach {
        options.release = 21 // ADR-015：字节码 target 21，兼容 Paper 运行时
        options.compilerArgs.addAll(listOf("-Xlint:all", "-Werror")) // 苛刻度（ADR-011）
    }

    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
    }
}
