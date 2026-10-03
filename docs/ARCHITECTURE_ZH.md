# Copilotix Desktop P0/P1 架构基线与二次开发指南

> 本文是 Desktop 当前 P0/P1 架构的权威边界。它描述已经在源码和测试中存在的契约，也明确哪些能力尚未实现。若本文与代码冲突，以当前代码、运行时 schema 和测试为准；修复冲突时先记录证据，再由负责公共边界的 Agent 更新文档。

## 1. 基线与范围

| 项目 | 当前基线 |
|---|---|
| 适用分支 | `refactor/p0-p1-architecture` 的 P0/P1 架构线 |
| Desktop 版本 | `1.0.0` |
| Electron | `44.1.1` |
| Node.js | `24.19.0`（`.node-version` 与 CI 一致） |
| pnpm | `11.19.0` |
| 支持目标 | Windows x64 Setup 安装版与 ZIP 免安装版；其他平台未接入发布验收 |
| 本地应用数据目录 | `%APPDATA%\Copilotix-Translation-v2`（Electron `userData`） |
| 数据库文件 | `copilotix-desktop-v2.sqlite3`，位于上述 `userData` 目录 |
| 结果目录 | `<outputRoot>\documents-v2\{documentId}`；`documentId` 为 UUID |
| 当前产品能力 | Parser API 解析、Markdown/表格翻译、PDF 与 Markdown 阅读、映射和阅读标注、可恢复作业与验证发布 |
| RAG | 尚未实现；见第 10 节和 `RAG_DEVELOPMENT_PLAN_ZH.md` |

本文只讨论 `desktop/` 运行时。Desktop 连接 MinerU 在线 v4 API，不依赖 Python CLI 或本地解析模型。旧 Python 引擎和 Docker 配置已从当前 master 工作树移除。

## 2. 权威架构图

```text
Renderer（React；sandbox、无 Node）
        │ 仅调用 window.copilotix
        ▼
Preload（contextBridge；每个请求/响应用 Zod 验证的领域 API）
        │ Electron IPC，sender/主 frame/来源校验
        ▼
Main（权限与协调；Electron net、Credential Vault、作业调度、Provider）
        │ Core RPC：version/requestId/operation/payload，JSON，≤ 1 MiB
        ▼
Utility Process（受监督；SQLite 与 compute 的唯一拥有者）
        ├─ node:sqlite DatabaseSync、STRICT schema、迁移、Repository
        ├─ 文件 hash/copy、解析产物归一化、映射与翻译计划
        └─ 流式/原子 artifact 文件操作
```

边界原则如下：

1. Renderer 只看到最小的领域 API 和公开 DTO，不能接触 `ipcRenderer`、Node、文件系统、SQLite、Token、API Key 或任意网络地址。
2. Preload 是唯一的特权桥。它对传入参数和返回 envelope 做运行时验证，不能退化成通用 `send`/`invoke` 包装器。
3. Main 是权限、网络、凭证和流程协调层。它不持有 SQLite 连接，也不在事件循环中执行大文件、Markdown AST 或重型计算。
4. Utility 是 SQLite 和 compute 的进程内拥有者。Main 通过异步 Core RPC proxy 访问它；Utility 崩溃时由 supervisor 重新启动并重新初始化数据库。
5. 文件内容、PDF、ZIP、完整 Markdown、HTML、Buffer、TypedArray 和 stream 不通过 RPC 搬运；跨进程只传受限 JSON、路径/作业/产物标识及小型结果。
6. 所有跨边界数据都必须有明确 schema、最大尺寸、错误码和取消/超时语义；没有“先传过去再由另一端猜测”的隐式契约。

## 3. 代码地图

