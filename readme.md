<div align="center">

<h1 id="kurobridge">
  <img src=".github/assets/wordmark.svg" alt="KuroBridge" width="380">
</h1>

**Minecraft 服务器 ↔ 社交平台群服互通 · 全量线服务端 —— Paper JAR + 内嵌 Node 业务核心 + `kurobridge-ws` WS 服务端**

<p>
  <sub>角色</sub> <code>WS 服务端（对端连入）</code>
  &emsp;<sub>协议</sub> <code>kurobridge-ws 0.4.0</code>
  &emsp;<sub>打包</sub> <code>embedded · external</code>
  &emsp;<sub>许可</sub> <code>MIT</code>
</p>

<p>
  <a href="#生态定位">生态定位</a> •
  <a href="#形态与进程模型">形态与进程模型</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="#文档导航">文档导航</a> •
  <a href="#english">English</a>
</p>

</div>

> [!NOTE]
> **品牌口径**：仓名 KuroAdapter，产品名 **KuroBridge**（ADR-030 品牌迁移后统一），本仓文档与代码标识均以产品名行文。\
> 全自研实现，以 MIT 分发；思路参考 HuHoBot 的「业务在机器人侧 + 自定义 WS 协议」，不含其任何代码（GPL-3.0 与 MIT 不兼容）。

---

## 生态定位

KuroBridge 是「MC 服务器 ↔ 聊天平台」双向互通产品线，本仓是其**全量线服务端**实现。各仓与协议的关系一眼看清：

```text
KuroBridge 生态（协议视角）
│
├─ 协议契约 SSOT · KuroProtocol（独立仓）
│    kurobridge-ws v0.4.0：zod schema + 对端规格书 + 16 份金样本
│    全部实现经 npm 依赖 @kuro-bridge/protocol ^0.4.0 消费
│
├─ MC 侧 · WS 服务端（对端主动连入，服务端不回连）
│    ├─ KuroAdapter（← 本仓）· 全量线：Paper JAR + 内嵌 Node 业务核心
│    └─ KuroAdapter-Pure · 纯净线：纯 Java Paper 插件
│
└─ 聊天侧 · WS 客户端（连入上述服务端）
     ├─ Adapter-koishi · 官方对端：koishi-plugin-kurobridge（Koishi v4 插件）
     └─ napukettoqq 等第三方对端
```

- **KuroBridge 永远是 WS 服务端**：只认一套自研协议 `kurobridge-ws`，不关心对端是谁；断线重连由对端自担。
- **协议只有一份**：帧名与字段以 KuroProtocol 的 zod schema 为准，本仓任何文件禁止手写消息类型。

## 身份卡

