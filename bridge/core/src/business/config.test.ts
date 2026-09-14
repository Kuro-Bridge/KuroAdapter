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

    it("ws 段：整段缺省 / 完整 / 只配 host / 只配 port（MVP-3）", () => {
        const base = { channels: ["10001"], token: "", admins: [], runtime: { autoRestart: true } };
        // 整段缺省 = 现状不变（无 ws 键）
        expect(parseConfig({ channels: ["10001"] })).not.toHaveProperty("ws");
        expect(
            parseConfig({ channels: ["10001"], ws: { host: "127.0.0.1", port: 25580 } }),
        ).toEqual({ ...base, ws: { host: "127.0.0.1", port: 25580 } });
        // 只配 host 不配 port = 动态端口 + 指定地址（合法）
        expect(parseConfig({ channels: [], ws: { host: "127.0.0.1" } })).toMatchObject({
            ws: { host: "127.0.0.1" },
        });
        expect(parseConfig({ channels: [], ws: { port: 25580 } })).toMatchObject({
            ws: { port: 25580 },
        });
    });

    it("ws 段非法值 → ConfigError（MVP-3）", () => {
        expect(() => parseConfig({ channels: [], ws: { port: 0 } })).toThrow(ConfigError);
        expect(() => parseConfig({ channels: [], ws: { port: 65536 } })).toThrow(ConfigError);
        expect(() => parseConfig({ channels: [], ws: { port: 25580.5 } })).toThrow(ConfigError);
        expect(() => parseConfig({ channels: [], ws: { port: "25580" } })).toThrow(ConfigError);
        expect(() => parseConfig({ channels: [], ws: { host: "" } })).toThrow(ConfigError);
        expect(() => parseConfig({ channels: [], ws: "25580" })).toThrow(ConfigError);
    });

    it("embedded 段：整段缺省 / 完整 / 只带 enabled（MVP-4）", () => {
        const base = { channels: ["10001"], token: "", admins: [], runtime: { autoRestart: true } };
        // 整段缺省 = 现状不变（无 embedded 键）
        expect(parseConfig({ channels: ["10001"] })).not.toHaveProperty("embedded");
        expect(
            parseConfig({
                channels: ["10001"],
                embedded: {
                    napuketto: { enabled: true, configPath: "napuketto.toml", dataDir: "data" },
                },
            }),
        ).toEqual({
            ...base,
            embedded: {
                napuketto: { enabled: true, configPath: "napuketto.toml", dataDir: "data" },
            },
        });
        // enabled 必填（不给缺省）；configPath/dataDir 可选
        expect(parseConfig({ channels: [], embedded: { napuketto: { enabled: false } } })).toEqual({
            ...base,
            channels: [],
            embedded: { napuketto: { enabled: false } },
        });
    });

    it("embedded 段非法值 → ConfigError（MVP-4）", () => {
        // enabled 缺失 / 非布尔（显式声明要求，不给缺省）
        expect(() => parseConfig({ channels: [], embedded: { napuketto: {} } })).toThrow(
            ConfigError,
        );
        expect(() =>
            parseConfig({ channels: [], embedded: { napuketto: { enabled: "yes" } } }),
        ).toThrow(ConfigError);
        // napuketto 段缺失 / embedded 形状错误 / 可选字段空串
        expect(() => parseConfig({ channels: [], embedded: {} })).toThrow(ConfigError);
        expect(() => parseConfig({ channels: [], embedded: "napuketto" })).toThrow(ConfigError);
        expect(() =>
            parseConfig({
                channels: [],
                embedded: { napuketto: { enabled: true, configPath: "" } },
            }),
        ).toThrow(ConfigError);
        expect(() =>
            parseConfig({ channels: [], embedded: { napuketto: { enabled: true, dataDir: 3 } } }),
        ).toThrow(ConfigError);
    });

    it("defaultConfig 为空绑定 + 不鉴权 + 无管理员 + autoRestart true，且不含 ws 段", () => {
        expect(defaultConfig()).toEqual({
            channels: [],
            token: "",
            admins: [],
            runtime: { autoRestart: true },
        });
        expect(defaultConfig()).not.toHaveProperty("ws");
        expect(defaultConfig()).not.toHaveProperty("embedded");
    });
});
