/**
 * 帧格式：线格式 `{ header: { type, id? }, body }`（draft 见主仓 KuroAdapter docs/history/draft-v0.1.md §1，
 * 逐帧字段表见 docs/peer-guide.md §2）。
 *
 * WS 与 IPC 复用同一帧结构（决策 D-04）。解析后 transform 为**扁平消息**
 * `{ type, id?, body }`（决策 D-11）：TS 无法对嵌套判别（obj.header.type）收窄，
 * 扁平化后消费方可直接 switch/if 收窄。线格式不变，Java 侧不受影响。
 *
 * 事件消息（单向通知）无 id；请求/响应消息 id 必填（UUID 关联，ADR-010）。
 * 事件帧携带 id 会被严格拒绝（尽早暴露方向用错）。
 */
import { z } from "zod";

const TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;

export const frameHeaderSchema = z.object({
    type: z.string().regex(TYPE_PATTERN),
    id: z.uuid().optional(),
});

export type FrameHeader = z.infer<typeof frameHeaderSchema>;

/**
 * 通用线格式帧（两段式解析的第一段，ADR-026）：只约束帧骨架（type 受 snake_case、
 * id 存在时须 UUID、body 任意），供消费方「先取 type、再分发到具体 schema」。
 * 未知帧容忍（WS 服务端收帧侧）据此区分请求帧（带 id）与事件帧（无 id）。
 */
export const wireFrameSchema = z.object({
    header: frameHeaderSchema,
    body: z.unknown(),
});

export type WireFrame = z.infer<typeof wireFrameSchema>;

/** 扁平事件消息 */
export interface EventMessage<T extends string, B> {
    type: T;
    body: B;
}

/** 扁平请求/响应消息（UUID 关联） */
export interface RequestMessage<T extends string, B> {
    type: T;
    id: string;
    body: B;
}

/** 事件帧（单向通知，携带 id 即校验失败） */
export function eventFrameSchema<const T extends string, B extends z.ZodType>(type: T, body: B) {
    return z
        .object({
            header: z.strictObject({ type: z.literal(type) }),
            body,
        })
        .transform((frame) => {
            // zod v4 对泛型成员的对象输出推断不足（body 键丢失），此处用结构断言收拢
            const wire = frame as { header: { type: T }; body: z.output<B> };
            return { type: wire.header.type, body: wire.body } satisfies EventMessage<
                T,
                z.output<B>
            >;
        });
}

/** 请求/响应帧（id 必填） */
export function requestFrameSchema<const T extends string, B extends z.ZodType>(type: T, body: B) {
    return z
        .object({
            header: frameHeaderSchema.extend({ type: z.literal(type), id: z.uuid() }),
            body,
        })
        .transform((frame) => {
            const wire = frame as { header: { type: T; id: string }; body: z.output<B> };
            return {
                type: wire.header.type,
                id: wire.header.id,
                body: wire.body,
            } satisfies RequestMessage<T, z.output<B>>;
        });
}

/** 出帧：扁平消息 → 线格式 JSON 文本（单行，可直接走 WS 文本帧 / IPC JSON-lines） */
export function encodeFrame(message: { type: string; body: unknown; id?: string }): string {
    const header: { type: string; id?: string } = { type: message.type };
    if (message.id !== undefined) {
        header.id = message.id;
    }
    return JSON.stringify({ header, body: message.body });
}

/** 请求-响应的通用结果体 */
export const resultBodySchema = z.union([
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

export type ResultBody = z.infer<typeof resultBodySchema>;

/**
 * 请求-响应的命令结果体（v0.3.0）：ok 分支增可选 `output`（命令输出行，收集型
 * CommandSender 回传；空输出不产生字段——JSON.stringify 落盘时 undefined 键自然省略）。
 * IPC `execute_command_result` 与 WS `command_result` 共用此结果体；`broadcast_result`
 * 保持无 output 的通用结果体。
 */
export const commandResultBodySchema = z.union([
    z.object({ ok: z.literal(true), output: z.array(z.string()).optional() }),
    z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

export type CommandResultBody = z.infer<typeof commandResultBodySchema>;
