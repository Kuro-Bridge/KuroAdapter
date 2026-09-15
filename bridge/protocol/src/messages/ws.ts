/**
 * WS 侧消息（kurobridge-ws；逐帧字段表 SSOT 见 docs/protocol/peer-guide.md §5，
 * 原始设想与 v0.2 增量沿革见 docs/history/draft-v0.1.md §2/§6）
 *
 * v0.2（MVP 阶段一）：chat 双向携带 channel；hello_ack ok 体携带 channelBindings（ADR-004）；
 * 新增 join / leave / status / bindings_updated 事件（Server→Peer）。
 *
 * v0.3.0（DEBT-1）：hello 增可选 token（鉴权，ADR-026 协商 + 未知帧容忍）；新增
 * command / query 请求族（Peer→Server，UUID 请求-响应）与 command_result / query_result
 * 响应（Server→Peer）；新增 death 事件（Server→Peer，按绑定频道 fan-out）。
 *
 * v0.3.1（MVP-3）：hello 增可选 client（对端自报身份串，仅连接日志辨识，不做行为分支）。
 *
 * 注意：chat 在两个方向 body 形状不同（playerName / sender），
 * 消费方按方向选用 GameChatFrame / PlatformChatFrame（决策 D-01/D-09）。
 * 所有 *Frame 类型均为扁平消息 { type, id?, body }（决策 D-11）。
 */
import { z } from "zod";

import { commandResultBodySchema, eventFrameSchema, requestFrameSchema } from "../frame.js";

// ---- Peer → Server ----

const helloBodySchema = z.object({
    peerId: z.string().min(1),
    platform: z.string().min(1),
    version: z.string().min(1),
    protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    /**
     * 鉴权 token（v0.3.0 可选）：服务端配置非空 token 时未带/带错 → hello_ack
     * ok:false "auth failed" + close 1008；服务端缺省 "" = 不鉴权。
     */
    token: z.string().optional(),
    /**
     * 对端自报身份串（v0.3.1 可选，MVP-3）：建议 `名称/版本` 形如 napukettoqq/1.0。
     * 服务端仅用于连接日志辨识（握手成功日志展示），不做任何行为分支。
     */
    client: z.string().optional(),
});

/** 对端注册（请求，Server 必须回同 id 的 hello_ack） */
export const helloFrame = requestFrameSchema("hello", helloBodySchema);
export type HelloBody = z.infer<typeof helloBodySchema>;
export type HelloFrame = z.infer<typeof helloFrame>;

const pingBodySchema = z.object({
    timestamp: z.number().int().nonnegative(),
});

/** 心跳请求 */
export const pingFrame = requestFrameSchema("ping", pingBodySchema);
export type PingBody = z.infer<typeof pingBodySchema>;
export type PingFrame = z.infer<typeof pingFrame>;

const platformChatBodySchema = z.object({
    /** 消息来源频道（绑定表标识，如群号） */
    channel: z.string().min(1),
    sender: z.string().min(1),
    content: z.string().min(1),
});

/** 平台 → 游戏聊天（事件；服务端按绑定表过滤未绑定频道） */
export const platformChatFrame = eventFrameSchema("chat", platformChatBodySchema);
export type PlatformChatBody = z.infer<typeof platformChatBodySchema>;
export type PlatformChatFrame = z.infer<typeof platformChatFrame>;

const commandSourceSchema = z.object({
    /** 消息来源频道（绑定表标识，如群号） */
    channel: z.string().min(1),
    /** 发送者在该频道的用户标识（协议端负责从群消息提取） */
    userId: z.string().min(1),
});

const commandBodySchema = z.object({
    /** 待执行的命令行（不含前导斜杠，如 "whitelist list"） */
    command: z.string().min(1),
    /** 命令来源（必填：管理员判定在服务端 core 侧，协议端只负责如实提取） */
    source: commandSourceSchema,
});

/** 群指令 → 执行游戏命令（请求；管理员判定/执行在服务端，响应为同 id command_result） */
export const commandFrame = requestFrameSchema("command", commandBodySchema);
export type CommandBody = z.infer<typeof commandBodySchema>;
export type CommandSource = z.infer<typeof commandSourceSchema>;
export type CommandFrame = z.infer<typeof commandFrame>;

const queryBodySchema = z.object({
    /** 查询类别：status = 最近一帧服务器状态快照；bindings = 当前绑定频道列表 */
    kind: z.union([z.literal("status"), z.literal("bindings")]),
});

/** 状态/绑定查询（请求；core 本地作答，响应为同 id query_result） */
export const queryFrame = requestFrameSchema("query", queryBodySchema);
export type QueryBody = z.infer<typeof queryBodySchema>;
export type QueryFrame = z.infer<typeof queryFrame>;

// ---- Server → Peer ----

const helloAckOkBodySchema = z.object({
    ok: z.literal(true),
    serverId: z.string().min(1),
    version: z.string().min(1),
    protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** 服务端绑定表快照（ADR-004：随握手下发；空数组合法） */
    channelBindings: z.array(z.string().min(1)),
});

const helloAckErrorBodySchema = z.object({
    ok: z.literal(false),
    reason: z.string().min(1),
});

/** 握手结果（响应；服务端身份信息并入 body，决策 D-01） */
export const helloAckFrame = z.union([
    requestFrameSchema("hello_ack", helloAckOkBodySchema),
    requestFrameSchema("hello_ack", helloAckErrorBodySchema),
]);
export type HelloAckOkBody = z.infer<typeof helloAckOkBodySchema>;
export type HelloAckErrorBody = z.infer<typeof helloAckErrorBodySchema>;
export type HelloAckBody = HelloAckOkBody | HelloAckErrorBody;
export type HelloAckFrame = z.infer<typeof helloAckFrame>;