| 路径 | 权威职责 | 边界 |
|---|---|---|
| `desktop/src/renderer` | React 页面、阅读器、视图状态和选区 | 只能使用 `window.copilotix` |
| `desktop/src/preload` | `contextBridge` API、IPC 编解码 | 只能暴露显式领域方法 |
| `desktop/src/main/index.ts` | Electron 生命周期、窗口、组装、IPC 注册、托盘 | 不直接持有数据库连接 |
| `desktop/src/main/ipc.ts` | sender/frame/URL 校验、IPC envelope 和 schema 驱动 handler | 所有新增 IPC 必须经过此层 |
| `desktop/src/main/utilitySupervisor.ts` | Utility 启动、ready、超时、重启、drain/shutdown | 正常应用的 Utility 生命周期入口 |
| `desktop/src/main/*Runner.ts`、`jobScheduler.ts` | parse/translate 作业执行与调度 | 只能通过 JobRepository/Compute port 改状态 |
| `desktop/src/main/parserClient.ts`、`translation/` | 官方 API、翻译 Provider、网络重试 | Token/Key 只在 Main/Vault 侧 |
| `desktop/src/utility` | Utility 进程入口、RPC loop、SQLite 与 compute handler | 不导入 renderer、credential 或网络 adapter |
| `desktop/src/utility/core/persistence` | v2 数据库、Repository、Job、PathPolicy | 数据库连接只在 Utility |
| `desktop/src/utility/core/compute` | 导入、hash、解析归一化、映射和翻译计划 | 通过受限 Core operation 调用 |
| `desktop/src/shared` | IPC/Core RPC schema、DTO、纯函数和版本常量 | 是跨层契约的单一来源 |
| `desktop/tests` | Vitest 单元/集成/契约/质量门禁 | 不等同 GUI E2E |
| `desktop/e2e` | Playwright Electron 场景 | 只能在具备原生 Renderer/GPU 条件的环境运行 |
| `desktop/scripts` | bundle smoke、发布审计、原子发布和 packaged smoke | 不得被普通测试当作清理脚本调用 |

四个构建 bundle 分别来自 `main`、`preload`、`renderer`、`utility`，输出到 `desktop/out/`；测试和输出目录不属于源码契约。

## 4. Electron 与安全边界

### 4.1 Renderer 窗口

主窗口明确使用：

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- `webSecurity: true`
- 固定 preload、禁止未经允许的窗口打开

IPC handler 会同时验证来源窗口是当前主窗口、请求来自主 frame，且 URL 与开发 origin 或打包后的 renderer `index.html` 完全匹配。窗口、对话框和文件导入都必须经过 Main 的领域方法；Renderer 不得把本地绝对路径加入 renderer-visible contract。

### 4.2 Preload API

当前公开 API 是 `window.copilotix` 的显式方法集合：设置与连接测试、文档导入/列表/重试/删除/详情、输出打开/另存、阅读标注、窗口状态和事件订阅。每个方法在 `desktop/src/preload/index.ts` 中绑定固定 channel、请求 schema 和响应 schema。

新增方法必须同时更新：

1. `desktop/src/shared/ipcSchemas.ts` 的请求/响应/事件 schema；
2. `desktop/src/shared/types.ts` 的公开 DTO/API；
3. preload 的显式方法；
4. Main 的 `registerValidatedHandler` 或 `sendValidatedEvent`；
5. 不可信请求、sender、响应和错误 envelope 测试。

不得暴露 `ipcRenderer`、任意 channel、数据库查询、任意文件读取、Credential Vault 或可注入 URL 的网络代理。

### 4.3 凭证和日志

Copilotix Token、Qwen/DeepSeek API Key 由 Main 的 Credential Vault 管理（Windows 使用 `@napi-rs/keyring`/Credential Manager）；SQLite 只保存公开设置及 `hasKey`/`hasToken` 布尔状态。Renderer 只得到布尔状态，不得到密钥。

日志要使用分类字段和脱敏值，不记录 Token、API Key、Authorization、完整预签名 URL、论文正文、查询全文、embedding 或本地敏感路径。错误向 Renderer 暴露稳定 code/message/traceId，不回传堆栈和凭证。

## 5. IPC 与 Core RPC 契约

### 5.1 Renderer IPC envelope

Renderer ↔ Main 的响应和事件使用严格 envelope：

```ts
{ ok: true, value: T }
{ ok: false, error: { code, message, retryable, traceId? } }
```

