#!/usr/bin/env node
// 版本对齐门禁（ADR-034 版本单点 + 机械对齐）。断言两族版本一致，任何一点不符列出 期望/实际
// 并 exit 1。零依赖（由根 package.json 的 check 链挂载，本脚本不自挂）。
//
// 1) bridge 版本族（六点，期望值 = 根 package.json 的 version——发版只改这一处，
//    其余五点漂移即红灯提醒同步）：
//    - package.json（根，期望来源）
//    - bridge/embedded/package.json
//    - bridge/embedded/src/version.ts 的 BRIDGE_VERSION（hello_ack 上报唯一来源）
//    - platforms/je/paper/src/main/resources/paper-plugin.yml 的 version:
//    - platforms/je/build.gradle.kts 的全部 `version = "..."`（根级 + subprojects，须 ≥2 处逐一相符）
// 2) 协议版本族（两份）：已安装 npm 包清单 version
//    （bridge/core/node_modules/@kuro-bridge/protocol/package.json，期望来源）≡
//    platforms/je/core/.../KurobridgeVersions.java 的 PROTOCOL_VERSION（Java 硬编码副本）。
//    等价性依据：KuroProtocol 发布侧 scripts/assert-version.mjs 机械断言
//    「包 version ≡ src/meta.ts PROTOCOL_VERSION」（0.4.0 实证对齐），故 npm 清单 version
//    即协议 SSOT（ADR-035 结论 3：锚点换源，先于镜像目录删除落库）。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function readText(relativePath) {
    return readFileSync(join(repoRoot, relativePath), "utf8");
}

/** JSON 文件的 version 字段；缺失/非字符串 → undefined */
function jsonVersion(relativePath) {
    const raw = JSON.parse(readText(relativePath));
    const version = raw.version;
    return typeof version === "string" && version.length > 0 ? version : undefined;
}

/** 文本内首个捕获组（如 BRIDGE_VERSION = "0.1.0"）；无匹配 → undefined */
function firstMatch(relativePath, pattern) {
    const match = pattern.exec(readText(relativePath));
    return match === null ? undefined : match[1];
}

function check(label, expected, actual) {
    if (expected !== actual) {
        failures.push(`${label}：期望 ${expected ?? "(缺失)"}，实际 ${actual ?? "(缺失)"}`);
    }
}

// ---- bridge 版本族（六点） ----

const expectedBridge = jsonVersion("package.json");
if (expectedBridge === undefined) {
    failures.push("根 package.json 缺少合法 version 字段");
} else {
    check(
        "bridge/embedded/package.json version",
        expectedBridge,
        jsonVersion("bridge/embedded/package.json"),
    );
    check(
        "bridge/embedded/src/version.ts BRIDGE_VERSION",
        expectedBridge,
        firstMatch("bridge/embedded/src/version.ts", /BRIDGE_VERSION = "([^"]+)"/),
    );
    check(
        "paper-plugin.yml version",
        expectedBridge,
        firstMatch(
            "platforms/je/paper/src/main/resources/paper-plugin.yml",
            /^version:[ \t]*(\S+)/m,
        ),
    );
    // gradle：解析全部 `version = "..."` 出现点逐一校验（根级无缩进 + subprojects 缩进，
    // 少于 2 处即门禁红；languageVersion 等其它键不以裸 `version` 起始，不会误匹配）
    const gradleVersions = [
        ...readText("platforms/je/build.gradle.kts").matchAll(/^[ \t]*version = "([^"]+)"/gm),
    ].map((match) => match[1]);
    if (gradleVersions.length < 2) {
        failures.push(
            `platforms/je/build.gradle.kts 的 \`version = "..."\` 出现 ${gradleVersions.length} 处（少于 2 处：根级与 subprojects 应各一）`,
        );
    } else {
        gradleVersions.forEach((actual, index) => {
            check(
                `platforms/je/build.gradle.kts version（第 ${index + 1} 处）`,
                expectedBridge,
                actual,
            );
        });
    }
}

// ---- 协议版本族（两份） ----

let expectedProtocol;
try {
    expectedProtocol = jsonVersion("bridge/core/node_modules/@kuro-bridge/protocol/package.json");
} catch {
    // 锚文件缺失（协议依赖未安装）与无合法 version 同归一条根因文案
    expectedProtocol = undefined;
}
if (expectedProtocol === undefined) {
    failures.push(
        "bridge/core/node_modules/@kuro-bridge/protocol/package.json 缺失或无合法 version——协议依赖未安装或消费方未声明（先 pnpm install；ADR-035 结论 3）",
    );
} else {
    check(
        "KurobridgeVersions.java PROTOCOL_VERSION",
        expectedProtocol,
        firstMatch(
            "platforms/je/core/src/main/java/com/kurobridge/core/KurobridgeVersions.java",
            /PROTOCOL_VERSION = "([^"]+)"/,
        ),
    );
}

if (failures.length > 0) {
    console.error("[check-versions] 版本不一致（ADR-034：单点常量 + 机械对齐，请六点/两份同改）：");
    for (const failure of failures) {
        console.error(`  - ${failure}`);
    }
    process.exit(1);
}

console.log(
    `[check-versions] OK：bridge 版本 ${expectedBridge} 六点一致；协议版本 ${expectedProtocol} 两份一致`,
);
