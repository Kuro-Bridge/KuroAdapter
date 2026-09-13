import { describe, expect, it } from "vitest";

import { BindingTable } from "./bindings.js";

describe("BindingTable", () => {
    it("构造去重保序；channels 返回副本（外部修改不影响内部）", () => {
        const table = new BindingTable(["10001", "10002", "10001"]);
        const snapshot = table.channels();
        expect(snapshot).toEqual(["10001", "10002"]);

        snapshot.push("99999");
        expect(table.channels()).toEqual(["10001", "10002"]);
    });

    it("has 按成员判断", () => {
        const table = new BindingTable(["10001"]);
        expect(table.has("10001")).toBe(true);
        expect(table.has("10002")).toBe(false);
    });

    it("replace 集合变化返回 true 并生效；重排/重复写入返回 false 不触发推送", () => {
        const table = new BindingTable(["10001", "10002"]);

        expect(table.replace(["10002", "10001"])).toBe(false); // 同集合重排
        expect(table.replace(["10001", "10001", "10002"])).toBe(false); // 同集合重复
        expect(table.channels()).toEqual(["10001", "10002"]);

        expect(table.replace(["10001", "10003"])).toBe(true);
        expect(table.channels()).toEqual(["10001", "10003"]);

        expect(table.replace([])).toBe(true); // 清空也是变化
        expect(table.channels()).toEqual([]);
    });
});