Main 先验证 sender，再解析请求；handler 结果再次验证，schema 失败使用 `INVALID_REQUEST` 或 `INVALID_RESPONSE`，未捕获领域错误使用带 traceId 的 handler error。事件也必须用相同成功 envelope，Preload 不接受无法验证的数据。

### 5.2 Main ↔ Utility Core RPC

`desktop/src/shared/coreRpcSchemas.ts` 是 Core RPC 的唯一来源：

| 项目 | 当前值/要求 |
|---|---|
| 协议版本 | `CORE_RPC_VERSION = 1` |
| request | `version`、UUID `requestId`、固定 `operation`、严格 `payload` |
| response | 同版本、同 requestId、`ok` 成功/失败判别联合 |
| event | `ready`、`drained`、`shutdown`、`error` |
| 数据 | 仅有限 JSON；拒绝 Buffer、ArrayBuffer、TypedArray、循环引用和不可序列化值 |
| 尺寸 | payload 与 envelope 的 UTF-8 序列化结果均不得超过 `1 MiB` |
| 取消 | `cancel` 以 requestId 取消活动 operation，并传播 AbortSignal |
| 超时 | supervisor/CoreClient 默认 handshake `10s`、request `30s`；调用者可传更短的 operation timeout |

当前 registry 已覆盖 `database:*`、`settings:*`、任务/文档、作业、artifact、翻译 block/cache/plan、标注以及有限 compute 操作。增加 operation 必须添加严格 payload/result schema、registry 项、两端 handler、取消/超时测试，并评估 1 MiB 上限。

### 5.3 Utility supervisor

Supervisor 启动 Utility 后等待 `ready`，再以 `database:init` 初始化 v2 数据库和 output root；Utility 异常退出会拒绝所有 in-flight RPC 并按 `[250ms, 1s, 4s]` 退避重启，连续失败最多三次，随后进入 failed。请求超时/取消只影响对应请求，并向 Utility 发 cancel；不会复用已结算的 requestId。关闭时执行 scheduler shutdown、drain、database flush/close，超时后才终止子进程。

Utility 端拒绝新工作后等待活动作业，再 flush/close；任何 close、restart 或 stale response 都不能让旧连接与新连接并存。重启后所有 repository/plan proxy 必须重新绑定，作业状态以 SQLite 为准。

### 5.4 卸载维护模式

安装目录中的 NSIS `uninstall.exe` 默认保留个人数据；只有交互卸载勾选清除选项时，才调用已安装程序的 `--copilotix-uninstall-cleanup` 模式。该模式取得相同 userData 的单实例锁，不启动 Renderer、任务队列、网络服务或数据库 migration。Main 负责第二次原生确认与 Credential Vault；独立 Utility 入口 `uninstall-cleanup.js` 只读数据库生成文档目录清单，并在确认后验证清单未变、执行受限删除。SQLite 仍只属于 Utility。取消或清理失败使卸载停止并保留程序；自动升级／静默卸载不触发清理。外部原始文件、共享根目录其他文件、外部备份与迁移保留的旧库不属于删除范围。详见 [安装、升级与卸载](WINDOWS_INSTALLATION_ZH.md)。

## 6. v2 持久化与路径

### 6.1 目录布局

应用启动时将 Electron `userData` 设置到 `Copilotix-Translation-v2`。Utility bootstrap 收到绝对 `databasePath` 和 `outputRoot`，并在 Utility 内创建：

```text
%APPDATA%\Copilotix-Translation-v2\
  copilotix-desktop-v2.sqlite3
  copilotix-desktop-v2.sqlite3-wal
  copilotix-desktop-v2.sqlite3-shm

<outputRoot>\
  documents-v2\
    {documentId}\
      original.pdf
      full.md
      full.zh-CN.md
      layout.json
      block_list.json
      content_list.json       # 若官方结果提供
      images/ ...              # 若官方结果提供
      translation.*            # 内部恢复/manifest 文件
```

当前新文档路径是 `<outputRoot>/documents-v2/{documentId}`，不使用文件名作为根目录。`original.pdf` 是导入后的规范源文件；`documentId` 是唯一 UUID，目录不可由 Renderer 指定。旧兼容 DTO 中的 `sourcePath`/`outputDir` 只在 Main 内部和兼容 adapter 使用，新的 document IPC 不暴露本地路径。

