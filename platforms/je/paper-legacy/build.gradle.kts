// :paper-legacy —— 旧 Adventure 序列化器隔离层（ADR-038 universal 兼容）
// PlainComponentSerializer 在 adventure 4.15 起弃用、5.x（Paper 26.x 捆绑）已删除，
// 对 26.3 paper-api 编译不过——本模块单独对 1.21.4 时代的 paper-api 编译，
// 产物进 :paper 的 shadowJar，运行期仅在 :paper 的 PlainText 兼容链回退分支被触碰
// （1.19 ~ 1.21.x 的 adventure 4.x 服务器）。Java 8 字节码基线同 :core/:paper。

// 消费端 JVM 版本声明（工具链版本）：paper-api 的 Gradle 元数据按高版本 JVM 发布（21+/25+），
// 变体匹配会拒绝把它放进 release 8 的编译类路径——真正的兼容门禁是 javac --release 8
// （任何 Java 9+ SE API 误用编译即败），此处仅为恢复依赖解析。
import org.gradle.api.attributes.java.TargetJvmVersion

tasks.named<JavaCompile>("compileJava") {
    options.release = 8
    options.compilerArgs.add("-Xlint:-options")
}

configurations.named("compileClasspath") {
    attributes {
        attribute(TargetJvmVersion.TARGET_JVM_VERSION_ATTRIBUTE, 25)
    }
}

dependencies {
    compileOnly("io.papermc.paper:paper-api:1.21.4-R0.1-SNAPSHOT")
}

// 苛刻度：Spotless(Palantir)（ADR-011）
spotless {
    java {
        palantirJavaFormat("2.71.0")
        target("src/**/*.java")
    }
}
