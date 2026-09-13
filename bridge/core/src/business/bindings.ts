/**
 * 绑定表（纯逻辑，MVP 阶段一）：当前生效的绑定频道集合，是转发规则的数据源。
 *
 * hello_ack 的 channelBindings 快照与 bindings_updated 推送都从这里取值；
 * replace 返回是否发生**集合语义**变化（重排不算变化，避免无意义的推送）。
 */

/** 去重保序 */
function dedupe(channels: readonly string[]): string[] {
    const unique: string[] = [];
    for (const channel of channels) {
        if (!unique.includes(channel)) {
            unique.push(channel);
        }
    }
    return unique;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    return a.every((channel) => b.includes(channel));
}

export class BindingTable {
    private current: string[];

    constructor(channels: readonly string[]) {
        this.current = dedupe(channels);
    }

    /** 当前绑定频道（副本，调用方可安全持有/修改） */
    channels(): string[] {
        return [...this.current];
    }

    has(channel: string): boolean {
        return this.current.includes(channel);
    }

    /**
     * 整表替换。返回集合语义上是否发生变化（顺序重排不触发）。
     */
    replace(channels: readonly string[]): boolean {
        const next = dedupe(channels);
        if (sameSet(next, this.current)) {
            return false;
        }
        this.current = next;
        return true;
    }
}