### 6.2 STRICT schema 与迁移纪律

`desktop/src/utility/core/persistence/v2Database.ts` 用 `node:sqlite` 的 `DatabaseSync`，开启 WAL 与 foreign keys。连接属于 Utility，不属于 Main。当前 schema 使用 STRICT 表并包含：

- `settings`：JSON 公开设置；
- `documents`：来源名、标题、storage path、checksum、解析/翻译配置；
- `jobs`、`job_events`：持久化作业状态、依赖、lease、checkpoint、事件序号；
- `artifacts`：按 document/kind/revision 的不可变产物引用和 hash；
- `translation_blocks`、`translation_cache`：翻译 block、来源 hash、provider/model 和缓存；
- `annotation_sets`、`reader_annotations`：按 artifact/view 隔离的阅读标注。

`schema_migrations` 保存 `version/name/checksum/applied_at`。迁移版本必须从 1 连续递增；每一条迁移在事务中执行；已应用版本的 name 或 SHA-256 checksum 变化必须拒绝启动。禁止在启动时猜测列、静默 `ALTER TABLE`、覆盖历史迁移或把 RAG 表偷偷混入 P0/P1 schema。未来新增表必须有显式 migration、空库路径、现有 v2 库升级、checksum mismatch、失败回滚和重复启动测试。

### 6.3 PathPolicy

Main 和 Utility 各有对应 `PathPolicy` port/实现。任何相对 artifact、导入目录、asset URL 或删除目标都必须：

1. 拒绝 NUL、绝对跨平台路径和 `..` 段；
2. 先做 lexical containment，再做 realpath containment；
3. 拒绝穿越 root 的符号链接、非普通文件和目录；
4. 只接受允许的 artifact 相对路径和当前 document root；
5. 对 Windows 与 POSIX 路径都运行纯函数边界测试。

`copilotix-asset://{documentId}/...` 由 Main 解析并通过 PathPolicy 解析到该 document 的已允许子路径；sandbox Renderer 不获得文件系统权限。

## 7. Durable jobs 与工作流

### 7.1 作业模型

当前作业类型为 `parse` 和 `translate`。`jobs` 保存 queued/running/retry-wait/succeeded/partial/failed/cancelled、progress、priority、attempt/maxAttempts、payload、checkpoint、availableAt、leaseOwner/leaseExpiresAt、错误和时间戳；`job_events` 记录带序号的状态变化。每个 document 的 active parse/translate 作业有唯一约束，translate 可依赖 parse。

Scheduler 从 Utility-owned JobRepository claim 作业，以 lease owner/expiry 防止重复 worker；运行中由 owner heartbeat 延长 lease，进度和 checkpoint 以 owner 条件更新。作业退出、Utility 重启或 lease 过期时恢复为 queued（未超过 retry 上限）或 failed；网络/超时/5xx 等可恢复错误使用退避，协议/输入错误不盲目重试。手动 retry 只允许 partial/failed/cancelled 等受限终态。

### 7.2 Parse

1. 用户选取或拖入 PDF，Main 校验扩展名和官方 `200MB` 上限；生产导入通过 Utility 一次流式读取、hash 和复制到 `original.pdf`，避免将完整文件经 IPC 搬运。
2. Parse runner 在 Main 通过官方 API adapter 申请上传、上传、轮询，并把远端 batch/data ID 和阶段写进 checkpoint。
3. 结果 ZIP 以受限流式方式下载到作业专属 partial 文件；解压到作业专属 staging，拒绝不安全归档条目。
4. Utility normalize 只发布受 PathPolicy 保护的 `full.md`、`layout.json`、可选 content list、图片和 `block_list.json`；产物发布完成且 hash 可验证后才写 `artifacts` revision。
5. 同作业恢复必须能识别已发布、hash 相同的文件，不重复破坏已有产物；解析成功后按依赖关系创建 translate job。

### 7.3 Translate

