# 变更日志

本文件按版本记录对外可见变更。设计裁决见 [docs/decisions.md](docs/decisions.md)，现状与已知缺口见 [docs/status.md](docs/status.md)。

## 未发布

- Paper 适配模块收敛（ADR-043）：撤销 `:paper-legacy` 隔离层，`PlainText` 收敛为 `PlainTextComponentSerializer` 单路径（adventure 4.8.0+ 至 5.x 全覆盖，原回退分支在支持矩阵上无可触发版本）。产物形态与运行行为不变。
- 内嵌 Node 升 **26.13.0**（Active LTS），版本 SSOT 收敛到 `toolings/runtime-manifest.json`，新增 `check-runtime-versions` 七点门禁（ADR-044）。原「回退 Node 24 LTS」方案作废。
- **单 JAR 内嵌三平台运行时**（`win-x64` / `linux-x64` / `linux-arm64`）：embedded 清单升 `schemaVersion: 2`，运行期只解当前平台那一个二进制；`KUROBRIDGE_EMBED_TARGETS` 支持 Lean 构建（ADR-045）。
- **Linux 原生部署（JE）**：平台检测、POSIX 幂等 `+x`、`node --version` 预检 + glibc/`GLIBCXX` 识别 + PATH 回退（不崩服）；CI 增三平台原生冒烟矩阵（ADR-046）。
- 发布流程：`release.ts` 支持 `--only jar|lse|endstone` 分片；新增 `release.yml`（tag 触发，分片构建 + 对上传字节重算 `SHA256SUMS.txt`）。
- 产物体积：Universal JAR 约 **147 MB**（原 ~48 MB，三平台运行时合计）；`KUROBRIDGE_EMBED_TARGETS=<平台>` 的 Lean 构建可回到单平台体积。
- 已知限制更新：Linux 真机起服未验收；Endstone 仍仅 Windows（POSIX 移植另开迭代）；Alpine / musl 不在支持面。

## 1.0.0 — 2026-10-26

首个公开发布。Paper 为正式产物，Fabric 同版发布；LSE 与 Endstone 以预览件提供。

### 发布物

- `kurobridge-1.0.0.jar`：Paper universal 单 JAR，覆盖 1.12.2 ~ 26.3（Java 8 字节码）。
- `kurobridge-fabric-1.0.0.jar`：Fabric 1.21.4 薄壳。
- `kurobridge-lse-1.0.0.zip`：LeviLamina / LSE 适配（预览）。
- `kurobridge-endstone-1.0.0.zip`：Endstone 适配（预览）。
- `SHA256SUMS.txt`：四件产物的 sha256。

### 核心能力

- 双向聊天、进服/退服/死亡事件、状态快照。
- 频道绑定 fan-out、群管理员映射与群指令执行。
- token 鉴权、主版本协商、未知帧容忍、心跳与空闲检测。
- 配置热载（embedded 轮询 + `/kurobridge reload`）。
- 内嵌形态自带 Node 26.7.0 与 napuketto 0.2.0，扫码即用；external 形态固定端口接入。

### 本版主要变更

- 配置面 JSONC（ADR-040）：`config.jsonc` 支持行/块注释与行尾逗号；首启生成带注释模板并写入 32 位 hex 随机 token；旧 `config.json` 回退读取、不迁移。
- onboarding 与退出码契约（ADR-041）：`embedded.napuketto.qq/logLevel` 上浮主配置；连接参数按内嵌 CLI 版本注入（0.3.0+ 用 `NAPKETTO_CONFIG_JSON`，旧版回退 `NAPKETTO_CONFIG` + WARN）；Node exit 0/1/2，看护器对 exit 2 只记一条 SEVERE 且不重启；上游 exit 78 映射为 2。
- Paper universal 单 JAR（ADR-038）：`:core` / `:paper` / `:paper-legacy` 降至 Java 8 字节码，经典 `plugin.yml`，运行期兼容链覆盖 1.12.2 ~ 26.3。
- napuketto 0.2.0（ADR-039）：single-line 日志、停止哨兵优雅关停、树杀兜底。
- 控制台日志治理：IPC 前缀剥离、多行与 ANSI 记录重组、遥测噪音降级、二维码折叠。
- 发布打包（ADR-042）：`pnpm release:pack` 产出四类分发包与 `SHA256SUMS.txt`，打包期校验嵌入清单 sha256 与闭源件红线。

### 兼容性

- 协议 `kurobridge-ws` 0.4.0（子协议 `kurobridge-ws.v1`）；对端可为 koishi-plugin-kurobridge 或其它协议实现。
- Paper：Java 8+ 运行时；1.12.2 与 1.13 ~ 1.16.4 未上机（字节码与 API 层已覆盖）。
- Fabric：MC 1.21.4 / loader 0.19.5 / fabric-api 0.119.4。
- 内嵌 Node 仅 win-x64；其它平台使用 external 形态或自备 Node。

### 已知限制

完整清单见 [docs/status.md](docs/status.md)，发布相关重点：

- LSE / Endstone 真机联调未完成，分发包标注预览。
- 内嵌 napuketto 0.2.0 不支持内联注入，走 `NAPKETTO_CONFIG` 回退并提示 WARN；升级到 0.3.0+ 后转为宿主托管。
- 上游 0.2.0 配置校验失败返回 1（非 78），占位 qq 会走三次退避后放弃。
- JAR 约 48 MB；协议不内置 TLS，公网部署需隧道或反向代理。