const pongBodySchema = z.object({
    timestamp: z.number().int().nonnegative(),
});

/** 心跳响应 */
export const pongFrame = requestFrameSchema("pong", pongBodySchema);
export type PongBody = z.infer<typeof pongBodySchema>;
export type PongFrame = z.infer<typeof pongFrame>;

const gameChatBodySchema = z.object({
    /** 目标频道（服务端按绑定表逐频道 fan-out，每频道一帧） */
    channel: z.string().min(1),
    playerName: z.string().min(1),
    content: z.string().min(1),
});

/** 游戏 → 平台聊天（事件） */
export const gameChatFrame = eventFrameSchema("chat", gameChatBodySchema);
export type GameChatBody = z.infer<typeof gameChatBodySchema>;
export type GameChatFrame = z.infer<typeof gameChatFrame>;

const joinBodySchema = z.object({
    channel: z.string().min(1),
    playerName: z.string().min(1),
});

/** 玩家进服（事件，按绑定频道 fan-out） */
export const joinFrame = eventFrameSchema("join", joinBodySchema);
export type JoinBody = z.infer<typeof joinBodySchema>;
export type JoinFrame = z.infer<typeof joinFrame>;

const leaveBodySchema = z.object({
    channel: z.string().min(1),
    playerName: z.string().min(1),
});

/** 玩家退服（事件，按绑定频道 fan-out） */
export const leaveFrame = eventFrameSchema("leave", leaveBodySchema);
export type LeaveBody = z.infer<typeof leaveBodySchema>;
export type LeaveFrame = z.infer<typeof leaveFrame>;

const statusBodySchema = z.object({
    /** 1 分钟 TPS 均值（Paper getTPS()[0]） */
    tps: z.number().nonnegative(),
    onlinePlayers: z.number().int().nonnegative(),
    uptimeSeconds: z.number().int().nonnegative(),
});

/** 服务器状态（事件；无 channel——全服状态而非频道消息） */
export const statusFrame = eventFrameSchema("status", statusBodySchema);
export type StatusBody = z.infer<typeof statusBodySchema>;
export type StatusFrame = z.infer<typeof statusFrame>;

const bindingsUpdatedBodySchema = z.object({
    /** 变更后的完整绑定列表（非增量；ADR-004） */
    channelBindings: z.array(z.string().min(1)),
});

/** 绑定表变更推送（事件，配置变更时发给已握手对端） */
export const bindingsUpdatedFrame = eventFrameSchema("bindings_updated", bindingsUpdatedBodySchema);
export type BindingsUpdatedBody = z.infer<typeof bindingsUpdatedBodySchema>;
export type BindingsUpdatedFrame = z.infer<typeof bindingsUpdatedFrame>;

/** 群指令的执行结果（响应，同 id；body 与 IPC execute_command_result 共用命令结果体） */
export const commandResultFrame = requestFrameSchema("command_result", commandResultBodySchema);
export type CommandResultFrame = z.infer<typeof commandResultFrame>;

const queryResultBodySchema = z.union([
    z.object({
        ok: z.literal(true),
        /** data 形状由请求 kind 决定：status → StatusBody 同构；bindings → string[]（协议层不强校验） */
        data: z.unknown(),
    }),
    z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

/** 查询结果（响应，同 id） */
export const queryResultFrame = requestFrameSchema("query_result", queryResultBodySchema);
export type QueryResultBody = z.infer<typeof queryResultBodySchema>;
export type QueryResultFrame = z.infer<typeof queryResultFrame>;

const deathBodySchema = z.object({
    /** 目标频道（服务端按绑定表逐频道 fan-out，每频道一帧） */
    channel: z.string().min(1),
    /** 死亡玩家名（任务书原文命名；与 join/leave 的 playerName 不一致已记录并照办） */
    player: z.string().min(1),
    /** 死亡消息文本（Bukkit deathMessage 可为 null → 服务端以空串兜底，故允许空串） */
    message: z.string(),
});

/** 玩家死亡（事件，按绑定频道 fan-out 对齐 join/leave） */
export const deathFrame = eventFrameSchema("death", deathBodySchema);
export type DeathBody = z.infer<typeof deathBodySchema>;
export type DeathFrame = z.infer<typeof deathFrame>;

// ---- 聚合（收帧侧「接受任意已知帧」用；zod 4 不支持嵌套判别路径，故平铺 union，决策 D-09）----

/** kurobridge 服务端视角的收帧集 */
export const wsInboundFrame = z.union([
    helloFrame,
    pingFrame,
    platformChatFrame,
    commandFrame,
    queryFrame,
]);

/** 协议端视角的收帧集 */
export const wsOutboundFrame = z.union([
    helloAckFrame,
    pongFrame,
    gameChatFrame,
    joinFrame,
    leaveFrame,
    deathFrame,
    statusFrame,
    bindingsUpdatedFrame,
    commandResultFrame,
    queryResultFrame,
]);

/**
 * 服务端已知收帧 type 清单（两段式解析的「已知/未知」分界，ADR-026 未知帧容忍）：
 * wire 阶段取出的 type 不在此列表内 → 未知帧容忍路径；在列表内但具体校验失败 → warn 丢弃。
 */
export const WS_INBOUND_TYPES: readonly string[] = ["hello", "ping", "chat", "command", "query"];
