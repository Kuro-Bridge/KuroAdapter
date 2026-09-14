# 改名实录（RENAME-NOTES）——KuroBot → KuroBridge / @kuro-bridge

> 任务书 `docs/RENAME-PROMPT.md`（唯一指令来源）；映射表与 breaking 说明见 **ADR-030**。
> 决策编号 R-01 起（R-00 = 用户四拍板）。历史册（DECISIONS.md 既有 ADR、各 *-PROMPT.md、
> 各 *-NOTES.md）正文一律不改写。

## R-00 用户四拍板（2026-09-14 开题对齐，任务书原文）

1. npm scope `@kurobot/*` → **`@kuro-bridge/*`**（与 GitHub 组织 Kuro-Bridge 一致）。
2. 面向用户标识统一 **`kurobridge`**：MC 命令 `/kurobridge`、数据目录 `plugins/kurobridge/`、
   插件名 KuroBridge、Java 包 `com.kurobridge`、JAR `kurobridge-0.1.0.jar`。
3. WS 子协议 **`kurobot-ws.v1` → `kurobridge-ws.v1`**，协议 0.3.1 → **0.4.0**（breaking：
   握手协商字符串变更；`.v1` 大版本不变，帧形状零变化）。
4. **含两仓联动**：本册为主册（KuroAdapter 仓执行）；§7 联动册（NapukettoQQ 仓）单独拿到
   对方会话执行。

## 决策（执行者拍板，R-01 起）

（随阶段推进回填）

## 验收实录（任务书 §4 对照）

（阶段 7 回填）
