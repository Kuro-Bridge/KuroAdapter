/**
 * toolings/build/platforms.mjs —— 平台侧构建统一入口（跨壳）
 *
 * 背景：三侧构建此前只有 TS 侧有根级入口（pnpm -r build / pnpm check）；Java 侧要手动
 * cd platforms/je 跑 gradlew，C++ 侧（endstone）更是只有 CI 里三条裸命令。本脚本把平台
 * 两侧收敛为根级一条命令，与 CI 各 job 逐条等价（ci.yml）：
 *
 *   je       → gradlew build（= java job：编译 + spotlessCheck + 全部测试）
 *   endstone → cmake --preset core && cmake --build --preset core && ctest --preset core
 *              （= endstone job：portable 层配置 + 构建 + ctest 五目标；dll 轨道
 *              windows-clang-cl 仍是手动 SOP，见 platforms/be/endstone/readme.md）
 *   all      → je + endstone（TS 侧不在此重复：pnpm -r build / pnpm check 已覆盖）
 *
 * 约束：零新依赖；gradle 侧复用 toolings/lib/proc.mjs（wrapper 选择与 UTF-8 注入与
 * build-jar.mjs 同源）。ctest 集成目标缺 node.exe 时自跳过（endstone readme 语义）。
 *
 * 用法：pnpm build:je | pnpm build:endstone | pnpm build:all（仓库根）
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gradleUtf8Env, IS_WIN32, resolveGradlew, run } from "../lib/proc.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function buildJe() {
    const jeDir = join(ROOT, "platforms", "je");
    run("build:je", resolveGradlew(jeDir), ["build"], {
        cwd: jeDir,
        env: gradleUtf8Env(),
        shell: IS_WIN32,
    });
}

function buildEndstone() {
    const beDir = join(ROOT, "platforms", "be", "endstone");
    // cmake/ctest 都是真实可执行文件（非 .bat），无需 shell 中介
    run("build:endstone configure", "cmake", ["--preset", "core"], { cwd: beDir });
    run("build:endstone build", "cmake", ["--build", "--preset", "core"], { cwd: beDir });
    run("build:endstone ctest", "ctest", ["--preset", "core"], { cwd: beDir });
}

const target = process.argv[2];
if (target === "je") {
    buildJe();
} else if (target === "endstone") {
    buildEndstone();
} else if (target === "all") {
    buildJe();
    buildEndstone();
} else {
    console.error("用法：node toolings/build/platforms.mjs <je|endstone|all>");
    process.exit(1);
}
console.log(`[build:platforms] 完成（${target}）`);
