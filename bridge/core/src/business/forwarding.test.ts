import { describe, expect, it } from "vitest";

import { gameEventChannels, platformChatTarget } from "./forwarding.js";

describe("platformChatTarget（平台 → 游戏过滤）", () => {
    it("绑定频道 → 原样放行", () => {
        const chat = { channel: "10001", sender: "小明", content: "大家好" };
        expect(platformChatTarget(["10001", "10002"], chat)).toEqual(chat);
    });

    it("未绑定频道 → null（丢弃）", () => {
        const chat = { channel: "99999", sender: "小明", content: "大家好" };
        expect(platformChatTarget(["10001"], chat)).toBeNull();
        expect(platformChatTarget([], chat)).toBeNull();
    });
});

describe("gameEventChannels（游戏事件 fan-out 目标）", () => {
    it("返回全部绑定频道（MVP：无差异化规则）", () => {
        expect(gameEventChannels(["10001", "10002"])).toEqual(["10001", "10002"]);
        expect(gameEventChannels([])).toEqual([]);
    });
});
