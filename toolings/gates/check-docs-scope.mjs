#!/usr/bin/env node
// 文档口径门禁（ADR-030 品牌迁移的机械执行机构）：
// 旧 npm scope 口径（见下方 LEGACY_SCOPE_PATTERN，正确写法 `@kuro-bridge/`）在 docs/history/
// 归档之外全仓禁用。docs/history/ 是冻结归档（正文不改写约定），历史条目里的旧口径以
// ADR-030 映射表为准，不门禁——只门禁本仓可自行修复的内容。
// 注意：本文件自身不得出现旧口径字面量（否则门禁打自己），展示串从正则 source 派生。
// 遍历/跳过语义单一权威在 lib/repo-walk.mjs（与 check-docs-links 共用）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listRepoFiles, repoRoot, toPosix } from "./lib/repo-walk.mjs";

// 只扫文本文件：源码、文档、构建脚本、清单（覆盖 TS/Java/脚本/配置全口径）
const TEXT_EXTENSIONS = new Set([
    "md",
    "ts",
    "mjs",
    "cts",
    "mts",
    "js",
    "json",
    "jsonc",
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

// 旧口径：见 pattern（本文件不写字面量，展示串从 source 派生）。正确写法 @kuro-bridge/（ADR-030 映射表）
const LEGACY_SCOPE_PATTERN = /@kurobridge\//;
const LEGACY_SCOPE = LEGACY_SCOPE_PATTERN.source.replace("\\/", "/");

const failures = [];
let scanned = 0;
for (const rel of listRepoFiles(repoRoot, TEXT_EXTENSIONS)) {
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
    console.error("[check-docs-scope] docs/history/ 已豁免（冻结归档）。");
    process.exit(1);
}

console.log(
    `[check-docs-scope] OK：${scanned} 个文本文件未发现旧口径 ${LEGACY_SCOPE}（正确写法 @kuro-bridge/，ADR-030）`,
);
