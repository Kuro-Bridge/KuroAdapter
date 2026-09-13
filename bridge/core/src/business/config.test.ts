import { describe, expect, it } from "vitest";

import { ConfigError, defaultConfig, parseConfig } from "./config.js";

describe("parseConfig", () => {
    it("合法配置通过并去重保序（channels 与 admins 各自去重）", () => {
        expect(
            parseConfig({
                channels: ["10001", "10002", "10001"],
                admins: [
                    { channel: "10001", users: ["alice", "bob", "alice"] },
                    { channel: "10002", users: ["carol"] },
                    { channel: "10001", users: ["dave"] }, // channel 重复：保留首个
                ],
            }),
        ).toEqual({
            channels: ["10001", "10002"],
            token: "",
            admins: [
                { channel: "10001", users: ["alice", "bob"] },
                { channel: "10002", users: ["carol"] },
            ],
            runtime: { autoRestart: true },
        });
    });

    it("token / admins 缺省补齐（向后兼容旧配置文件）", () => {
        expect(parseConfig({ channels: ["10001"] })).toEqual({
            channels: ["10001"],
            token: "",
            admins: [],
            runtime: { autoRestart: true },
        });
        expect(parseConfig({ channels: [], token: "s3cret" })).toMatchObject({ token: "s3cret" });
    });

    it("channels 缺失/非数组/含空串/非对象 → ConfigError", () => {
        expect(() => parseConfig({})).toThrow(ConfigError);
        expect(() => parseConfig({ channels: "10001" })).toThrow(ConfigError);
        expect(() => parseConfig({ channels: [""] })).toThrow(ConfigError);
        expect(() => parseConfig(null)).toThrow(ConfigError);
        expect(() => parseConfig("nope")).toThrow(ConfigError);
    });

    it("token 非字符串 / admins 形状非法 → ConfigError", () => {
        expect(() => parseConfig({ channels: [], token: 123 })).toThrow(ConfigError);
        expect(() => parseConfig({ channels: [], admins: "alice" })).toThrow(ConfigError);
        expect(() => parseConfig({ channels: [], admins: [{ channel: "" }] })).toThrow(ConfigError);
        expect(() =>
            parseConfig({ channels: [], admins: [{ channel: "c", users: [""] }] }),
        ).toThrow(ConfigError);
    });

    it("多余字段被剥离（服主加注释性字段不会炸）", () => {
        expect(parseConfig({ channels: ["10001"], extra: 1 })).toEqual({
            channels: ["10001"],
            token: "",
            admins: [],
            runtime: { autoRestart: true },
        });
    });

    it("runtime.autoRestart 缺省 true，显式值保留（DEBT-2）", () => {
        expect(parseConfig({ channels: [], runtime: { autoRestart: false } })).toMatchObject({
            runtime: { autoRestart: false },
        });
        expect(parseConfig({ channels: [], runtime: {} })).toMatchObject({
            runtime: { autoRestart: true },
        });
        expect(parseConfig({ channels: [] })).toMatchObject({
            runtime: { autoRestart: true },
        });
    });

    it("runtime.autoRestart 非布尔 / runtime 非对象 → ConfigError", () => {
        expect(() => parseConfig({ channels: [], runtime: { autoRestart: "yes" } })).toThrow(
            ConfigError,
        );
        expect(() => parseConfig({ channels: [], runtime: "on" })).toThrow(ConfigError);
    });

    it("defaultConfig 为空绑定 + 不鉴权 + 无管理员 + autoRestart true", () => {
        expect(defaultConfig()).toEqual({
            channels: [],
            token: "",
            admins: [],
            runtime: { autoRestart: true },
        });
    });
});
