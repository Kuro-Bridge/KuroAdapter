/**
 * 管理员映射表（纯逻辑，DEBT-1）：command 请求的管理员判定数据源。
 *
 * 与 BindingTable 同模式：构造注入初始值、配置变更/重载时 replace 刷新；
 * 判定规则（任务书 §1.2）：source.channel 命中某条目且 source.userId 在其 users 内 → 放行。
 */
import type { AdminMapping } from "./config.js";

/** entry 按 channel 去重（保留首个）、entry 内 users 去重保序（语义对齐 BindingTable） */
function normalize(admins: readonly AdminMapping[]): AdminMapping[] {
    const byChannel = new Map<string, AdminMapping>();
    for (const entry of admins) {
        const users: string[] = [];
        for (const user of entry.users) {
            if (!users.includes(user)) {
                users.push(user);
            }
        }
        if (!byChannel.has(entry.channel)) {
            byChannel.set(entry.channel, { channel: entry.channel, users });
        }
    }
    return [...byChannel.values()];
}

export class AdminTable {
    private current: AdminMapping[];

    constructor(admins: readonly AdminMapping[]) {
        this.current = normalize(admins);
    }

    /** 当前管理员映射（副本，调用方可安全持有/修改） */
    mappings(): AdminMapping[] {
        return this.current.map((entry) => ({ channel: entry.channel, users: [...entry.users] }));
    }

    isAdmin(channel: string, userId: string): boolean {
        return this.current.some(
            (entry) => entry.channel === channel && entry.users.includes(userId),
        );
    }

    /** 整表替换（配置变更/重载共用路径） */
    replace(admins: readonly AdminMapping[]): void {
        this.current = normalize(admins);
    }
}
