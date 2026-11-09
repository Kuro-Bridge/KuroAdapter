/**
 * toolings/lib/runtime.ts —— 内嵌 Node 运行时版本/目标清单读取。
 *
 * SSOT = toolings/runtime-manifest.json：构建期（toolings/packaging/embed.ts）与门禁
 * （toolings/gates/check-runtime-versions.ts）共用同一份读数，任何一侧不再写字面量版本。
 * 版本漂移的机器门禁是 check-runtime-versions（mise.toml / .nvmrc / package.json engines /
 * @types/node 主版本 / CI 五方对齐），不是人物记忆。
 *
 * 约束：零新依赖（node:fs / node:path），与 toolings 其余脚本同源。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** runtime-manifest.json 的形状（构建期消费面）。 */
export interface RuntimeManifest {
    /** 精确 semver（如 26.13.0），必须是 LTS 线的补丁版本——dist 文件名据此拼接。 */
    readonly nodeVersion: string;
    /** 内嵌目标（PlatformKey，如 win-x64 / linux-arm64）；顺序即 embed 产物顺序。 */
    readonly targets: readonly string[];
}

/** 精确 semver：拒绝 `26` / `^26.13.0` / `latest` 之类的浮动值进嵌包版本 SSOT。 */
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * 已知目标键（构建期能力清单，与 Java 侧 PlatformKey 的产物键一一对应——两边同时扩，
 * 别单边改）。
 */
const KNOWN_TARGET = /^(win|linux)-(x64|arm64)$/;

/** 构建期支持的全部目标（错误提示与文档用；顺序即默认产出顺序）。 */
export const KNOWN_TARGETS: readonly string[] = [
    "win-x64",
    "win-arm64",
    "linux-x64",
    "linux-arm64",
];

/**
 * 解析本次要嵌的目标列表。
 *
 * 缺省 = runtime-manifest.json 的 `targets`；`KUROBRIDGE_EMBED_TARGETS`（逗号分隔）可覆盖，
 * 用于本地快速构建或 Lean JAR（只嵌当前平台）。覆盖值仍逐个过合法性校验——未知 target
 * 直接抛错，不做「忽略未知项」的宽容处理（宽容会让 CI 的 Lean 构建静默少平台）。
 */
export function resolveEmbedTargets(
    manifest: RuntimeManifest,
    override: string | undefined,
): string[] {
    if (override === undefined || override.trim() === "") {
        return [...manifest.targets];
    }
    const requested = override
        .split(",")
        .map((target) => target.trim())
        .filter((target) => target.length > 0);
    if (requested.length === 0) {
        throw new Error(`KUROBRIDGE_EMBED_TARGETS 为空：${JSON.stringify(override)}`);
    }
    for (const target of requested) {
        if (!KNOWN_TARGET.test(target)) {
            throw new Error(
                `KUROBRIDGE_EMBED_TARGETS 含未知目标：${target}（已知：${KNOWN_TARGETS.join("/")}）`,
            );
        }
    }
    // 去重但保留声明顺序：同一目标重复出现不应触发重复下载/重复产物
    return [...new Set(requested)];
}

/** 读取并校验仓库根的 runtime-manifest.json；任何形状问题都抛错（构建期宁早失败）。 */
export function readRuntimeManifest(repoRoot: string): RuntimeManifest {
    const path = join(repoRoot, "toolings", "runtime-manifest.json");
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error: unknown) {
        throw new Error(`读取 ${path} 失败：${String(error)}`);
    }
    if (typeof raw !== "object" || raw === null) {
        throw new Error(`${path} 顶层必须是对象`);
    }
    const record = raw as Record<string, unknown>;
    const nodeVersion = record["nodeVersion"];
    if (typeof nodeVersion !== "string" || !EXACT_SEMVER.test(nodeVersion)) {
        throw new Error(
            `${path} 的 nodeVersion 必须是精确 semver（当前值：${String(nodeVersion)}）——` +
                "浮动版本会让嵌包与 mise/CI 静默分叉",
        );
    }
    const targets = record["targets"];
    if (!Array.isArray(targets) || targets.length === 0) {
        throw new Error(`${path} 的 targets 必须是非空数组`);
    }
    for (const target of targets) {
        if (typeof target !== "string" || !KNOWN_TARGET.test(target)) {
            throw new Error(
                `${path} 的 targets 含未知目标：${String(target)}（已知：win-x64/win-arm64/linux-x64/linux-arm64）`,
            );
        }
    }
    return { nodeVersion, targets: targets as string[] };
}
