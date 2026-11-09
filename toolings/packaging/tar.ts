/**
 * toolings/packaging/tar.ts —— 最小 tar.gz 单条目读取（零依赖，只服务内嵌运行时解包）。
 *
 * 为什么不用 .tar.xz：xz 解压没有 Node 内置实现，引依赖不值当；Node 官方对每个 Linux
 * 目标同时提供 .tar.gz 与 .tar.xz，取前者即可用 node:zlib 的 gunzipSync。
 *
 * 只做「按精确名取一个条目」这一件事：顺序扫描 512 字节头，命中目标立即返回，不做全量
 * 解包、不落盘。支持 ustar 的 prefix 字段、PAX 扩展头（typeflag 'x' 的 path= 记录）与
 * GNU LongName（typeflag 'L'），并跳过目录（'5'）与 GNU LongLink（'K'）——这三类是
 * Node 官方包未来改路径布局时最可能踩到的偏移量陷阱。
 *
 * 每个头都校验 tar checksum（把 chksum 字段当 8 个空格累加）。校验不过即抛错，而不是
 * 继续按可能错位的偏移量往下扫——静默取错数据比直接失败危险得多。
 */

import { gunzipSync } from "node:zlib";

/** tar 定长块 512 字节。 */
const BLOCK = 512;

/** 常规文件（旧实现用 '\0' 表示）。 */
const TYPE_REGULAR = "0";
const TYPE_REGULAR_LEGACY = "\0";
/** GNU long name：数据段是「下一个条目的完整路径」。 */
const TYPE_GNU_LONG_NAME = "L";
/** PAX 扩展头：数据段是「长度 键=值\n」记录。 */
const TYPE_PAX = "x";

/** 头内字段偏移（POSIX ustar）。 */
const OFF_NAME = 0;
const OFF_SIZE = 124;
const OFF_CHKSUM = 148;
const OFF_TYPEFLAG = 156;
const OFF_PREFIX = 345;
const NAME_LEN = 100;
const PREFIX_LEN = 155;

/**
 * 从 .tar.gz 缓冲里按精确路径取一个条目。
 *
 * @param gz tar.gz 原始字节
 * @param entryPath 归档内路径（`node-v26.13.0-linux-x64/bin/node`）
 * @returns 条目内容（长度 = 头内 size）
 * @throws Error 归档损坏 / checksum 不符 / 条目不存在
 */
export function extractTarGzEntry(gz: Buffer, entryPath: string): Buffer {
    return extractTarEntry(gunzipSync(gz), entryPath);
}

/** 一个头解析出来的语义（供主循环按种类推进，保持主循环低复杂度）。 */
type TarEntry =
    | { readonly kind: "longname"; readonly payload: Buffer; readonly nextOffset: number }
    | { readonly kind: "pax"; readonly payload: Buffer; readonly nextOffset: number }
    | { readonly kind: "skip"; readonly nextOffset: number }
    | {
          readonly kind: "regular";
          readonly headerName: string;
          readonly prefix: string;
          readonly data: Buffer;
          readonly nextOffset: number;
      };

/** 跨条目携带的待续名字（PAX / GNU LongName 都是给「紧邻的下一个真实条目」用的）。 */
interface PendingNames {
    longName: string | undefined;
    paxPath: string | undefined;
}

/** 同 {@link extractTarGzEntry}，但入参是已解压的 tar（测试可绕过 gzip）。 */
export function extractTarEntry(tar: Buffer, entryPath: string): Buffer {
    const pending: PendingNames = { longName: undefined, paxPath: undefined };
    let offset = 0;
    while (offset + BLOCK <= tar.length) {
        const entry = readTarEntry(tar, offset);
        if (entry === null) {
            break; // 归档结束标记
        }
        const data = applyEntry(entry, pending, entryPath);
        if (data !== undefined) {
            return data; // 命中即返回，不再扫剩余块
        }
        offset = entry.nextOffset;
    }
    throw new Error(`tar 内找不到条目：${entryPath}`);
}

/** 按条目种类推进状态；命中目标返回内容，否则返回 undefined。 */
function applyEntry(entry: TarEntry, pending: PendingNames, entryPath: string): Buffer | undefined {
    if (entry.kind === "longname") {
        pending.longName = readCString(entry.payload, 0, entry.payload.length);
        return undefined;
    }
    if (entry.kind === "pax") {
        pending.paxPath = parsePaxPath(entry.payload) ?? pending.paxPath;
        return undefined;
    }
    const name = resolveEntryName(entry, pending);
    if (entry.kind === "regular" && name === entryPath) {
        return entry.data;
    }
    return undefined;
}

/**
 * 解析条目完整名并消费待续名字。目录/链接等非普通条目也会消费——
 * 否则一个「pax 头 + 符号链接」会让名字错挂到下一个文件上。
 */
function resolveEntryName(entry: TarEntry, pending: PendingNames): string | undefined {
    const pendingName = pending.paxPath ?? pending.longName;
    pending.paxPath = undefined;
    pending.longName = undefined;
    if (pendingName !== undefined) {
        return pendingName;
    }
    if (entry.kind !== "regular") {
        return undefined;
    }
    return entry.prefix === "" ? entry.headerName : `${entry.prefix}/${entry.headerName}`;
}

