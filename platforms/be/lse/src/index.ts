/**
 * platforms/be —— KuroBridge LeviLamina（LSE）平台适配入口（R2′ WS 回环薄壳，ADR-037）。
 *
 * 顶层只做插件注册（LSE 装载期要求）；看护器引导收进 bootstrap 并 try/catch 包裹——
 * 任何异常只记日志不上抛，绝不崩 BDS（插件保持加载，功能降级）。
 * LSE 全局触点收敛在 lse-env.ts；其余模块顶层不触碰全局，测试块可先 stub 再导入。
 * 构建产物 dist/index.js（IIFE，target es2020）由 plugin.json 的 modules[].entry 加载。
 */
import { attemptOnce } from "./bridge-host.js";
import { createShellLogger, logError, registerConsoleCommand } from "./lse-env.js";
import { Supervisor } from "./supervisor.js";

// LSE 全局对象（类型来自 @levimc-lse/types）：ll.registerPlugin 注册插件。
// 第 4 参按类型契约是 Record<string, string>（附加信息，如作者/许可证），不能传裸字符串。
ll.registerPlugin("kurobridge", "KuroBridge LeviLamina 平台适配（群服互通）", [0, 1, 0], {
    author: "KuroBridge",
});

function bootstrap(): void {
    const logger = createShellLogger();
    const supervisor = new Supervisor({ logger, attempt: () => attemptOnce(logger) });
    // 放弃态后的手动恢复入口（裁决册 §4.4；SOP 记载 kurobridgeretry）
    registerConsoleCommand("kurobridgeretry", "手动重试 KuroBridge 看护器", () => {
        supervisor.manualRetry();
    });
    supervisor.start();
}

try {
    bootstrap();
} catch (error: unknown) {
    // 引导失败不崩 BDS：只记日志，服务器与插件继续跑（功能禁用，等手动重试/重载）
    logError(`kurobridge 引导失败（插件保持加载，功能禁用）：${String(error)}`);
}