Utility-owned `MarkdownTranslationPlanManager` 读取受限的计划 descriptor，按 AST/表格逻辑单元列出工作，Main 只负责 provider 顺序、凭证、网络调用和小型 response JSON。翻译计划通过 jobId 绑定 block，cache 命中、apply/fail、checkpoint 和 finalize 都验证 document/job/unit 关系。

翻译响应写入 document 目录内的 `.translation/` partial 文件后原子替换；最终 `full.zh-CN.md`、`translation.checkpoint.json`、`translation.manifest.json` 和 artifact revision 要么形成一致版本，要么保留旧版本。`.translation/` 内部文件不进入结果 ZIP。翻译表格必须保持 cell 数量、顺序和协议版本；来源 hash、provider、model 不匹配时不可复用译文。

## 8. Artifact、流式写入和原子性

所有外部 ZIP、PDF、Markdown、JSON 和翻译响应都遵循相同的写入生命周期：

```text
受控 root + 文件名校验
  -> {job/document}.partial-* staging
  -> 流式写入/尺寸上限/hash
  -> fsync（文件，必要时目录）
  -> rename 到最终相对路径
  -> 校验最终文件
  -> 事务登记 artifact revision/hash
```

不得先登记数据库再发布文件，也不得在最终路径上原地拼接半成品。失败时保留可诊断的 staging（除非是临时导入回滚），旧的已发布 revision 仍可读。ArtifactService、translation plan writer、Utility normalize 和 result ZIP 都使用 PathPolicy；结果 ZIP 只包含允许的公开产物，不包含 `.translation`、Token、日志、数据库或内部 staging。

## 9. Parser API、Provider 与数据流

当前网络边界由 Main 持有：

- Parser API 使用 `desktop/src/shared/constants.ts` 中受控的固定来源与 v4 路径；Token 只发送到固定 API 请求；预签名上传/下载不带 Token；
- Qwen/DeepSeek 使用显式 base URL/model 和 Credential Vault；Bing/TranSmart 是可变的网页 Provider，不能视作稳定官方协议；
- provider 请求必须有 timeout、重试、状态/响应 schema、取消和安全日志；
- provider fallback 不得跨 document/job 混写状态，最终结果必须记录 provider/model；
- Renderer 不能直接请求任一 provider 或任意 URL。

解析结果的 `layout.json` 是保留的权威原始产物：设置中的视觉模型 `vlm` 当前对应 Copilotix `hybrid` 后端，标准模型对应 `pipeline` 后端。两者可能产生不同的段落切分、复合 image/chart/table block、`lines_deleted` 跨栏/跨页延续和 discarded block 数量，但都必须通过同一个 Core block-mapping 正规化器投影为版本化的 `block_list.json`；Main 与 Utility 不得各自维护不同算法。页面编号以 `layout.json` 的零基 `page_idx` 为准，Renderer 只把它显示为一基物理页码。

结果数据流是：

```text
PDF -> Utility 流式导入/hash -> v2 document/job
    -> Main 官方 API 上传/轮询/下载
    -> Utility staging/normalize/mapping artifact
    -> Main provider 调度 + Utility translation plan
    -> 原文/译文/布局/mapping/资产
    -> sandbox Reader（PDF、Markdown、标注）
```

## 10. RAG 状态与 Reader 选区边界

P0/P1 **没有实现 RAG**。当前代码中没有 chunk 生成、chunk 持久化、索引、embedding、vector store、SQLite FTS/FTS5、reranker、retrieval service、query backend 或 chat backend。现有 `ReaderChatSelection`/`ReaderChatSelectionFragment` 只是 Renderer 侧的类型化选区 payload，用于未来集成的输入形状；它没有 IPC channel、会话/消息表、模型调用、流式回答、引用校验或聊天历史。不要把“添加到对话”按钮或选区 payload 写成已支持聊天。

未来 RAG 必须依赖稳定 artifact/revision/mapping，而不是直接把 `BlockMapping.id` 当跨文档身份。具体端口、表、阶段、DoD 和隐私条件见 `RAG_DEVELOPMENT_PLAN_ZH.md`；在对应代码、migration、测试和评测合入前，所有 RAG 章节只能标记为 planned/proposed。

