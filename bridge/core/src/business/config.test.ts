import { describe, expect, it } from "vitest";

import { ConfigError, defaultConfig, parseConfig } from "./config.js";

describe("parseConfig", () => {
    it("合法配置通过并去重保序", () => {
        expect(parseConfig({ channels: ["10001", "10002", "10001"] })).toEqual({
            channels: ["10001", "10002"],
            runtime: { autoRestart: true },
        });
    });

    it("channels 缺失/非数组/含空串/非对象 → ConfigError", () => {
        expect(() => parseConfig({})).toThrow(ConfigError);
        expect(() => parseConfig({ channels: "10001" })).toThrow(ConfigError);
        expect(() => parseConfig({ channels: [""] })).toThrow(ConfigError);
        expect(() => parseConfig(null)).toThrow(ConfigError);
        expect(() => parseConfig("nope")).toThrow(ConfigError);
    });

    it("多余字段被剥离（服主加注释性字段不会炸）", () => {
        expect(parseConfig({ channels: ["10001"], extra: 1 })).toEqual({
            channels: ["10001"],
            runtime: { autoRestart: true },
        });
    });

    it("runtime.autoRestart 缺省 true，显式值保留（DEBT-2）", () => {
        expect(parseConfig({ channels: [], runtime: { autoRestart: false } })).toEqual({
            channels: [],
            runtime: { autoRestart: false },
        });
        expect(parseConfig({ channels: [], runtime: {} })).toEqual({
            channels: [],
            runtime: { autoRestart: true },
        });
        expect(parseConfig({ channels: [] })).toEqual({
            channels: [],
            runtime: { autoRestart: true },
        });
    });

    it("runtime.autoRestart 非布尔 / runtime 非对象 → ConfigError", () => {
        expect(() => parseConfig({ channels: [], runtime: { autoRestart: "yes" } })).toThrow(
            ConfigError,
        );
        expect(() => parseConfig({ channels: [], runtime: "on" })).toThrow(ConfigError);
    });

    it("defaultConfig 为空绑定 + autoRestart 缺省 true", () => {
        expect(defaultConfig()).toEqual({ channels: [], runtime: { autoRestart: true } });
    });
});
