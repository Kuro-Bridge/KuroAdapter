#!/usr/bin/env node
// 文档死链门禁：扫描全仓 *.md 的相对链接，目标文件必须真实存在（目录也算有效目标）。
// 只查相对路径链接；外部链接（http:/https:/mailto:/data: 等 URI scheme 形式）与
// 纯页内锚点（#fragment）不校验。docs/history/ 是冻结归档（正文不改写约定），不扫。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// 目录名命中即整棵跳过（任意深度）：依赖、构建产物、沙盒；
// 以点开头的目录（.git/.gradle/.cache 等）全是工具产物，一并跳过。
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "build", "sandbox"]);

// 相对仓根的整棵跳过路径（冻结归档）
const SKIP_REL_DIRS = ["docs/history"];

// URI scheme 前缀（http: https: mailto: data: ftp: …）一律视为外链，不校验
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

// 行内链接与图片：[text](target) / ![alt](target)（! 前缀不影响匹配，图片自然覆盖）。
// target 可能带 <...> 包裹或 "标题" 尾缀，捕获后在 normalize 里拆。
const INLINE_LINK_PATTERN = /\[([^\]]*)\]\(([^)]+)\)/g;

// 引用定义：[label]: target（可能带 <...> 包裹或 "标题" 尾缀，捕获后在 normalize 里拆）
const LINK_DEFINITION_PATTERN = /^ {0,3}\[[^\]]+\]:\s*(.+)$/;

// 空白检测（target 与 "标题" 尾缀的分隔）
const WHITESPACE_PATTERN = /\s/;

function toPosix(p) {
    return p.split("\\").join("/");
}

function isSkippedRelDir(relDir) {
    return SKIP_REL_DIRS.some((skip) => relDir === skip || relDir.startsWith(`${skip}/`));
}

function listMarkdownFiles(dir, prefix = "") {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) continue;
            if (isSkippedRelDir(rel)) continue;
            out.push(...listMarkdownFiles(join(dir, entry.name), rel));
        } else if (entry.name.endsWith(".md")) {
            out.push(rel);
        }
    }
    return out.toSorted();
}

// 从链接捕获串里拆出干净的 target：去 <...> 包裹、去 "标题" 尾缀、去 #锚点、尽力解码 %xx
function normalizeTarget(rawTarget) {
    let target = rawTarget.trim();
    if (target.startsWith("<") && target.endsWith(">")) {
        target = target.slice(1, -1);
    }
    // 形如 `./a.md "标题"`：按空白拆，只取第一段
    const spaceAt = target.search(WHITESPACE_PATTERN);
    if (spaceAt !== -1) target = target.slice(0, spaceAt);
    target = target.split("#")[0];
    if (target === "") return null; // 纯页内锚点，不校验
    try {
        target = decodeURIComponent(target);
    } catch {
        // 非法 % 序列：按原样尽力校验
    }
    return target;
}

function collectLineTargets(line) {
    const targets = [];
    for (const match of line.matchAll(INLINE_LINK_PATTERN)) {
        const target = normalizeTarget(match[2] ?? "");
        if (target !== null) targets.push(target);
    }
    const definition = line.match(LINK_DEFINITION_PATTERN);
    if (definition) {
        const target = normalizeTarget(definition[1] ?? "");
        if (target !== null) targets.push(target);
    }
    return targets;
}

const failures = [];
const files = listMarkdownFiles(repoRoot);
for (const rel of files) {
    const lines = readFileSync(join(repoRoot, rel), "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        for (const target of collectLineTargets(lines[i])) {
            if (URI_SCHEME_PATTERN.test(target)) continue; // 外链不校验
            const resolved = join(dirname(join(repoRoot, rel)), target);
            if (!existsSync(resolved)) {
                failures.push(`${toPosix(rel)}:${i + 1}:${target}`);
            }
        }
    }
}

if (failures.length > 0) {
    console.error("[check-docs-links] 发现相对链接死链：");
    for (const f of failures) {
        console.error(`  - ${f}`);
    }
    console.error("[check-docs-links] docs/history/ 已豁免（冻结归档，正文不改写）。");
    process.exit(1);
}

console.log(`[check-docs-links] OK：${files.length} 个 markdown 文件，相对链接全部可达`);