## 11. 公开 API 打包与 verified atomic release

Renderer 的公开 API 是 preload 暴露的 `window.copilotix`；它与四个 bundle 一起进入打包输入。`desktop/scripts/package-directory.mjs` 负责 Windows x64 目录版，发布顺序必须保持：

1. 只在仓库根目录精确的 `.release-next-{buildId}` staging 中构建；不得把 `desktop/out/` 当正式发布目录。
2. 校验 `main/preload/renderer/utility` bundle、独立 `uninstall-cleanup.js`、`app.asar` 必需 entry、`@napi-rs/keyring` unpack 路径、Electron locale、fuses、运行时文件以及体积上限（当前 `app.asar < 40 MiB`、运行目录 `< 360 MiB`、精简 ZIP `< 155 MiB`、Setup `< 180 MiB`）。
3. 以同一已验证运行目录生成 NSIS Setup 与 ZIP、`release-manifest.json` 和 `SHA256SUMS.txt`，并重新解压 ZIP 校验入口/ASAR/资源/哈希。正式构建验证主程序、Setup 与内嵌卸载器签章。
4. 启动已打包的 `Copilotix.exe --copilotix-packaged-smoke`，只接受精确 `COPILOTIX_PACKAGED_SMOKE_OK app=1.0.0 electron=44.1.1` marker 和空 stderr；该 smoke 是 CLI 启动检查，不创建 Renderer 窗口。
5. 所有审计、哈希和 smoke 成功后，才把现有 `release/` 原子换到 `.release-previous-{buildId}`，再把 next rename 为 `release/`；失败时恢复旧 release，并保留 staging 供诊断。

精简 Release ZIP 包含 Setup、注册安装卸载入口、安装说明及小型 payload 校验元数据。完整程序已嵌入 Setup；开发运行目录仅存在 `release-artifacts/<build-id>/program/`，不进入下载 ZIP。schema 5 的 distribution 为 compact-setup，runtime.embeddedIn 指明安装器；外层 runtimeArtifactDirectory 定位开发副本，runtime 内的目录与入口相对开发产物目录。外层 release-manifest 含 ZIP 哈希且不进 ZIP，内层 bundle-manifest 不含外部产物路径或自引用 ZIP 哈希。卸载入口仅交给已注册安装的卸载器。更新前退出托盘程序；userData 和 Credential Manager 不属于发布目录。

## 12. 测试、覆盖率与验证边界

### 12.1 当前质量门禁

`desktop/vitest.config.ts` 的 coverage gate 是实际配置，不是建议值：

| 指标 | 最低值 |
|---|---:|
| lines | 80% |
| statements | 80% |
| functions | 80% |
| branches | 75% |

覆盖统计 `src/main/**`、`src/core/**`、`src/shared/**`；明确排除 renderer、preload、utility、测试、生成目录、Main Electron bootstrap/utility fork 以及纯类型文件。CI 的 Desktop job 实际执行 `lint`、`typecheck`、`test:coverage`、`build:bundles`、`release:from-built` 和 `test:e2e`；任一质量门禁失败都不能称为发布通过。不要用一次本地单元测试结果代替 coverage gate。

单元/集成测试至少覆盖：Core RPC schema/1 MiB/超时/取消、sender/frame/URL、Utility ready/restart/drain、STRICT migration/checksum、Repository/lease/checkpoint/retry、PathPolicy/符号链接、流式导入与 atomic artifact、翻译 cache/表格协议、映射/标注以及 release transaction/manifest/fuse/packaged smoke。真实 API、真实翻译和真实 PDF 属于 opt-in fixture，不是所有 PR 的默认证据。

### 12.2 当前 Windows 环境记录

在当前 Windows build `26200` + GameViewer 环境，sandboxed Renderer/GPU 的原生启动失败；因此不能声称本机 GUI E2E 已通过，也不能把 GUI E2E 失败伪装成产品功能通过。专用 packaged CLI smoke 已通过，并且该 smoke 不启动 Renderer。

