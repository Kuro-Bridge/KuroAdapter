/**
 * toolings/packaging/build-jar.mjs —— build:jar 全链路编排（DEBT-2，跨壳）
 *
 * 步骤：pnpm -r build（TS 产物）→ toolings/packaging/embed.ts（node.exe 等进 :paper resources）→
 * gradle :paper:shadowJar（可分发 JAR）。替代 package.json 里的直排命令——原写法把
 * gradlew.bat 写死（M2-03），POSIX 贡献者不可用；本脚本按 process.platform 选择 wrapper，
 * 并给 gradle 子进程注入 UTF-8 输出编码（cmd.exe GBK 代码页下中文日志乱码的缓解尝试）。
 *
 * 约束：零新依赖（node:child_process）；gradle 输出走 stdio inherit（MVP1-NOTES M-18：
 * 经管道转接会挂起客户端，inherit 直通终端不受影响）。
 *
 * 用法：pnpm build:jar（仓库根）
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const IS_WIN32 = process.platform === "win32";
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function run(label, command, args, options = {}) {
    // shell 模式下 Node 传 args 会触发 DEP0190 警告——改为拼接命令字符串
    //（本脚本参数均无空格/特殊字符，拼接安全）
    const useShell = options.shell === true;
    const finalCommand = useShell ? [command, ...args].join(" ") : command;
    const finalArgs = useShell ? [] : args;
    console.log(`[build-jar] ${label}: ${finalCommand}`);
    const result = spawnSync(finalCommand, finalArgs, {
        stdio: "inherit",
        ...options,
    });
    if (result.status !== 0) {
        console.error(`[build-jar] ${label} 失败（exit=${result.status}）`);
        process.exit(result.status ?? 1);
    }
}

// 1) TS 全量构建（pnpm 在 Windows 是 .cmd，须经 shell 解析）
run("TS 构建", "pnpm", ["-r", "build"], { cwd: ROOT, shell: IS_WIN32 });

// 2) 嵌入式打包（Node 原生 TS 剥离直接执行 toolings/packaging/embed.ts）
run("embed 打包", process.execPath, [join(ROOT, "toolings", "packaging", "embed.ts")], {
    cwd: ROOT,
});

// 3) gradle shadowJar：win32 → gradlew.bat，POSIX → ./gradlew（chmod +x 兜底）
const jeDir = join(ROOT, "platforms", "je");
let gradlew = "./gradlew";
if (IS_WIN32) {
    gradlew = "gradlew.bat";
} else {
    const wrapper = join(jeDir, "gradlew");
    if (existsSync(wrapper)) {
        try {
            chmodSync(wrapper, 0o755);
        } catch {
            // 只读工作区等场景放行——wrapper 已有执行位时无需处理
        }
    }
}

// 构建日志 UTF-8（cmd.exe GBK 代码页乱码缓解）：拼接保留既有 JAVA_TOOL_OPTIONS
const utf8Flags = "-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8";
const existingToolOptions = process.env["JAVA_TOOL_OPTIONS"] ?? "";
const env = {
    ...process.env,
    JAVA_TOOL_OPTIONS: `${existingToolOptions} ${utf8Flags}`.trim(),
};

// gradlew.bat 是批处理：Node（CVE-2024-27980 起）拒绝无 shell 直接 spawn，Windows 必须经
// shell 中介；args 里无空格/特殊字符，shell 拼接安全
run("gradle shadowJar", gradlew, [":paper:shadowJar"], { cwd: jeDir, env, shell: IS_WIN32 });

console.log("[build-jar] 完成：JAR 已产出（platforms/je/paper/build/libs/）");
