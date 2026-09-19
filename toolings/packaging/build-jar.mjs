/**
 * toolings/packaging/build-jar.mjs —— build:jar 全链路编排（DEBT-2，跨壳）
 *
 * 步骤：pnpm -r build（TS 产物）→ toolings/packaging/embed.ts（node.exe 等进各平台 resources，
 * 见 embed.ts defaultEmbedTargets）→ gradle :paper:shadowJar（Paper 可分发 JAR）→
 * gradle :fabric:remapJar（Fabric mod JAR，shadow 合并 + loom 重映射）。
 * 替代 package.json 里的直排命令——原写法把 gradlew.bat 写死（M2-03），POSIX 贡献者不可用；
 * wrapper 选择 / UTF-8 注入 / 失败即退经 toolings/lib/proc.mjs 共享（与 build/platforms.mjs
 * 同源，此前两处各持一份）。
 *
 * 约束：零新依赖（node:child_process）；gradle 输出走 stdio inherit（MVP1-NOTES M-18：
 * 经管道转接会挂起客户端，inherit 直通终端不受影响）。
 *
 * 用法：pnpm build:jar（仓库根）
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gradleUtf8Env, IS_WIN32, resolveGradlew, run } from "../lib/proc.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// 1) TS 全量构建（pnpm 在 Windows 是 .cmd，须经 shell 解析）
run("TS 构建", "pnpm", ["-r", "build"], { cwd: ROOT, shell: IS_WIN32 });

// 2) 嵌入式打包（Node 原生 TS 剥离直接执行 toolings/packaging/embed.ts）
run("embed 打包", process.execPath, [join(ROOT, "toolings", "packaging", "embed.ts")], {
    cwd: ROOT,
});

// 3) gradle shadowJar + 4) gradle remapJar（fabric mod 产物：shadow 白名单合并 :core + Jackson
//    后 loom 重映射，见 platforms/je/fabric/build.gradle.kts 与其 docs/design.md §6）
const jeDir = join(ROOT, "platforms", "je");
const gradlew = resolveGradlew(jeDir);
const env = gradleUtf8Env();

// gradlew.bat 是批处理：Node（CVE-2024-27980 起）拒绝无 shell 直接 spawn，Windows 必须经
// shell 中介；args 里无空格/特殊字符，shell 拼接安全
run("gradle shadowJar", gradlew, [":paper:shadowJar"], { cwd: jeDir, env, shell: IS_WIN32 });
run("gradle fabric remapJar", gradlew, [":fabric:remapJar"], { cwd: jeDir, env, shell: IS_WIN32 });

console.log(
    "[build-jar] 完成：JAR 已产出（platforms/je/paper/build/libs/ 与 platforms/je/fabric/build/libs/）",
);
