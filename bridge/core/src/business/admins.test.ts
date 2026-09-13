import { describe, expect, it } from "vitest";
import { AdminTable } from "./admins.js";
import type { AdminMapping } from "./config.js";

const MAPPING: AdminMapping[] = [
    { channel: "10001", users: ["alice", "bob"] },
    { channel: "10002", users: ["carol"] },
];

describe("AdminTable", () => {
    it("构造时去重：entry 按 channel 保留首个、users 去重保序", () => {
        const table = new AdminTable([
            { channel: "10001", users: ["alice", "alice", "bob"] },
            { channel: "10001", users: ["dave"] },
            { channel: "10002", users: ["carol"] },
        ]);
        expect(table.mappings()).toEqual([
            { channel: "10001", users: ["alice", "bob"] },
            { channel: "10002", users: ["carol"] },
        ]);
    });

    it("isAdmin：channel 命中且 userId 在 users 内 → true，其余 false", () => {
        const table = new AdminTable(MAPPING);
        expect(table.isAdmin("10001", "alice")).toBe(true);
        expect(table.isAdmin("10002", "carol")).toBe(true);
        expect(table.isAdmin("10001", "carol")).toBe(false);
        expect(table.isAdmin("10003", "alice")).toBe(false);
        expect(table.isAdmin("", "")).toBe(false);
    });

    it("mappings 返回副本：外部修改不影响内部状态", () => {
        const table = new AdminTable(MAPPING);
        const copy = table.mappings();
        const first = copy[0];
        if (first === undefined) {
            throw new Error("mappings 非空，copy[0] 应存在");
        }
        (first.users as string[]).push("mallory");
        expect(table.isAdmin("10001", "mallory")).toBe(false);
    });

    it("replace 整表替换（配置变更/重载共用路径）", () => {
        const table = new AdminTable(MAPPING);
        table.replace([{ channel: "10009", users: ["eve"] }]);
        expect(table.isAdmin("10001", "alice")).toBe(false);
        expect(table.isAdmin("10009", "eve")).toBe(true);
        table.replace([]);
        expect(table.isAdmin("10009", "eve")).toBe(false);
    });

    it("空表：任何人都不算管理员（缺省 admins=[] 语义）", () => {
        const table = new AdminTable([]);
        expect(table.isAdmin("10001", "alice")).toBe(false);
    });
});
