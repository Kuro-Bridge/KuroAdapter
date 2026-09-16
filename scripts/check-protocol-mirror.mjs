#!/usr/bin/env node
// 协议镜像一致性门禁（ADR-031；KuroProtocol 仓 DECISIONS.md ADR-001 的主仓侧执行机构）。
// 协议 SSOT 在姊妹仓 KuroProtocol（src/ 的 zod schema）；本仓 bridge/protocol/src 是其
// 字节级只读镜像。协议演进的唯一合法路径：在 KuroProtocol 四件套同改 → 同步镜像 → 本门禁绿。
// 直接改本仓镜像 = 门禁红（除非与 SSOT 恰好又一致，即同步动作本身）。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const mirrorSrc = join(repoRoot, "bridge", "protocol", "src");
const ssotRepo = join(repoRoot, "..", "KuroProtocol");
const ssotSrc = join(ssotRepo, "src");

// SSOT 仓 src/ 存在、但不在镜像范围内的文件（本仓无对应消费设施）
const ssotOnlyFiles = new Set(["fixtures.test.ts"]); // 夹具门禁：依赖 KuroProtocol/fixtures/ 与 resolveJsonModule

function listTsFiles(dir, prefix = "") {
    const out = [];
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            out.push(...listTsFiles(join(dir, entry.name), rel));
        } else if (entry.name.endsWith(".ts")) {
            out.push(rel);
        }
    }
    return out.toSorted();
}

if (!existsSync(ssotRepo)) {
    console.error(`[check-protocol] 找不到 SSOT 仓：${ssotRepo}`);
    console.error(
        "[check-protocol] 本仓以工作区形态开发（KuroProtocol 位于兄弟目录），请先克隆/恢复该仓。",
    );
    process.exit(1);
}

const failures = [];
const mirrorFiles = listTsFiles(mirrorSrc);
const ssotFiles = listTsFiles(ssotSrc).filter((f) => !ssotOnlyFiles.has(f));

// 镜像文件集必须与 SSOT（减去白名单）精确相等：不许多（私改）、不许少（漏同步）
const mirrorSet = new Set(mirrorFiles);
const ssotSet = new Set(ssotFiles);
for (const f of mirrorFiles) {
    if (!ssotSet.has(f))
        failures.push(`镜像多出文件（SSOT 无此文件，禁止在本仓新增协议文件）：${f}`);
}
for (const f of ssotFiles) {
    if (!mirrorSet.has(f)) failures.push(`镜像缺失文件（SSOT 已有，本仓未同步）：${f}`);
}

let compared = 0;
for (const f of ssotFiles) {
    if (!mirrorSet.has(f)) continue;
    compared += 1;
    const mirrorBytes = readFileSync(join(mirrorSrc, f));
    const ssotBytes = readFileSync(join(ssotSrc, f));
    if (!mirrorBytes.equals(ssotBytes)) {
        failures.push(`内容漂移：bridge/protocol/src/${f} ≠ KuroProtocol/src/${f}`);
    }
}

if (failures.length > 0) {
    console.error("[check-protocol] 协议镜像与 SSOT 不一致：");
    for (const f of failures) {
        console.error(`  - ${f}`);
    }
    console.error(
        "[check-protocol] 协议演进请在 KuroProtocol 仓四件套同改（schema/peer-guide/fixtures/changelog），",
    );
    console.error(
        "[check-protocol] 再将其 src/ 同步到本仓 bridge/protocol/src/。不要只改本仓一侧。",
    );
    process.exit(1);
}

console.log(`[check-protocol] OK：${compared} 个镜像文件与 KuroProtocol/src 字节级一致`);
console.log(
    `[check-protocol] SSOT 侧另有非镜像文件 ${[...ssotOnlyFiles].length} 个（白名单：${[...ssotOnlyFiles].join(", ")}）`,
);
