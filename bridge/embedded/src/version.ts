/**
 * kurobridge 版本唯一来源（ADR-034 版本单点）。
 *
 * hello_ack 上报 version 的唯一取值点（index.ts 注入 CoreContext.version）。
 * 与根 package.json / bridge/embedded/package.json / paper-plugin.yml /
 * platforms/je/build.gradle.kts（两处 `version = "..."`）的对齐由
 * toolings/gates/check-versions.mjs 机械强制——改版本须六点同改，门禁红灯即漂移暴露。
 * 不用运行期读 package.json：esbuild 单文件 bundle + JAR 嵌入布局不含 package.json（ADR-034 理由）。
 */
export const BRIDGE_VERSION = "0.1.0";
