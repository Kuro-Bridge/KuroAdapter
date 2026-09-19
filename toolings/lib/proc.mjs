/**
 * toolings/lib/proc.mjs —— 跨壳进程助手（toolings 编排脚本共用）
 *
 * 收敛 packaging/build-jar.mjs 与 build/platforms.mjs 各持一份的三件套：
 * run（子进程直通终端 + 失败即退）、resolveGradlew（wrapper 跨平台选择）、
 * gradleUtf8Env（cmd.exe GBK 代码页下 gradle 中文日志乱码缓解）。
 * 语义与抽取前逐字节一致；新编排脚本一律经此调用，不再各写一份。
 *
 * 约束：零新依赖（node:child_process / node:fs / node:path）。
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

export const IS_WIN32 = process.platform === "win32";

/**
 * 同步跑一条命令，stdio inherit 直通终端（MVP1-NOTES M-18：经管道转接会挂起客户端），
 * 非零退出直接终止编排（退出码透传）。
 */
export function run(label, command, args, options = {}) {
    // shell 模式下 Node 传 args 会触发 DEP0190 警告——改为拼接命令字符串
    //（调用方参数均无空格/特殊字符，拼接安全）
    const useShell = options.shell === true;
    const finalCommand = useShell ? [command, ...args].join(" ") : command;
    const finalArgs = useShell ? [] : args;
    console.log(`[${label}] ${finalCommand}`);
    const result = spawnSync(finalCommand, finalArgs, {
        stdio: "inherit",
        ...options,
    });
    if (result.status !== 0) {
        console.error(`[${label}] 失败（exit=${result.status}）`);
        process.exit(result.status ?? 1);
    }
}

/**
 * gradle wrapper 跨平台选择：win32 → gradlew.bat（Node 自 CVE-2024-27980 起拒绝
 * 无 shell 直接 spawn .bat，调用方须配 shell: true）；POSIX → ./gradlew（chmod +x 兜底，
 * 只读工作区等场景放行——wrapper 已有执行位时无需处理）。
 */
export function resolveGradlew(dir) {
    if (IS_WIN32) {
        return "gradlew.bat";
    }
    const wrapper = join(dir, "gradlew");
    if (existsSync(wrapper)) {
        try {
            chmodSync(wrapper, 0o755);
        } catch {
            // 执行位已就绪或文件系统不支持 chmod 时无需处理
        }
    }
    return "./gradlew";
}

/** gradle 子进程注入 UTF-8 输出编码；拼接保留调用方既有 JAVA_TOOL_OPTIONS。 */
export function gradleUtf8Env() {
    const utf8Flags = "-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8";
    const existingToolOptions = process.env["JAVA_TOOL_OPTIONS"] ?? "";
    return {
        ...process.env,
        JAVA_TOOL_OPTIONS: `${existingToolOptions} ${utf8Flags}`.trim(),
    };
}
