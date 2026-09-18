/**
 * platforms/be —— KuroBridge LeviLamina（LSE）平台适配（占位）
 *
 * 构建占位：仅注册插件名，保证 workspace 全链路可构建。
 * 业务实现见 docs/design.md 的实现顺序（STATUS.md 第 6 步，JE 闭环后）。
 *
 * 注：此文件经 esbuild 编译为 dist/index.js（IIFE，target es2020），
 * 由 LeviLamina 的 LSE（QuickJS）加载，入口在 plugin.json 的 modules[].entry。
 */

// LSE 全局对象（类型来自 @levimc-lse/types）：ll.registerPlugin 注册插件。
// 第 4 参按类型契约是 Record<string, string>（附加信息，如作者/许可证），不能传裸字符串。
const registered = ll.registerPlugin(
    "kurobridge",
    "KuroBridge LeviLamina 平台适配（群服互通）",
    [0, 1, 0],
    { author: "KuroBridge" },
);

// 占位导出（避免 TS noUnusedLocals 报错；业务接入见 design.md）
export const pluginRegistered = registered;
