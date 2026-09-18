/**
 * Vitest 配置
 *
 * 测试文件放在各包 src/ 内（与源码相邻，biome + tsc 自动纳入检查），
 * 只测包内纯函数（相对路径导入，不依赖跨包构建产物）。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: [
            "bridge/*/src/**/*.test.ts",
            // lse 侧测试纳入收集（当前 lse 暂无测试文件，此条是护栏：
            // 保证未来新增 platforms/be/*/src 的测试不会被默认 include 静默忽略）
            "platforms/be/*/src/**/*.test.ts",
            // 工具链脚本也纳入单测
            "scripts/**/*.test.ts",
        ],
        environment: "node",
        coverage: {
            provider: "v8",
            reporter: ["json", "text-summary"],
            // 只统计生产代码（排除测试文件自身）
            exclude: ["**/*.test.ts", "**/*.test-d.ts"],
        },
    },
});
