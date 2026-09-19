// toolings/gates/lib/repo-walk.mjs —— 门禁共享遍历层（check-docs-scope / check-docs-links 单一权威）
//
// 两个 docs 门禁的仓库根、跳过名单、豁免路径与递归遍历在此单点维护：名单改动一处生效，
// 杜绝两份拷贝漂移（此前 scope/links 各持一份相同的名单与遍历器）。
// 语义：
//   - 目录名命中跳过名单或以点开头（.git/.gradle/.cache 等工具产物）→ 整棵跳过；
//   - 相对仓根路径命中豁免路径（docs/history/ 冻结归档，正文不改写约定）→ 整棵跳过；
//   - 返回相对 POSIX 路径，字典序稳定（门禁输出可 diff、可快照比对）。
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 本文件位于 <仓库根>/toolings/gates/lib/，上溯四级即仓库根
export const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

// 目录名命中即整棵跳过（任意深度）：依赖、构建产物、沙盒
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "build", "sandbox"]);

// 相对仓根的整棵跳过路径（冻结归档：docs/history/ 正文不改写约定）
const SKIP_REL_DIRS = ["docs/history"];

// 目录级跳过判定：点开头（.git/.gradle/.cache 等工具产物）、名单命中、豁免路径
function isSkippedDir(entry, relDir) {
    if (entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) return true;
    return SKIP_REL_DIRS.some((skip) => relDir === skip || relDir.startsWith(`${skip}/`));
}

/** 反斜杠归一为 POSIX 斜杠（门禁输出行用，Windows 下路径分隔符不随平台漂移） */
export function toPosix(p) {
    return p.split("\\").join("/");
}

/** 尾点扩展名（不含点；无点 → ""）。大小写敏感（.MD 与 .md 视为不同，沿用原两门禁判定） */
function fileExtension(name) {
    const dot = name.lastIndexOf(".");
    return dot === -1 ? "" : name.slice(dot + 1);
}

/**
 * 递归列出仓库内指定扩展名的文件（相对 POSIX 路径，字典序排序）。
 * extensions：允许的扩展名集合（fileExtension 语义，如 new Set(["md"])）。
 */
export function listRepoFiles(dir, extensions) {
    const out = [];

    function walk(current, prefix) {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (isSkippedDir(entry, rel)) continue;
                walk(join(current, entry.name), rel);
            } else if (extensions.has(fileExtension(entry.name))) {
                out.push(rel);
            }
        }
    }

    walk(dir, "");
    return out.toSorted();
}
