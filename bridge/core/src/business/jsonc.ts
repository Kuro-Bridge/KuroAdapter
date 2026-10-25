/**
 * JSONC 预处理（配置文件 JSONC 化的解析底座，ADR-040）：剥行注释与块注释
 * （斜杠斜杠、斜杠星号两种形态）与行尾逗号，输出严格 JSON 交 JSON.parse。
 * 平台无关（零 Node API，QuickJS 可跑）。
 *
 * 设计约定：
 * - **等长输出**：被剥掉的每个字符替换为空格、换行原样保留——输出与输入逐字符对齐，
 *   JSON.parse 报错的行号与配置文件真实行号一致（服主按报错行能直接定位手改处）。
 * - **字符串字面量感知**：字符串内的注释符、逗号、引号一律不动；反斜杠转义成对消费。
 * - **只放宽注释与行尾逗号**，不引入单引号/无引号键/尾随垃圾等其它宽松——解析失败
 *   仍由 JSON.parse 给出确定性报错（调用方包装为 ConfigError）。
 * - 行尾逗号判定：遇到右括号时向回扫最后一个非空白输出字符，是逗号则替换为空格。
 *   注释被替换为空格后天然透明（逗号与右括号之间隔着块注释同样命中）。
 */

/** BOM（Windows 编辑器常见）；只在文首剥一个 */
const BOM = "\uFEFF";

export function stripJsonc(text: string): string {
    const source = stripBom(text);
    const out: string[] = [];
    let inString = false;
    for (let index = 0; index < source.length; index += 1) {
        if (inString) {
            const step = consumeStringChar(source, out, index);
            index = step.index;
            inString = step.open;
            continue;
        }
        const char = source[index] as string;
        if (char === '"') {
            inString = true;
            out.push(char);
            continue;
        }
        const commentEnd = consumeCommentAt(source, out, index, char);
        if (commentEnd !== null) {
            index = commentEnd;
            continue;
        }
        if (char === "}" || char === "]") {
            stripTrailingComma(out);
        }
        out.push(char);
    }
    return out.join("");
}

/** 文首单个 BOM 剔除（Windows 编辑器常见；仅文首一个） */
function stripBom(text: string): string {
    return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/** 字符串内单字符消费（含反斜杠转义对）；返回消费后下标与是否仍在字符串内 */
function consumeStringChar(
    source: string,
    out: string[],
    index: number,
): { readonly index: number; readonly open: boolean } {
    const char = source[index] as string;
    out.push(char);
    if (char === "\\") {
        // 转义成对消费：转义引号 / 转义反斜杠不结束字符串
        const next = source[index + 1];
        if (next !== undefined) {
            out.push(next);
            return { index: index + 1, open: true };
        }
        return { index, open: true };
    }
    return { index, open: char !== '"' };
}

/** 注释起点消费：非注释返回 null，注释返回应跳到的下标 */
function consumeCommentAt(
    source: string,
    out: string[],
    index: number,
    char: string,
): number | null {
    if (char !== "/") {
        return null;
    }
    const next = source[index + 1];
    if (next === "/") {
        return consumeLineComment(source, out, index);
    }
    if (next === "*") {
        return consumeBlockComment(source, out, index);
    }
    return null;
}

/** 解析 JSONC 文本：剥离注释与行尾逗号后交 JSON.parse（错误原样抛出，调用方包装）。 */
export function parseJsonc(text: string): unknown {
    return JSON.parse(stripJsonc(text));
}

/** 行注释消费到换行前（换行交给主循环下一轮原样输出），返回应跳到的下标。 */
function consumeLineComment(source: string, out: string[], start: number): number {
    let index = start;
    while (index < source.length && source[index] !== "\n") {
        out.push(" ");
        index += 1;
    }
    // 回退一格：主循环 for 的 index += 1 会跳到换行符本身（原样保留，行号不漂移）
    return index - 1;
}

/** 块注释消费到结束符（含）为止，内部换行原样保留；未闭合抛 SyntaxError。 */
function consumeBlockComment(source: string, out: string[], start: number): number {
    // 逐单字符压栈（out 的不变量：每元素恰一字符，行尾逗号回扫按元素判定）
    out.push(" ", " ");
    let index = start + 2;
    while (index < source.length) {
        const char = source[index] as string;
        if (char === "*" && source[index + 1] === "/") {
            out.push(" ", " ");
            return index + 1;
        }
        out.push(char === "\n" ? "\n" : " ");
        index += 1;
    }
    throw new SyntaxError("未闭合的块注释（/* 缺少对应的 */）");
}

/** 向回扫最后一个非空白输出字符，是逗号则替换为空格（行尾逗号容忍）。 */
function stripTrailingComma(out: string[]): void {
    for (let index = out.length - 1; index >= 0; index -= 1) {
        const char = out[index] as string;
        if (char === " " || char === "\t" || char === "\n" || char === "\r") {
            continue;
        }
        if (char === ",") {
            out[index] = " ";
        }
        return;
    }
}