/** 读一个 512 字节头并分类；返回 null 表示遇到结束零块。 */
function readTarEntry(tar: Buffer, offset: number): TarEntry | null {
    const header = tar.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) {
        return null;
    }
    verifyChecksum(header, offset);

    const typeflag = String.fromCharCode(header[OFF_TYPEFLAG] ?? 0);
    const size = readOctal(header, OFF_SIZE, 12, "size", offset);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
        throw new Error(`tar 条目越界（offset=${offset}，size=${size}）：归档被截断？`);
    }
    const nextOffset = dataStart + padToBlock(size);
    const payload = tar.subarray(dataStart, dataEnd);

    if (typeflag === TYPE_GNU_LONG_NAME) {
        return { kind: "longname", payload, nextOffset };
    }
    if (typeflag === TYPE_PAX) {
        return { kind: "pax", payload, nextOffset };
    }
    if (typeflag !== TYPE_REGULAR && typeflag !== TYPE_REGULAR_LEGACY) {
        return { kind: "skip", nextOffset }; // 目录 '5' / 链接 '1''2' / 'K' 等
    }
    return {
        kind: "regular",
        headerName: readCString(header, OFF_NAME, NAME_LEN),
        prefix: readCString(header, OFF_PREFIX, PREFIX_LEN),
        data: payload,
        nextOffset,
    };
}

/** 全零块 = 归档结束标记。 */
function isZeroBlock(block: Buffer): boolean {
    for (let index = 0; index < BLOCK; index += 1) {
        if (block[index] !== 0) {
            return false;
        }
    }
    return true;
}

/**
 * 校验 tar 头 checksum：把 chksum 字段视为 8 个空格后累加全部 512 字节。
 * 部分实现用 NUL 填充该字段，故两种口径都接受。
 */
function verifyChecksum(header: Buffer, offset: number): void {
    const stored = readOctal(header, OFF_CHKSUM, 8, "checksum", offset);
    let spaces = 0;
    let zeros = 0;
    for (let index = 0; index < BLOCK; index += 1) {
        const byte = index >= OFF_CHKSUM && index < OFF_CHKSUM + 8 ? 0x20 : (header[index] ?? 0);
        spaces += byte;
        const zeroByte = index >= OFF_CHKSUM && index < OFF_CHKSUM + 8 ? 0 : (header[index] ?? 0);
        zeros += zeroByte;
    }
    if (stored !== spaces && stored !== zeros) {
        throw new Error(`tar 头 checksum 不符（offset=${offset}）：期望 ${stored}，实际 ${spaces}`);
    }
}

/** 八进制字段解析：前导空格/NUL 跳过，遇 NUL/空格结束；拒绝 base-256 与非法字符。 */
function readOctal(
    buffer: Buffer,
    start: number,
    length: number,
    field: string,
    offset: number,
): number {
    const first = buffer[start] ?? 0;
    if ((first & 0x80) !== 0) {
        throw new Error(
            `tar 头 ${field} 使用 base-256 编码（offset=${offset}）：超出本工具支持范围`,
        );
    }
    let value = 0;
    let seen = false;
    for (let index = start; index < start + length; index += 1) {
        const byte = buffer[index] ?? 0;
        if (byte === 0 || byte === 0x20) {
            if (seen) {
                break;
            }
            continue;
        }
        if (byte < 0x30 || byte > 0x37) {
            throw new Error(
                `tar 头 ${field} 含非法八进制字符 0x${byte.toString(16)}（offset=${offset}）`,
            );
        }
        value = value * 8 + (byte - 0x30);
        seen = true;
    }
    return value;
}

/** 定长字段 → 字符串（截到首个 NUL）。 */
function readCString(buffer: Buffer, start: number, length: number): string {
    const slice = buffer.subarray(start, start + length);
    const nul = slice.indexOf(0);
    const end = nul === -1 ? slice.length : nul;
    return slice.toString("utf8", 0, end);
}

/** 512 对齐后的数据段长度。 */
function padToBlock(size: number): number {
    const remainder = size % BLOCK;
    return remainder === 0 ? size : size + (BLOCK - remainder);
}

/**
 * PAX 记录解析：`<长度> <键>=<值>\n` 连续排列，长度含自身。
 * 只关心 path=（长路径），其余记录忽略。
 */
function parsePaxPath(data: Buffer): string | undefined {
    let offset = 0;
    let path: string | undefined;
    while (offset < data.length) {
        const space = data.indexOf(0x20, offset);
        if (space === -1) {
            break;
        }
        const length = Number.parseInt(data.toString("ascii", offset, space), 10);
        if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) {
            break; // 记录损坏：不再信任后续偏移
        }
        const record = data.toString("utf8", space + 1, offset + length - 1); // 去掉行尾 \n
        const equals = record.indexOf("=");
        if (equals > 0 && record.slice(0, equals) === "path") {
            path = record.slice(equals + 1);
        }
        offset += length;
    }
    return path;
}
