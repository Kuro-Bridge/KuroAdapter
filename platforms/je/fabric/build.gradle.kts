// :fabric —— Fabric 服务端适配（mod 形态薄壳）
// 依赖 :core（纯逻辑）+ fabric-loader / fabric-api（modImplementation，运行期由服务端提供）
// 产物：remapJar（kurobridge-fabric-<version>.jar，shadow 白名单合并 :core + Jackson 后经 loom 重映射）
// 设计：docs/design.md（版本基线 / 生命周期映射 / 事件映射 / 打包路线裁决）

import com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar

plugins {
    id("com.gradleup.shadow")
    // 版本内联（仅本模块使用；loom 只在 Fabric maven 发布，解析经 settings pluginManagement）
    id("fabric-loom") version "1.18.2"
}

repositories {
    // fabric-api / yarn 依赖产物（loader 同源）；loom 自身经 pluginManagement 解析
    maven("https://maven.fabricmc.net/")
}

base {
    archivesName = "kurobridge-fabric"
}

dependencies {
    implementation(project(":core"))

    // 1.21.4 单版本基线（docs/design.md §1；多 MC 版本矩阵延后，接管点在册）
    minecraft("com.mojang:minecraft:1.21.4")
    mappings("net.fabricmc:yarn:1.21.4+build.8:v2")
    modImplementation("net.fabricmc:fabric-loader:0.19.5")
    modImplementation("net.fabricmc.fabric-api:fabric-api:0.119.4+1.21.4")

    testImplementation(platform("org.junit:junit-bom:5.11.0"))
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

// fabric.mod.json 的 version 由 Gradle 注入（SSOT = 根 version 族；check-versions 门禁
// 的版本族不含本文件，硬编码会制造 ADR-034 反对的隐藏版本点）
tasks.processResources {
    filesMatching("fabric.mod.json") {
        expand("version" to project.version.toString())
    }
}

// 打包：shadow 白名单（:core + Jackson）→ loom remapJar 产出最终 mod JAR。
// 白名单而非全量 runtimeClasspath：loom 下 runtimeClasspath 含 fabric-api/loader 的 mod jar，
// 不可吞入。loom include 嵌套 jar 路线弃选的原因见 docs/design.md §6（:core 纯库不可加
// fabric.mod.json，ADR-021）。
tasks.shadowJar {
    dependencies {
        include(project(":core"))
        include(dependency("com.fasterxml.jackson.core:jackson-databind:.*"))
        include(dependency("com.fasterxml.jackson.core:jackson-core:.*"))
        include(dependency("com.fasterxml.jackson.core:jackson-annotations:.*"))
    }
    manifest {
        attributes("Implementation-Title" to "KuroBridge", "Implementation-Version" to project.version)
    }
}

tasks.remapJar {
    // shadow 合并产物（含 :core 与 Jackson）作为重映射输入；:core/Jackson 无 MC 类引用，
    // intermediary 重映射原样通过。输入 manifest 的 Implementation-* 经 loom 合并进产物。
    // （shadow 9 的 kts 访问器不带任务类型，须显式 named<ShadowJar> 取 archiveFile）
    inputFile = tasks.named<ShadowJar>("shadowJar").flatMap { it.archiveFile }
    archiveFileName = "kurobridge-fabric-${project.version}.jar"
}

// 本地单模块全链路（与 paper 模块的 kurobridgeBuild 对称）
tasks.register("kurobridgeBuild") {
    dependsOn(tasks.remapJar)
}
