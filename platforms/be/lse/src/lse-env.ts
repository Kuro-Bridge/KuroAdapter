/**
 * LSE 全局（ll / mc / system / file / logger / WSClient / 定时器）的唯一触点。
 *
 * 其余模块只 import 本模块，不直接触碰任何 LSE 全局；且全部访问延迟到函数内
 * （模块顶层不读全局），保证测试块可先 stub globalThis 再导入。
 * 全局 logger 按方法存在性降级：debug/info/warn/error 缺失时回落 log，再缺失则静默。
 */

/** 壳内日志接口（形状对齐 core Logger；壳不依赖 core，独立声明） */
export interface ShellLogger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export type TimerHandle = ReturnType<typeof setTimeout>;

/** 延时调用（LSE 与 node 均有全局 setTimeout；测试可换假计时器） */
export function scheduleTimer(callback: () => void, delayMs: number): TimerHandle {
    return setTimeout(callback, delayMs);
}

/**
 * 取消延时项。LSE 声明面无 clearTimeout（clearInterval 兼取消延时项），
 * node 侧（测试）优先 clearTimeout——运行期按存在性分派。
 */
export function cancelTimer(handle: TimerHandle): void {
    if (typeof clearTimeout === "function") {
        clearTimeout(handle);
        return;
    }
    clearInterval(handle as unknown as number);
}

type LogLevel = "debug" | "info" | "warn" | "error";

function emit(level: LogLevel, message: string): void {
    if (typeof logger === "undefined") {
        return;
    }
    const sink = logger as unknown as Partial<Record<string, unknown>>;
    const method = sink[level];
    if (typeof method === "function") {
        (method as (text: string) => void).call(logger, message);
        return;
    }
    const fallback = sink["log"];
    if (typeof fallback === "function") {
        (fallback as (text: string) => void).call(logger, message);
    }
}

export function createShellLogger(): ShellLogger {
    return {
        debug: (message) => {
            emit("debug", message);
        },
        info: (message) => {
            emit("info", message);
        },
        warn: (message) => {
            emit("warn", message);
        },
        error: (message) => {
            emit("error", message);
        },
    };
}

/** 应急日志（bootstrap 失败路径，logger 实例可能尚不可用时） */
export function logError(message: string): void {
    emit("error", message);
}

export function logDebug(message: string): void {
    emit("debug", message);
}

/**
 * 插件注册（LSE 装载期要求）：index.ts 顶层经此调用，ll 全局触点仍收敛本模块。
 * 版本三元组与 plugin.json / 包版本联动（0.1.0）。
 */
export function registerPlugin(name: string, description: string): void {
    // 第 4 参按类型契约是 Record<string, string>（附加信息，如作者/许可证），不能传裸字符串
    ll.registerPlugin(name, description, [0, 1, 0], { author: "KuroBridge" });
}

/** system.newProcess fire-and-forget 拉起（timeLimit -1 不限时）；false = 启动失败 */
export function spawnProcess(
    command: string,
    onExit: (exitCode: number, output: string) => void,
): boolean {
    return system.newProcess(command, onExit, -1);
}

export function createWsClient(): WSClient {
    return new WSClient();
}

export function listenChat(listener: (player: Player, message: string) => void): void {
    mc.listen("onChat", listener);
}

export function listenJoin(listener: (player: Player) => void): void {
    mc.listen("onJoin", listener);
}

export function listenLeft(listener: (player: Player) => void): void {
    mc.listen("onLeft", listener);
}

export function listenPlayerDie(listener: (player: Player) => void): void {
    mc.listen("onPlayerDie", (player, _source) => {
        listener(player);
    });
}

/** 后台执行命令（broadcast → say 用）；返回是否执行成功 */
export function runCommand(command: string): boolean {
    return mc.runcmd(command);
}

/** 隐藏执行命令（execute_command 用）：结果不回显控制台 */
export function runCommandEx(command: string): { success: boolean; output: string } {
    return mc.runcmdEx(command);
}

export function registerConsoleCommand(
    command: string,
    description: string,
    callback: (args: string[]) => void,
): void {
    mc.regConsoleCmd(command, description, callback);
}

/** 会话令牌：system.randomGuid 去连字符（裁决册 §4.2） */
export function randomToken(): string {
    return system.randomGuid().split("-").join("");
}

/** 主脚本绝对路径（路径推导基准：dirname(dirname(...)) = BDS 根） */
export function pluginFilePath(): string {
    return ll.getCurrentPluginInfo().filePath;
}

export function fileExists(path: string): boolean {
    return file.exists(path);
}