| 本仓负责 | 本仓不负责 |
| :--- | :--- |
| `kurobridge-ws` 服务端：握手、鉴权、心跳、帧收发与按频道分发 | 协议定义：SSOT 在 [KuroProtocol](https://github.com/Kuro-Bridge/KuroProtocol)，本仓经 npm 依赖消费 |
| 平台无关业务核心 `bridge/core`：频道绑定、聊天桥接、命令与查询转发 | 官方对端：`Adapter-koishi`（Koishi 插件）独立成仓开发（ADR-018） |
| JE / BE 平台薄壳：Paper、Fabric、LSE 已落地；Endstone 待真机联调 | 聊天平台适配：QQ / Telegram / Discord 等由对端侧机器人框架承担 |
| embedded / external 打包形态与 napuketto（0.1.20）内嵌 | 部署环境：MC 服务器本体、Java 运行时、对端框架由使用者自备 |

## 形态与进程模型

```text
kurobridge JAR（Java 薄壳）
│
├─ Java 薄壳：Bukkit 事件 / 命令 / 权限桥接 + Node 子进程看护（几百行模板代码）
│
└─ 内嵌 Node 子进程 → bridge/core（TS 业务核心 + kurobridge-ws 服务端）
     ├─ embedded 形态：打包内置 napuketto（开箱可扫码），默认关闭
     │                 config `embedded.napuketto.enabled: true` 开启
     └─ external 形态：不附带协议端，由 koishi-plugin-kurobridge 等对端连入
                       （`ws.port` 需固定端口）
```

- **embedded / external 不是架构差异，只是打包差异**（`embedded.napuketto.enabled` + `ws.port` 固定端口两个条件），两种形态运行同一套 Node 业务核心。
- 配置单一来源 `plugins/kurobridge/config.json`：缺失自动生成默认配置；`channels` / `admins` 保存即热效（embedded 轮询 2s，`/kurobridge reload` 亦可触发；LSE 无热载需重启）；`token` / `ws` 段改后重启。完整语义见 [配置参考](docs/reference/config.md)。

## 平台矩阵

| 家族 | 平台 | 状态 | 说明 |
| :--- | :--- | :--- | :--- |
| JE | **Paper** | 已实现 | 主形态：`kurobridge-0.1.0.jar`（shadowJar，内嵌 Node 与业务核心） |
| JE | **Fabric** | 已实现 | 首版 mod 壳（五事件对齐 Paper，chat / status 有登记差异） |
| JE | NeoForge | 预留 | 模块骨架就位（ADR-021） |
| JE | Velocity | 预留 | 模块骨架就位（ADR-021） |
| BE | **LeviLamina / LSE** | 已实现 | TS 薄壳（R2′ WS 回环），无热载，改配置需重启 |
| BE | Endstone | 已构建 | portable 层与 clang-cl dll 全绿，真机联调待排期 |

## 快速开始

### 构建

```bash
pnpm install
pnpm build:jar    # TS 构建 → 内嵌 → shadowJar → fabric remapJar
```

产物：`platforms/je/paper/build/libs/kurobridge-0.1.0.jar`，丢进 Paper 服务器 `plugins/`。

### 最小配置

`plugins/kurobridge/config.json`（缺失时自动生成；external 形态必须固定端口）：

```json
{
  "channels": ["123456789"],
  "token": "change-me",
  "ws": { "host": "127.0.0.1", "port": 25580 }
}
```

- `channels` 为 WS 协议端绑定的频道列表（去重保序）：游戏事件按此 fan-out，平台消息命中才进游戏。
- `token` 空串 = 不鉴权（配置了 `ws` 段会打 WARN）；协议为明文 WS，跨公网必须走隧道 / 反代 TLS 终结。
- 端口建议避开 25565（MC）与 25575（RCON）。

### 连入对端

- **Koishi**：安装 [koishi-plugin-kurobridge](https://www.npmjs.com/package/koishi-plugin-kurobridge)，`url` 填 `ws://<主机>:<端口>`，`token` 与本侧一致。
- **napukettoQQ**：TOML 段 `[accounts.kurobot]` 指向同一地址与令牌。
- 对端接入的握手 / 关闭码 / 帧语义完整规格见 [peer-guide](https://github.com/Kuro-Bridge/KuroProtocol/blob/main/docs/peer-guide.md)。
- 验证：对端日志出现握手成功与绑定快照；群消息进游戏、游戏内发言回群。

## 工程与门禁

```bash
pnpm check        # build 首环 + biome + tsc + lse typecheck + 文档门禁 + 版本对齐
pnpm test         # vitest（基线 247 用例 / 23 文件，见 docs/status.md）
pnpm check:all    # CI 三 job 本地合体
pnpm build:all    # 全平台产物
```

- **技术栈**：TS 7（Biome + 严格 tsconfig 全家桶）+ Java 薄壳（工具链 25 / 字节码 target 21，`-Xlint:all -Werror` + Spotless，ADR-015）+ Gradle 9.7。
- **依赖方向**：`bridge/core` 零 Node API、零框架（可跑 QuickJS）；平台薄壳不做协议；协议 SSOT 只经 npm 消费（ADR-031 / ADR-035）。
- 工程指南与依赖白名单见 [AGENTS.md](AGENTS.md)；决策台账 ADR-001~037 见 [docs/decisions.md](docs/decisions.md)，当前进度与债务见 [docs/status.md](docs/status.md)。

## 文档导航

| 想了解 | 先读 |
| :--- | :--- |
| 定位、拓扑、模块与红线 | [架构总览](docs/architecture/overview.md) |
| 启动、握手、转发、热载、看护与关停 | [运行时](docs/architecture/runtime.md) |
| core / embedded / JE / LSE / Endstone 模块 | [模块文档](docs/modules/bridge-core.md) |
| 配置字段语义 | [配置参考](docs/reference/config.md) |
| 协议消费方式 | [协议参考](docs/reference/protocol.md) |
| 开发与构建发布流程 | [开发指南](docs/guides/development.md) · [构建与发布](docs/guides/build.md) |
| 全部文档索引 | [文档中心](docs/README.md) |

---

## English

KuroBridge (repo name `KuroAdapter`) is the **full-line server** of a Minecraft ↔ chat-platform bridge: a Paper JAR whose Java thin shell supervises an embedded Node.js subprocess running the TypeScript business core and the `kurobridge-ws` WebSocket server. Peers — the official Koishi adapter, napukettoQQ, or third-party implementations — connect in as WS clients. Protocol definitions live in the sibling repo [KuroProtocol](https://github.com/Kuro-Bridge/KuroProtocol) and are consumed via `@kuro-bridge/protocol`; handwritten message types are forbidden.

```bash
pnpm install && pnpm build:jar
```

*Entirely original implementation, released under the [MIT License](./LICENSE).*
