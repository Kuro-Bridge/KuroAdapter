# kurobridge-ws 对端接入指南（已移交 KuroProtocol 仓）

> **本文件已退位为迁移指针（2026-09-16，ADR-031）**：跨仓库契约的权威版本在姊妹仓
> **KuroProtocol**，本仓不再维护协议正文（本文件原正文停留于 0.3.1 时点，且与 0.4.0
> 改名存在版本行漂移——漂移历史见 KuroProtocol `docs/changelog.md` 勘误节）。
>
> 对端实现请一律以下列唯一来源为准：
>
> | 契约 | 权威来源 |
> |---|---|
> | 接入规格（本文的权威版） | KuroProtocol `docs/peer-guide.md`（GitHub: <https://github.com/Oppenheymu/KuroProtocol/blob/master/docs/peer-guide.md>） |
> | 帧名与字段 SSOT（zod schema） | KuroProtocol `src/`（发布名 `@kuro-bridge/protocol`） |
> | 版本 SSOT | KuroProtocol `src/meta.ts` 的 `PROTOCOL_VERSION`（演进记录见其 `docs/changelog.md`） |
> | 金样本夹具（物理契约） | KuroProtocol `fixtures/v<版本>/`（格式见其 `docs/fixtures.md`） |
>
> 工作区内的相对路径：`../../KuroProtocol/docs/peer-guide.md`。本仓 `bridge/protocol/src/`
> 是该 schema 的只读镜像（`pnpm check:protocol` 门禁校验字节级一致）。