此环境事实不改变产品安全基线：不得为了本地通过而修改产品默认、发布配置或 CI 去降低 Renderer/GPU sandbox；不得把 `--disable-gpu-sandbox` 当作产品建议。GUI E2E 的通过证据必须来自具备原生条件的受控环境，并单独记录运行环境、构建和测试结果。

## 13. P0/P1 Definition of Done

| 里程碑 | 必须满足 |
|---|---|
| P0：边界与持久化 | Electron 44.1.1/Node 24.19.0 锁定；sandbox Renderer；最小 preload API；IPC/Core RPC schema、sender 校验、1 MiB、timeout/cancel/restart；Utility 独占 SQLite/compute；v2 userData/DB/`documents-v2/{documentId}`；STRICT migrations；PathPolicy；coverage gates 通过 |
| P1：可恢复工作流 | durable parse/translate jobs；lease/heartbeat/checkpoint/retry/recovery；Utility 流式导入、解析归一化和 translation plan；artifact hash/revision、fsync/atomic publish、结果 ZIP 排除内部文件；provider/credential 边界；verified atomic release 与 packaged CLI smoke |
| 文档基线 | 三份文档不把 RAG 目标写成实现；记录本机 GUI E2E 限制；公共 API/路径/错误/数据表变更有 owner、schema、测试和迁移说明 |

任何 DoD 未满足都只能标记为 partial/proposed，不能使用“已完成”作为发布结论。

## 14. 多 Agent 共改规范

这些文档和公共契约会被多个 Agent 共同参考，但共享参考不等于共享写入：

1. 开始工作前记录 `git status --short --branch`，确认当前分支和工作树；结束时再次记录。现有用户/Agent 改动属于他人，不能覆盖、回滚或顺手清理。
2. 一个工作项一个 owner；同一工作树同一时刻只允许一个 Agent 修改同一文件。需要并行实现时使用独立分支/worktree，集成时保留最小 diff。
3. `shared/*` schema、`preload/index.ts`、`main/ipc.ts`、`main/index.ts`、`v2Database.ts`、JobRepository、release scripts 是高风险公共边界；任何契约改动先更新 schema/测试，再更新本文件与 RAG 计划。
4. 实现 Agent 不得在不相干工作项中升级依赖、格式化全仓、修改许可证、清理 release、stash 或触碰其他 worktree。
5. 每项声明都要标注 `implemented`、`verified`、`planned` 或 `blocked`，并附源码/测试路径；本机未运行的 package/E2E 不得写成通过。
6. 迁移、公开 API、错误码、artifact 格式、job 状态、路径布局和安全设置属于权威边界；改动必须说明兼容策略、失败回滚和测试。
7. 文档只由负责该章节的 owner 更新；基线、公共契约、决策记录和总进度由集成 Agent 串行维护。

## 15. 已知后续事项

- Copilotix 自有代码已采用根目录 MIT 许可证，桌面 package 元数据同步为 MIT；第三方组件仍按各自许可分发。
- macOS/Linux 的 Credential Vault、原生 Renderer/GPU、路径、打包、签名/公证和 CI 尚未形成发布验收，不能从纯函数测试推断桌面发布可用。
- RAG 的 chunk/index/embedding/vector/FTS/reranker/retrieval/chat 仍需按独立计划实现，不得直接添加未经 migration 和隐私评审的表或 Provider。

## 16. 修改前后清单

### 修改前

- 找到对应 port、schema、handler、repository 和测试；确认是否跨 Main/Preload/Utility/Renderer 边界。
- 确认是否会改变 document path、artifact 格式、job 状态、公开 API、错误码或凭证流向；若会，先登记兼容和迁移方案。
- 对大文件、网络、SQLite、Utility 和 release 变更定义可重复的 fake/fixture 验证。

### 修改后

- 运行与工作项匹配的 lint/typecheck/unit/coverage；修改发布逻辑时运行脚本测试和受控 packaged smoke。
- 对 IPC、Core RPC、migration、PathPolicy、lease/checkpoint、atomic artifact 和隐私边界补测试。
- 检查 `git diff --check`、只提交所属文件、记录验证环境和未运行的测试；不把 GUI E2E 或 release 结果凭空补写。
