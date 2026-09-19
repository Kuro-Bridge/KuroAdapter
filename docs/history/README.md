# 历史册归档（docs/history/）

> 2026-09-15 归档。已完成阶段的任务书（*-PROMPT.md）与执行实录（*-NOTES.md）移入本目录，
> **正文一律不改写**；决策与现状速查看 [`../DECISIONS.md`](../DECISIONS.md)（ADR 台账）与
> [`../STATUS.md`](../STATUS.md)。
>
> **路径口径**：各册正文写于归档前，文中 `docs/X-PROMPT.md`、`docs/protocol/draft-v0.1.md`
> 等相对路径均指本仓归档前的位置（如 `docs/RENAME-PROMPT.md` 即本目录的
> `RENAME-PROMPT.md`）。册间互引同样按旧路径理解。

## 阶段索引（按执行顺序）

| # | 阶段 | 时间 | 任务书 | 实录 | 结论 | 提交链 |
|---|---|---|---|---|---|---|
| 0 | 设计定稿 + 仓库骨架 | 2026-08-10~11 | —（architecture.md 即设计书） | —（ADR-001~021 直接入 DECISIONS.md） | 架构/工具链/红线定稿 | 8def9fd → 2d846b7 |
| 1 | 原型机（prototype/spike 分支） | 2026-09-12~13 | [PROTOTYPE-PROMPT.md](PROTOTYPE-PROMPT.md) | [PROTOTYPE-NOTES.md](PROTOTYPE-NOTES.md)（D-01~15） | 端到端命题成立；候选 A~E 转正为 ADR-022~025 | spike f86d22c → d50687f，merge 1091d1f |
| 2 | MVP-1 业务最小闭环 | 2026-09-13 | [MVP1-PROMPT.md](MVP1-PROMPT.md) | [MVP1-NOTES.md](MVP1-NOTES.md)（M-01~20） | 协议 0.2；绑定表 + 转发规则 + join/leave/status | c77bea9 → 48f810b |
| 3 | MVP-2 打包闭环 | 2026-09-13 | [MVP2-PROMPT.md](MVP2-PROMPT.md) | [MVP2-NOTES.md](MVP2-NOTES.md)（M2-01~11） | JAR 自含 node.exe（41MB）；embed.ts + EmbeddedRuntime | ed456dc → 51051dd |
| 4 | DEBT-2 进程健壮性（与 DEBT-1 并行，先完成） | 2026-09-13 | [DEBT2-PROMPT.md](DEBT2-PROMPT.md) | [DEBT2-NOTES.md](DEBT2-NOTES.md)（D2-01~10） | 协议 0.2.1；看护器退避重启 + PID 文件 + 双壳构建 | 2e282b9 → 78e6797 |
| 5 | DEBT-1 协议/业务清偿（先让行后复跑） | 2026-09-13 | [DEBT1-PROMPT.md](DEBT1-PROMPT.md) | [DEBT1-NOTES.md](DEBT1-NOTES.md)（D1-01~06） | 协议 0.3.0；token/协商/command/query/death/管理员映射 | 941e5d7（让行）→ 25073d7 |
| 6 | MVP-3 external 接入基座 | 2026-09-13 | [MVP3-PROMPT.md](MVP3-PROMPT.md) | [MVP3-NOTES.md](MVP3-NOTES.md)（M3-01~10） | 协议 0.3.1；config ws 段 + 对端指南 peer-guide.md | 4c016ed → ad8d54f |
| 7 | MVP-4 embedded 真身 | 2026-09-14 | [MVP4-PROMPT.md](MVP4-PROMPT.md) | [MVP4-NOTES.md](MVP4-NOTES.md)（M4-01~12） | JAR 48.5MB 内嵌 napuketto（四层进程树 + QR 交接，ADR-029） | 83b3310 → ee74f50（+ M4-11/12 见 d9028de） |
| 8 | 改名 KuroBot → KuroBridge | 2026-09-14 | [RENAME-PROMPT.md](RENAME-PROMPT.md) | [RENAME-NOTES.md](RENAME-NOTES.md)（R-00~06 + 验收表） | 协议 0.4.0 breaking；全链标识换新（ADR-030） | 75107a0 → 8ab0ca8 |

> 提交链为「任务书入库 → 阶段收尾」的起止哈希，中间提交见 `git log`。
> 各册末尾的债务清单是跨阶段债务的第一手来源；跨册汇总视图见 [`../STATUS.md`](../STATUS.md) 债务索引。

## draft-v0.1.md（协议历史草案）

[kurobridge-ws 协议草案](draft-v0.1.md)不是阶段册，是最早的协议设计说明（v0.1 设想 +
原型 §5 + v0.2 §6 增量，**停在 2026-09-13，未随 0.3.x/0.4.0 演进**）。仅供考古：

- 现行协议语义与逐帧字段表 SSOT → 姊妹仓 KuroProtocol 的 `docs/peer-guide.md`
  （本仓 [`../protocol/peer-guide.md`](../protocol/peer-guide.md) 已退位为迁移指针，ADR-031）。
- 协议 schema 与版本史 → KuroProtocol 仓 `src/`（zod SSOT；版本演进见其 `docs/changelog.md`；
  本仓 `bridge/protocol/` 只读镜像已于 2026-09-18 随 ADR-031 阶段 2 / ADR-035 退役删除，
  协议现经 npm 依赖 `@kuro-bridge/protocol` 消费）。
- ADR-023/025 引用的「§5.1 单程握手」等语义条目仍以本草案 §5 为准（历史文本）。
