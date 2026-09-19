/**
 * kurobridge_core 集成测试专用 Node 桩（tests/fixtures/stub_node.mjs）。
 * 独立无 import（不落 bridge/embedded 依赖面），行为契约对齐 bridge/embedded 的
 * index.ts + ipc-stdio.ts + logger.ts 的最小可观测面：
 *
 *   1. 启动先吐一行 `not-json`（坏行容错用例），随后立即发 ready 帧（「ready 在 WS 绑定
 *      成功后同步发」的最简形态）：wsPort 固定 1、autoRestart 恒 true。
 *   2. stderr 打一条 `[KuroBridge][node][info] stub ready`（日志只进 stderr，
 *      行格式契约 `[KuroBridge][node][LEVEL] message` 同 logger.ts）。
 *   3. 收到 execute_command 请求 → 回 execute_command_result {ok:true, output:["pong"]}；
 *      进程环境设有 KUROBRIDGE_TEST_MARK 时追加一项（父进程环境继承验证用，常态不出现）。
 *   4. 收到 shutdown 帧 → stderr info 一条 → 退出 0；stdin EOF → 退出 0。
 *
 * 注意：关机路径的 stderr 行经「置 exitCode + 自然排空事件循环」退出（Windows 下管道
 * stderr 写为异步，立即 process.exit 可能丢行）；兜底 2s 强退只防悬挂，常态不触发。
 */

let buffer = "";

function send(text) {
    process.stdout.write(`${text}\n`);
}

/** 优雅退出：不调用 process.exit，交由事件循环排空在途 stderr 写后自然收敛 */
function gracefulExit(exitCode) {
    process.exitCode = exitCode;
    const safety = setTimeout(() => process.exit(exitCode), 2000);
    safety.unref();
}

function handleLine(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
        return;
    }
    let frame;
    try {
        frame = JSON.parse(trimmed);
    } catch {
        return; // 坏行静默（父端自有容错用例）
    }
    const type = frame?.header ? frame.header.type : undefined;
    if (type === "shutdown") {
        const reason = frame.body && typeof frame.body.reason === "string" ? frame.body.reason : "";
        process.stderr.write(`[KuroBridge][node][info] 收到关机通知（${reason}），退出\n`);
        gracefulExit(0);
        return;
    }
    if (type === "execute_command") {
        const output = ["pong"];
        const mark = process.env.KUROBRIDGE_TEST_MARK;
        if (typeof mark === "string") {
            output.push(mark);
        }
        send(
            JSON.stringify({
                header: { type: "execute_command_result", id: frame.header.id },
                body: { ok: true, output },
            }),
        );
    }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) {
            break;
        }
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(line);
    }
});
process.stdin.on("close", () => {
    process.stderr.write("[KuroBridge][node][info] stdin EOF，退出\n");
    gracefulExit(0);
});
process.on("SIGTERM", () => gracefulExit(0));

// 启动序列固定：坏行 → ready → stderr 日志（顺序供测试断言）
send("not-json");
send(
    JSON.stringify({
        header: { type: "ready" },
        body: { wsPort: 1, autoRestart: true },
    }),
);
process.stderr.write("[KuroBridge][node][info] stub ready\n");
