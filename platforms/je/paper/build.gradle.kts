// :paper —— Paper 服务端适配（薄壳的业务桥接层）
// 依赖 :core（纯逻辑）+ :paper-legacy（旧 Adventure 序列化器隔离层）+ Paper API（compileOnly）
// 产物：shadowJar fat JAR（内含 :core + :paper-legacy + embedded 资源）

plugins {
    id("com.gradleup.shadow")
}

// Java 8 字节码基线（ADR-038 universal 兼容），同 :core：只约束 main 源集，
// --release 8 是 Java 9+ SE API 误用的机器门禁；-Xlint:-options 压制 JDK 25 的过时提示。
// 消费端 JVM 版本声明为工具链版本的原因同 :paper-legacy（paper-api 元数据 21+/25+）。
import org.gradle.api.attributes.java.TargetJvmVersion

tasks.named<JavaCompile>("compileJava") {
    options.release = 8
    // -Xlint:-options 压制 JDK 25 的「源/目标 8 已过时」提示；-Xlint:-classfile 压制
    // release-8 类文件模型读 26.3 jar（@Deprecated(since=/forRemoval=) 为 Java 9+ 元素）
    // 的固有噪音——两者均非源码问题，-Werror 之外的真实门禁（Java 9+ SE API 误用）保留
    options.compilerArgs.addAll(listOf("-Xlint:-options", "-Xlint:-classfile"))
}

configurations.named("compileClasspath") {
    attributes {
        attribute(TargetJvmVersion.TARGET_JVM_VERSION_ATTRIBUTE, 25)
    }
}

dependencies {
    implementation(project(":core"))
    // 旧 Adventure 序列化器（PlainComponentSerializer）隔离层：对 1.21.4 时代 api 编译，
    // 运行期仅 PlainText 兼容链回退分支触碰（1.19 ~ 1.21.x 服务器），ADR-038
    implementation(project(":paper-legacy"))
    // ADR-038：编译目标对齐现行主线（26.3 捆绑 Adventure 5.2，PlainComponentSerializer 已删，
    // PlainTextComponentSerializer 可用）；全版本运行面经 Compat 探测 + String 侧路径覆盖
    compileOnly("io.papermc.paper:paper-api:26.3.build.219-stable")
    // vanilla 命令输出捕获（NodeRequestHandler 回退路径）：仅编译期需要，运行期由
    // Paper 服务端自带 log4j-core 提供（v0.3.0，DEBT-1，见 DEBT1-NOTES D1-04）
    compileOnly("org.apache.logging.log4j:log4j-core:2.25.1")
    // QR 状态文件解析（KurobridgeCommand qr 子命令，MVP-4）：:core 的 Jackson 是 implementation
    // 不传递，本模块显式声明同版本（shadow 合并 runtimeClasspath，fat JAR 不重复）
    implementation(libs.jackson.databind)
}

// 苛刻度：Spotless(Palantir)（ADR-011）
spotless {
    java {
        palantirJavaFormat("2.71.0") // JDK 25 兼容：>=2.71.0 才能用新版 javac 内部 API（spotless#2625）
        target("src/**/*.java")
    }
}

// 全链路构建（AGENTS.md 构建顺序）：TS 构建 → 嵌入式打包（toolings/packaging/embed.ts）→ shadowJar
tasks.shadowJar {
    archiveFileName.set("kurobridge-${project.version}.jar")
    archiveClassifier.set("")
    // Jackson 三件各带 META-INF/LICENSE/NOTICE，重复 zip 条目会被 Paper 1.20.5+ 的
    // PluginRemapper 拒绝（经典 plugin.yml 的 api-version 1.13 触发重映射；2026-10-25
    // Paper-1.21.11 实证 Duplicate entries detected）——EXCLUDE 保首个，条目唯一
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    manifest {
        attributes("Implementation-Title" to "KuroBridge", "Implementation-Version" to project.version)
    }
}

// 本地全链路构建（与根 pnpm build:jar 对应）
tasks.register("kurobridgeBuild") {
    dependsOn(tasks.shadowJar)
}
