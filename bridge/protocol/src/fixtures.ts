/**
 * 金样本夹具契约校验（docs/fixtures.md；从 src/fixtures.test.ts 平移提炼，ADR-002 选 C）
 *
 * 契约语义摘要（accept/reject × wire/dispatch 三分支 + behavior 引用）：
 * - 元 schema（fixtureSchema）：name/note/source、frames[{dir, frame}].min(1)、expect 三段
 *   （schema ∈ {accept, reject}、reject.stage ∈ {wire, dispatch} 可选、behavior{reply, close}）；
 * - 声明一致性：reject 样本必须声明 reject.stage，accept 样本不得声明；
 * - 逐帧三分支：accept → 每帧按 dir 方向 schema（wsInboundFrame / wsOutboundFrame）解析必须通过；
 *   reject/wire → 每帧连 wireFrameSchema 线格式骨架都必须拒绝；
 *   reject/dispatch → 每帧过 wire 骨架、但方向 schema 拒绝（两段式解析第二段）；
 * - behavior 引用：reply 非 null 时必须匹配 "frames[N]" 且 N < frames.length
 *   （被引用的回执帧本身放在 frames 里，同样被 schema 门禁覆盖）。
 *
 * 行为语义（close code/reason 与 reply 帧的实跑验证）不在此层——协议包只承载期望声明，
 * 执行归各消费方（docs/fixtures.md「behavior 仅校验形状」边界维持不变）。
 * 零 Node API：仅依赖 zod 与本仓 schema（tsconfig types:[]，ADR-002）。
 */
import { z } from "zod";
import { wireFrameSchema } from "./frame.js";
import { wsInboundFrame, wsOutboundFrame } from "./messages/ws.js";

const REPLY_REF = /^frames\[(\d+)\]$/;

/** 金样本元 schema：字段全表与约定见 docs/fixtures.md */
export const fixtureSchema = z.object({
    name: z.string().min(1),
    note: z.string().min(1),
    source: z.string().min(1),
    frames: z
        .array(z.object({ dir: z.enum(["peer->server", "server->peer"]), frame: z.unknown() }))
        .min(1),
    expect: z.object({
        schema: z.enum(["accept", "reject"]),
        reject: z.object({ stage: z.enum(["wire", "dispatch"]) }).optional(),
        behavior: z.object({
            reply: z.string().regex(REPLY_REF).nullable(),
            close: z
                .object({
                    code: z.number().int().positive(),
                    reason: z.string().min(1),
                })
                .nullable(),
        }),
    }),
});

export type Fixture = z.infer<typeof fixtureSchema>;

function directionSchemaOf(dir: "peer->server" | "server->peer") {
    return dir === "peer->server" ? wsInboundFrame : wsOutboundFrame;
}

/** 从原始输入尽力取样本名（元校验失败时给 issues 定位用） */
function sampleLabelOf(raw: unknown): string {
    if (typeof raw === "object" && raw !== null && "name" in raw) {
        const name = (raw as { name: unknown }).name;
        if (typeof name === "string" && name.length > 0) {
            return name;
        }
    }
    return "（name 缺失或非法的样本）";
}

/** 声明一致性层：reject 样本必须声明 reject.stage，accept 样本不得声明 */
function stageIssues(fixture: Fixture): string[] {
    const issues: string[] = [];
    const rejectDeclared = fixture.expect.reject !== undefined;
    if (fixture.expect.schema === "reject" && !rejectDeclared) {
        issues.push(`${fixture.name}: reject 样本必须声明 reject.stage`);
    }
    if (fixture.expect.schema === "accept" && rejectDeclared) {
        issues.push(`${fixture.name}: accept 样本不得声明 reject.stage`);
    }
    return issues;
}

/** 单帧三分支：返回该帧违反契约的 issue，合规返回 null */
function frameIssue(
    fixture: Fixture,
    index: number,
    entry: { dir: "peer->server" | "server->peer"; frame: unknown },
): string | null {
    const label = `${fixture.name} frames[${index}]（${entry.dir}）`;
    const wireOk = wireFrameSchema.safeParse(entry.frame).success;
    const directionOk = directionSchemaOf(entry.dir).safeParse(entry.frame).success;
    if (fixture.expect.schema === "accept") {
        return directionOk ? null : `${label}: 方向 schema 应通过`;
    }
    if (fixture.expect.reject?.stage === "wire") {
        return wireOk ? `${label}: wire 骨架应拒绝` : null;
    }
    if (!wireOk) {
        return `${label}: wire 骨架应通过`;
    }
    return directionOk ? `${label}: 方向 schema 应拒绝（两段式第二段）` : null;
}

/** 逐帧三分支层：accept 必过方向 schema / reject.wire 必拒 wire 骨架 / reject.dispatch 过骨架且拒方向 schema */
function frameIssues(fixture: Fixture): string[] {
    const issues: string[] = [];
    for (const [index, entry] of fixture.frames.entries()) {
        const issue = frameIssue(fixture, index, entry);
        if (issue !== null) {
            issues.push(issue);
        }
    }
    return issues;
}

/** behavior 引用层：reply 非 null 时必须匹配 frames[N] 且 N 在帧数界内（close 仅形状校验，归元 schema） */
function behaviorIssues(fixture: Fixture): string[] {
    const issues: string[] = [];
    const reply = fixture.expect.behavior.reply;
    if (reply === null) {
        return issues;
    }
    const match = REPLY_REF.exec(reply);
    if (match === null) {
        issues.push(`${fixture.name}: behavior.reply 引用格式非法（${reply}）`);
    } else if (!(Number(match[1]) < fixture.frames.length)) {
        issues.push(
            `${fixture.name}: behavior.reply 索引越界（${reply}，共 ${fixture.frames.length} 帧）`,
        );
    }
    return issues;
}

/**
 * 金样本契约校验（ADR-002 选 C）：聚合元 schema parse、reject.stage 声明一致性、
 * 逐帧三分支、behavior.reply 引用四层规则。数据进、结果出：全部通过返回 ok:true 与
 * 解析后的夹具；任一层失败返回 ok:false 与逐条中文 issue（含样本名；帧级 issue 含帧序号与方向）。
 * 纯函数：不抛异常、不依赖任何测试框架与 Node API。
 */
export function validateFixture(
    raw: unknown,
): { ok: true; fixture: Fixture } | { ok: false; issues: string[] } {
    const parsed = fixtureSchema.safeParse(raw);
    if (!parsed.success) {
        const label = sampleLabelOf(raw);
        const issues = parsed.error.issues.map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join(".") : "（根）";
            return `${label}: 元校验失败 ${path}（${issue.message}）`;
        });
        return { ok: false, issues };
    }
    const fixture = parsed.data;
    const issues = [...stageIssues(fixture), ...frameIssues(fixture), ...behaviorIssues(fixture)];
    return issues.length > 0 ? { ok: false, issues } : { ok: true, fixture };
}
