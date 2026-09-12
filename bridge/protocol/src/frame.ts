/**
 * 帧格式（draft-v0.1.md §1）：`{ header: { type, id? }, body }`
 *
 * WS 与 IPC 复用同一帧结构（决策 D-04），type 命名空间不同。
 * 事件帧（单向通知）不携带 id；请求/响应帧 id 必填（UUID 关联，ADR-010）。
 */
import { z } from "zod";

const TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;

export const frameHeaderSchema = z.object({
    type: z.string().regex(TYPE_PATTERN),
    id: z.uuid().optional(),
});

export type FrameHeader = z.infer<typeof frameHeaderSchema>;

/** 事件帧（单向通知，携带 id 即校验失败——暴露方向用错的场景） */
export function eventFrameSchema<const T extends string, B extends z.ZodType>(type: T, body: B) {
    return z.object({
        header: z.strictObject({ type: z.literal(type) }),
        body,
    });
}

/** 请求/响应帧（UUID 关联，id 必填） */
export function requestFrameSchema<const T extends string, B extends z.ZodType>(type: T, body: B) {
    return z.object({
        header: frameHeaderSchema.extend({ type: z.literal(type), id: z.uuid() }),
        body,
    });
}

/** 请求-响应的通用结果体 */
export const resultBodySchema = z.union([
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

export type ResultBody = z.infer<typeof resultBodySchema>;
