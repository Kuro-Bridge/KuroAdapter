#!/usr/bin/env node
// 运行时版本对齐门禁（与 check-versions.ts 同族：单点常量 + 机械对齐）。
//
// SSOT = toolings/runtime-manifest.json 的 nodeVersion。以下各点必须一致，任何一处漂移即 exit 1：
//   1) toolings/runtime-manifest.json        （期望来源）
//   2) mise.toml [tools].node                （团队环境；必须是精确版本，不接受 "26" 浮动）
//   3) .nvmrc                                （actions/setup-node 的 node-version-file 读数）
//   4) package.json engines.node             （包元数据：>=<version>）
//   5) @types/node 主版本（根与 LSE 子包）   （编译期护栏：类型面钉在同主版本，Node 更新主版本
//      的 API 才会在 tsc 阶段报错，而不是线上运行时才炸）
//   6) .github/workflows/*.yml              （凡用 setup-node 都经 node-version-file 读 .nvmrc；
//      禁止任何一处硬编码 `node-version:`——新增工作流最容易偷偷引入第二版本点）
//   7) toolings/packaging/embed.ts           （必须读 SSOT，不得回写字面量版本）
//
// 零依赖：只读文本 + 正则（不引 TOML/YAML 解析器，与本仓 gates 的既有取数风格一致）。
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readRuntimeManifest } from "../lib/runtime.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const failures: string[] = [];

/** 版本串里的首个数字段（`^26.13.0` → `26`），用于主版本比对。 */
const LEADING_DIGITS = /(\d+)/;

function readText(relativePath: string): string {
    return readFileSync(join(repoRoot, relativePath), "utf8");
}

function fail(message: string): void {
    failures.push(message);
}

function check(label: string, expected: string | undefined, actual: string | undefined): void {
    if (expected !== actual) {
        fail(`${label}：期望 ${expected ?? "(缺失)"}，实际 ${actual ?? "(缺失)"}`);
    }
}

/** 文本内首个捕获组；无匹配 → undefined。 */
function firstMatch(text: string, pattern: RegExp): string | undefined {
    const match = pattern.exec(text);
    return match === null ? undefined : match[1];
}

/** `^26.13.0` / `~26.13.0` / `26.13.0` 之类 → 主版本号。 */
function majorOf(version: string | undefined): string | undefined {
    if (version === undefined) {
        return undefined;
    }
    return firstMatch(version, LEADING_DIGITS);
}

const manifest = readRuntimeManifest(repoRoot);
const expected = manifest.nodeVersion;
const expectedMajor = majorOf(expected);

// 1) mise.toml：精确版本，拒绝浮动线（浮动会让 mise 与嵌包静默分叉）
const miseNode = firstMatch(readText("mise.toml"), /^node[ \t]*=[ \t]*"([^"]+)"/m);
check("mise.toml [tools].node", expected, miseNode);

// 2) .nvmrc：actions/setup-node 的 node-version-file 读数
const nvmrc = readText(".nvmrc").trim();
check(".nvmrc", expected, nvmrc);

// 3) package.json engines.node
const rootPackage = JSON.parse(readText("package.json")) as {
    engines?: Record<string, string>;
    devDependencies?: Record<string, string>;
};
check("package.json engines.node", `>=${expected}`, rootPackage.engines?.["node"]);

// 4) 根 @types/node 主版本
const rootTypesMajor = majorOf(rootPackage.devDependencies?.["@types/node"]);
check("package.json @types/node 主版本", expectedMajor, rootTypesMajor);

// 5) LSE 子包 @types/node 主版本（独立声明，同族对齐）
const lsePackage = JSON.parse(readText("platforms/be/lse/package.json")) as {
    devDependencies?: Record<string, string>;
};
check(
    "platforms/be/lse/package.json @types/node 主版本",
    expectedMajor,
    majorOf(lsePackage.devDependencies?.["@types/node"]),
);

// 6) 凡用 actions/setup-node 的工作流都必须经 node-version-file 读 .nvmrc；
//    `node-version:` 出现即视为第二处版本点（新增工作流不许抄硬编码）
const workflowDir = ".github/workflows";
const workflows = readdirSync(join(repoRoot, workflowDir))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
let setupNodeWorkflows = 0;
for (const name of workflows) {
    const label = `${workflowDir}/${name}`;
    const workflow = readText(label);
    if (!workflow.includes("actions/setup-node")) {
        continue;
    }
    setupNodeWorkflows += 1;
    if (!/node-version-file:[ \t]*KuroAdapter\/\.nvmrc/.test(workflow)) {
        fail(`${label} 缺少 \`node-version-file: KuroAdapter/.nvmrc\`（版本必须读 .nvmrc）`);
    }
    if (/^\s*node-version:/m.test(workflow)) {
        fail(`${label} 仍有硬编码 \`node-version:\`（与 .nvmrc 构成第二处版本点）`);
    }
}
if (setupNodeWorkflows === 0) {
    fail(`${workflowDir} 下没有任何用 actions/setup-node 的工作流（门禁失去观测点）`);
}

// 7) 构建脚本必须读 runtime-manifest，不得再写字面量版本（白盒防回退）
const embedSource = readText("toolings/packaging/embed.ts");
if (!embedSource.includes("readRuntimeManifest")) {
    fail("toolings/packaging/embed.ts 未引用 readRuntimeManifest（版本 SSOT 被绕开）");
}
const hardcoded = firstMatch(embedSource, /NODE_VERSION = "([0-9][^"]*)"/);
if (hardcoded !== undefined) {
    fail(`toolings/packaging/embed.ts 仍写字面量版本 NODE_VERSION = "${hardcoded}"`);
}

if (failures.length > 0) {
    console.error(
        "[check-runtime-versions] 运行时版本不一致（SSOT = toolings/runtime-manifest.json）：",
    );
    for (const failure of failures) {
        console.error(`  - ${failure}`);
    }
    process.exit(1);
}

console.log(
    `[check-runtime-versions] OK：Node ${expected}（manifest / mise / .nvmrc / engines / @types ${expectedMajor} / CI 全部一致；目标 ${manifest.targets.join(", ")}）`,
);
