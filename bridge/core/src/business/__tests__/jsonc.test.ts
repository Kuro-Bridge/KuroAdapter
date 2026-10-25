/** jsonc 剥离器单测（ADR-040）：注释形态、字符串感知、行尾逗号、等长输出、BOM、组合 parse */
import { describe, expect, it } from "vitest";

import { parseJsonc, stripJsonc } from "../jsonc.ts";

/** 与源串等长的空格串（期望值构造用：等长输出约定的镜像） */
function spaces(count: number): string {
    return " ".repeat(count);
}

describe("stripJsonc 行注释", () => {
    it("行中/整行注释剥离为等长空格，换行保留；紧邻右括号的逗号属行尾逗号一并剥离", () => {
        const source = '{\n  // 整行注释\n  "a": 1, // 行中注释\n}';
        expect(stripJsonc(source)).toBe(
            `{\n  ${spaces("// 整行注释".length)}\n  "a": 1${spaces(", // 行中注释".length)}\n}`,
        );
    });

    it("URL 双斜杠在字符串内不剥", () => {
        expect(stripJsonc('{"url": "ws://127.0.0.1:25580"}')).toBe(
            '{"url": "ws://127.0.0.1:25580"}',
        );
    });

    it("注释符号在字符串内不剥（含转义引号后的字符串延续）", () => {
        const source = '{"a": "x//y/*z*/w", "b": "引号\\"后仍是字符串 // 注释"}';
        expect(stripJsonc(source)).toBe(source);
    });
});

describe("stripJsonc 块注释", () => {
    it("单行内块注释剥离为等长空格（含首尾界定符）", () => {
        const comment = "/* 注释 */";
        expect(stripJsonc(`{"a": ${comment} 1}`)).toBe(`{"a": ${spaces(comment.length)} 1}`);
    });

    it("跨行块注释剥离，换行保留（行号不漂移）", () => {
        const source = '{\n/* 第一行\n   第二行 */\n"a": 1}';
        const stripped = stripJsonc(source);
        expect(stripped.split("\n")).toHaveLength(4);
        expect(JSON.parse(stripped)).toEqual({ a: 1 });
    });

    it("未闭合块注释抛 SyntaxError", () => {
        expect(() => stripJsonc('{"a": 1} /* 未闭合')).toThrow(SyntaxError);
    });
});

describe("stripJsonc 行尾逗号", () => {
    it("对象与数组的行尾逗号剥离", () => {
        expect(JSON.parse(stripJsonc('{"a": [1, 2,],}'))).toEqual({ a: [1, 2] });
    });

    it("注释夹在逗号与右括号之间同样命中", () => {
        expect(JSON.parse(stripJsonc('{"a": [1, /* 尾随 */]}'))).toEqual({ a: [1] });
    });

    it("非行尾逗号不动（等长性质下的回扫只吞紧邻逗号）", () => {
        expect(JSON.parse(stripJsonc('{"a": 1, "b": 2}'))).toEqual({ a: 1, b: 2 });
        expect(JSON.parse(stripJsonc('{"a": "逗号,在值里", "b": [1, 2]}'))).toEqual({
            a: "逗号,在值里",
            b: [1, 2],
        });
    });
});

describe("stripJsonc 等长输出与 BOM", () => {
    it("无 BOM 时输出与输入逐字符等长（报错行号对齐文件真实行号）", () => {
        const source = '{\n  // 头注释\n  "channels": [],\n  "token": "",\n}\n';
        expect(stripJsonc(source)).toHaveLength(source.length);
    });

    it("文首 BOM 剥离后可解析（Windows 编辑器常见）", () => {
        expect(parseJsonc(`\uFEFF{"a": 1}`)).toEqual({ a: 1 });
    });
});

describe("parseJsonc 组合", () => {
    it("注释 + 行尾逗号 + CRLF 混合文件解析", () => {
        const source = [
            "// 头注释",
            "{",
            '    "channels": ["10001", "10001"], // 行中',
            '    "token": "",',
            "}",
            "",
        ].join("\r\n");
        expect(parseJsonc(source)).toEqual({ channels: ["10001", "10001"], token: "" });
    });

    it("真正的语法错误原样抛出（只放宽注释与行尾逗号，不做其它宽松）", () => {
        expect(() => parseJsonc("{'single': 'quote'}")).toThrow();
        expect(() => parseJsonc("{channels: []}")).toThrow();
        expect(() => parseJsonc('{"a": 1} 尾随垃圾')).toThrow();
    });

    it("合法 JSON 原样通过", () => {
        expect(parseJsonc('{"channels": ["10001"]}')).toEqual({ channels: ["10001"] });
    });
});
