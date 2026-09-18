#!/usr/bin/env node
// 文档口径门禁（ADR-030 品牌迁移的机械执行机构）：
// 旧 npm scope 口径（见下方 LEGACY_SCOPE_PATTERN，正确写法 `@kuro-bridge/`）在 docs/history/
// 归档之外全仓禁用。docs/history/ 是冻结归档（正文不改写约定），历史条目里的旧口径以
// ADR-030 映射表为准，不门禁；bridge/protocol/src/ 是 KuroProtocol 的字节级只读镜像
// （ADR-031），本仓无权修改（演进只能改 SSOT 再同步镜像），门禁它没有可执行的意义——
// 只门禁本仓可自行修复的内容。
// 注意：本文件自身不得出现旧口径字面量（否则门禁打自己），展示串从正则 source 派生。
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// 只扫文本文件：源码、文档、构建脚本、清单（覆盖 TS/Java/脚本/配置全口径）
const TEXT_EXTENSIONS = new Set([
    "md",
    "ts",
    "mjs",
    "cts",
    "mts",
    "js",
    "json",
    "kts",
    "gradle",
    "yml",
    "yaml",
    "toml",
    "cmd",
    "ps1",
    "sh",
    "java",
    "xml",
]);

// 目录名命中即整棵跳过（任意深度）：依赖、构建产物、沙盒；
// 以点开头的目录（.git/.gradle/.cache 等）全是工具产物，一并跳过。
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "build", "sandbox"]);

// 相对仓根的整棵跳过路径（冻结归档 / 只读镜像，见文件头注释）
const SKIP_REL_DIRS = ["docs/history", "bridge/protocol/src"];

// 旧口径：见 pattern（本文件不写字面量，展示串从 source 派生）。正确写法 @kuro-bridge/（ADR-030 映射表）
const LEGACY_SCOPE_PATTERN = /@kurobridge\//;
const LEGACY_SCOPE = LEGACY_SCOPE_PATTERN.source.replace("\\/", "/");

function toPosix(p) {
    return p.split("\\").join("/");
}

function isSkippedRelDir(relDir) {
    return SKIP_REL_DIRS.some((skip) => relDir === skip || relDir.startsWith(`${skip}/`));
}

// 目录级跳过判定：点开头（.git/.gradle/.cache 等工具产物）、名单命中、豁免路径
function isSkippedDir(entry, relDir) {
    if (entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) return true;
    return isSkippedRelDir(relDir);
}

function fileExtension(name) {
    const dot = name.lastIndexOf(".");
    return dot === -1 ? "" : name.slice(dot + 1);
}

function listTextFiles(dir, prefix = "") {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (isSkippedDir(entry, rel)) continue;
            out.push(...listTextFiles(join(dir, entry.name), rel));
        } else if (TEXT_EXTENSIONS.has(fileExtension(entry.name))) {
            out.push(rel);
        }
    }
    return out.toSorted();
}

const failures = [];
let scanned = 0;
for (const rel of listTextFiles(repoRoot)) {
    const lines = readFileSync(join(repoRoot, rel), "utf8").split(/\r?\n/);
    scanned += 1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (LEGACY_SCOPE_PATTERN.test(line)) {
            failures.push(`${toPosix(rel)}:${i + 1}:${line.trim()}`);
        }
    }
}

if (failures.length > 0) {
    console.error(
        `[check-docs-scope] 发现旧 npm scope 口径 ${LEGACY_SCOPE}（正确写法 @kuro-bridge/，ADR-030）：`,
    );
    for (const f of failures) {
        console.error(`  - ${f}`);
    }
    console.error(
        "[check-docs-scope] docs/history/ 与 bridge/protocol/src/ 已豁免（冻结归档 / 只读镜像）。",
    );
    process.exit(1);
}

console.log(
    `[check-docs-scope] OK：${scanned} 个文本文件未发现旧口径 ${LEGACY_SCOPE}（正确写法 @kuro-bridge/，ADR-030）`,
);
