# Copilotix Desktop P0/P1 架构基线与二次开发指南

> 本文是 Desktop 当前 P0/P1 架构的权威边界。它描述已经在源码和测试中存在的契约，也明确哪些能力尚未实现。若本文与代码冲突，以当前代码、运行时 schema 和测试为准；修复冲突时先记录证据，再由负责公共边界的 Agent 更新文档。

## 1. 基线与范围

| 项目 | 当前基线 |
|---|---|
| 适用分支 | 当前工作分支见根 `AGENTS.md` |
| Desktop 版本 | 以 `desktop/package.json` 为准 |
| Electron | `44.1.1` |
| Node.js | `24.19.0`（`.node-version` 与 CI 一致） |
| pnpm | `11.19.0` |
| 支持目标 | Windows x64 Setup 与包含 Setup 的精简 ZIP；其他平台未接入发布验收 |
| 本地应用数据目录 | `%APPDATA%\Copilotix-Translation-v2`（Electron `userData`） |
| 数据库文件 | `copilotix-desktop-v2.sqlite3`，位于上述 `userData` 目录 |
| 结果目录 | `<outputRoot>\documents-v2\{documentId}`；`documentId` 为 UUID |
| 当前产品能力 | Parser API 解析、Markdown/表格翻译、PDF 与 Markdown 阅读、映射和阅读标注、可恢复作业与验证发布 |
| 问答 | 单篇问答与其切块索引已接入；多文献 RAG 路线已放弃（第 10 节） |

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

## 3. 代码地图与模块边界

### 3.1 依赖方向（`pnpm desktop:deps` 以 error 模式检查，见 ADR-0001）

代码按 `src/app`（组装根）、`src/platform/<关注点>`（基础设施，不认识功能）与 `src/features/<模块>` 分目录，每个单元内再分进程层：

```text
renderer ──▶ contract ◀── preload
main ──▶ core ──▶ contract ◀── utility ──▶ core
main ──▶ runtime ──▶ core ◀── runtime ◀── utility
```

- `contract`：各进程共用的纯 TS，不得导入 Node/Electron/DOM 专有 API；跨层契约（schema、DTO、版本常量）只在所属模块定义一次。
- `core`：纯逻辑，不得导入 Node/Electron 或 runtime 层。
- `runtime`：Main 与 Utility 共用的 Node 运行时实现，不碰 Electron；`PathPolicy` 在 `platform/files/runtime`。
- `renderer` 只依赖 contract／core 与 preload API；`main` 与 `utility` 互不导入，只经 Core RPC 通信；其他模块只经 `contract/` 或层 `index.ts` 引用一个模块。

### 3.2 模块表

> 1.3.0 正按 [ADR-0001](adr/0001-feature-modules.md) 把代码迁入 `src/{app,platform,features}/`（进度见 [milestone](MILESTONE_1_3_ZH.md)），各模块入口以其 `README.md` 为准；`shared/`、`core/` 等旧目录已在 M5 拆除，下表的旧路径在 M6 重写本文时更新。

| 模块 | 主要文件 | 职责与边界 |
|---|---|---|
| 跨层契约 | `shared/ipcSchemas.ts`、`types.ts`、`coreRpcSchemas.ts`、`ragSchemas.ts`、`paperChat*Schemas.ts`、`paperInsight.ts`、`figureInsight.ts`、`librarySchemas.ts`、`libraryCategories.ts`、`translationPlanProtocol.ts` | 所有 IPC／RPC／磁盘 JSON 的 Zod 契约；`documentSummary.ts` 是文档摘要唯一投影 |
| 文档纯逻辑 | `shared/markdownBlocks.ts`、`standardMarkdown.ts`、`mathDelimiters.ts`、`readerDocument.ts`、`readerAnnotations.ts`、`readerFigureGroups.ts`、`readerFigureLayout.ts`、`figureArtifacts.ts`、`titleNaming.ts`、`paperBrief/` | 无 I/O 的解析、映射、导出投影与提示词构造，可在任意进程运行 |
| Core 契约与基础件 | `platform/rpc`（协定与 `CoreClient`）、`platform/jobs`、`core/types.ts`、`core/ports.ts`、`core/blockMapping.ts`；完整 RPC 注册表在 `app/contract/coreRpc.ts` | 文件系统路径实现位于 `platform/files/runtime/pathPolicy.ts`，由 Main 与 Utility 共用 |
| Preload 桥 | `app/preload/index.ts`、`app/contract/desktopApi.ts`、`platform/ipc/preload/{bridge,ipcClient}.ts` | 只暴露 `window.copilotix` 显式领域方法；方法与频道由各模块 `contract/ipc.ts` 组合 |
| Main：外壳与 IPC | `app/main/{index,bootstrap,window,services,packagedSmoke,singleInstance}.ts`、`platform/ipc/main/ipc.ts`、`libraryAccessGate.ts`、`platform/{assets,network,log}` | 生命周期、窗口、托盘与组装；各模块 `main/ipc.ts` 以 `IpcRegistrar.handle(契约频道, handler)` 注册，底层仍经 `registerValidatedHandler` |
| Main：Utility 桥 | `utilitySupervisor.ts`、`electronUtilityFork.ts`、`utilityEntryPath.ts`、`rpc*.ts`、`taskRepositoryCompat.ts` | Utility 生命周期与 RPC 代理；`rpc*` 只把端口方法映射为固定 operation |
| Main：文档与作业 | `taskService.ts`、`documentCommandService.ts`、`documentProjection.ts`、`artifactService.ts`、`figureArtifactStore.ts`、`jobScheduler.ts`、`*JobRunner.ts`、`progressReporter.ts` | 导入／重试／删除／导出与 durable job 执行；只经 JobRepository／TaskCompute 端口改状态 |
| Main：外部服务 | `parserClient.ts`、`fileUploader.ts`、`translation/`、`chat/chatProvider.ts`、`credentialVault.ts`、`settingsService.ts`、`usageAnalyticsService.ts` | 网络、凭据与设置；Token／Key 不离开 Main |
| Main：AI 功能 | `chat/paperChatService.ts`、`paperInsightService.ts`、`figureInsightService.ts` 及各自 `*Ipc.ts` | 问答、档案卡（Paper Brief v2）、图片解读的授权、队列与取消 |
| Utility：运行时 | `utility/index.ts`、`coreUtilityRuntime.ts`、`core/utilityOperations.ts` | RPC loop、operation registry 与 data／compute／exclusive 三通道 |
| Utility：持久化 | `core/persistence/v2Database.ts`、`v2TaskRepositoryCompat.ts`、`sqliteJobRepository.ts`、`sqliteRagRepository.ts`、`paperChatStore.ts`、`paperInsightStore.ts`、`figureInsightStore.ts` | SQLite 与文献目录内 JSON 的唯一读写者 |
| Utility：计算 | `core/compute/markdownTranslationPlan.ts`、`tableTranslation.ts`、`structureAwareChunker.ts`、`ragContentIndexService.ts`、`libraryCategories.ts` 及 `core/paperContextBuilder.ts`、`libraryCategoryService.ts`、`libraryMaintenance.ts` | 翻译计划、问答切块与证据、文库分类、备份／恢复／迁移 |
| Renderer：外壳与页面 | `App.tsx`、`pages/`、`components/{WindowControls,PageBrand,CopilotixWordmark,EdgeDock,HomeScene,HomeWidgets}.tsx`、`documentCache.ts` | 视图路由与文档列表缓存 |
| Renderer：阅读工作台 | `components/{ReaderWorkbench,ReaderViews,PdfPane,MarkdownPane,MarkdownMinimap,SafeMarkdown,ReaderFigureSnapshot,DocumentLifecycleActions}.tsx`、`reader*.ts`、`pdf*.ts`、`annotationMutations.ts`、`rehypeTableMath.ts`、`useFigureArtifacts.ts` | 四视图工作台、PDF／Markdown 渲染、同步、标注 |
| Renderer：问答与解读 | `components/ReaderChatPanel.tsx`、`PaperInsightActions.tsx`、`usePaperChat.ts`、`usePaperInsight.ts` | 只经 `window.copilotix` 调用 |
| Renderer：文库 | `pages/LibraryPage.tsx`、`paperArchive/` | Three.js 档案场景、详情与可取消的阅读器进入过渡（懒加载） |
| 测试与发布 | `tests/`、`e2e/`（含 `launchPolicy.ts`）、`scripts/` | 不属于运行时 bundle |

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

当前公开 API 是 `window.copilotix` 的显式方法集合：设置与连接测试、文档导入/列表/重试/删除/详情、输出打开/另存、阅读标注、窗口状态和事件订阅。每个方法由所属模块的 `contract/ipc.ts` 绑定固定 channel、请求 schema 和响应 schema，`app/contract/desktopApi.ts` 组合，`app/preload/index.ts` 暴露。

新增方法必须同时更新：

1. 所属模块 `contract/` 的请求/响应/事件 schema 与公开 DTO；
2. 该模块 `contract/ipc.ts` 的频道声明与 preload API 工厂（preload 无需改动）；
3. 该模块 `main/ipc.ts` 以 `IpcRegistrar` 注册 handler 或发送事件；
4. 不可信请求、sender、响应和错误 envelope 测试。

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

Core RPC 的 operation 由平台、作业与各模块的 `contract/rpc.ts` 声明，`desktop/src/app/contract/coreRpc.ts` 组合为唯一注册表：

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

当前 registry 只保留 Main 实际调用的操作：`database:*`、`library:*`、`settings:*`、任务/文档（含批量插入）、作业、artifact revision、`insight:*`／`figureInsight:*`、`chat:*`、标注快照/修改以及 `compute:*`（导入、归一化、映射、问答索引、文库分类、图片解读描述和翻译计划）。旧的逐块翻译、翻译缓存、整表标注替换与 `knowledge:*` 等未被调用的 operation 已移除，Utility 内部仍可直接使用对应 Repository 方法。增加 operation 必须添加严格 payload/result schema、registry 项、两端 handler、取消/超时测试，并评估 1 MiB 上限。

文库列表（`tasks:list`、`documents:list`）按 `(createdAt DESC, id ASC)` 做 keyset 分页：请求 `{ after? }`，响应 `{ items, next }`；Utility 每页最多 200 行并按 512 KiB 字节预算截断，Main 的 `RpcTaskRepository` 循环取完。这样大型文库不会触及 1 MiB 上限。Utility 端每页只用两次查询（文档 + 其 parse/translate 作业）完成投影，没有逐文档查询。

### 5.3 Utility supervisor

Supervisor 启动 Utility 后等待 `ready`，再以 `database:init` 初始化 v2 数据库和 output root；Utility 异常退出会拒绝所有 in-flight RPC 并按 `[250ms, 1s, 4s]` 退避重启，连续失败最多三次，随后进入 failed。请求超时/取消只影响对应请求，并向 Utility 发 cancel；不会复用已结算的 requestId。关闭时执行 scheduler shutdown、drain、database flush/close，超时后才终止子进程。

Utility 内触及 SQLite 的 operation 分三条 FIFO 通道：数据通道（任务、作业、心跳、文档、标注、设置）、compute 通道（所有 `compute:*` 长耗时文件操作，`compute:hash-file` 除外），以及独占的生命周期通道（`database:init/flush/close`、`library:*`）。长论文归一化或翻译计划只占用 compute 通道，不再阻塞心跳和 UI 读取；所有 SQLite 事务均为同步执行，因此两条通道交错是安全的；生命周期操作会等待并阻塞两条通道。Main 侧 compute 请求使用 `COMPUTE_RPC_TIMEOUT_MS`（10 分钟）超时并由作业 signal 取消，避免排队被误判为超时。

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

`desktop/src/platform/database/utility/v2Database.ts` 用 `node:sqlite` 的 `DatabaseSync`，开启 WAL 与 foreign keys。连接属于 Utility，不属于 Main。当前 schema 使用 STRICT 表并包含：

- `settings`：JSON 公开设置；
- `documents`：来源名、标题、storage path、checksum、解析/翻译配置；
- `jobs`、`job_events`：持久化作业状态、依赖、lease、checkpoint、事件序号；
- `artifacts`：按 document/kind/revision 的不可变产物引用和 hash；
- `translation_blocks`、`translation_cache`：翻译 block、来源 hash、provider/model 和缓存；
- `annotation_sets`、`reader_annotations`：按 artifact/view 隔离的阅读标注。

`schema_migrations` 保存 `version/name/checksum/applied_at`。迁移版本必须从 1 连续递增；每一条迁移在事务中执行；已应用版本的 name 或 SHA-256 checksum 变化必须拒绝启动。禁止在启动时猜测列、静默 `ALTER TABLE`、覆盖历史迁移或把 RAG 表偷偷混入 P0/P1 schema。未来新增表必须有显式 migration、空库路径、现有 v2 库升级、checksum mismatch、失败回滚和重复启动测试。

### 6.3 PathPolicy

`platform/files/runtime/pathPolicy.ts` 是 Main 与 Utility 共用的唯一 `PathPolicy` 实现（端口见 `platform/files/contract/pathPolicyPort.ts`）。实现从 Core 移入 runtime 层，导出的类与词法校验函数、磁盘路径规则及恢复语义保持不变；无需数据库或 IPC migration。任何相对 artifact、导入目录、asset URL 或删除目标都必须：

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

翻译手动重试保留已完成结果，把失败单元改为 pending。重新载入已保存的 pending 计划时，旧尝试残留的失败块不能将其覆盖回 failed；本次新失败仍须持久化并在重启后保留。恢复回归见 `markdownTranslationPlan.test.ts`。

### 7.2 Parse

1. 用户选取或拖入 PDF，Main 校验扩展名和官方 `200MB` 上限；生产导入通过 Utility 一次流式读取、hash 和复制到 `original.pdf`，避免将完整文件经 IPC 搬运。
2. Parse runner 在 Main 通过官方 API adapter 申请上传、上传、轮询，并把远端 batch/data ID 和阶段写进 checkpoint。
3. 结果 ZIP 以受限流式方式下载到作业专属 partial 文件；解压到作业专属 staging，拒绝不安全归档条目。
4. Utility normalize 只发布受 PathPolicy 保护的 `full.md`、`layout.json`、可选 content list、图片和 `block_list.json`；产物发布完成且 hash 可验证后才写 `artifacts` revision。
5. 同作业恢复必须能识别已发布、hash 相同的文件，不重复破坏已有产物；解析成功后按依赖关系创建 translate job。

**导入确认与首页封面（1.2.0）**：确认框由 Renderer 以共用 pdf.js worker 在本地读取页数、PDF 元数据标题与第 1 页文字（≤120MB），`shared/pdfImport.ts` 的 `trustedPdfMetadataTitle`／`detectRepositoryCoverPage` 判定标题可信度与机构库封面（City Research Online、White Rose、HAL、ResearchGate、JSTOR、Taylor & Francis 等，或两条以上通用版权／引用信号）；只提示，跳过与否由用户勾选。

- IPC `documents:import` 内部请求新增可选 `files: { skipFirstPage?, metadataTitle? }[]`，必须与 `paths` 等长；preload 按路径配对过滤非 PDF。缺省即旧行为，旧 renderer 无需改动。Main 用同一函数重新校验标题，不信任 renderer 的判断。
- Core RPC `compute:import-pdf` 新增可选 `skipFirstPage`。Utility 用 pdf-lib（打包进 bundle 的 devDependency）在内存中删除第 1 页，以 `wx` 写 partial、fsync 后 rename 为 `original.pdf`；`sourceHash` 与 artifact 记录的是裁剪后的字节，用户原文件不变。上限 `MAX_PDF_CROP_BYTES`（64MB）；加密、单页或无法改写时返回 `CORE_PDF_REWRITE_FAILED` 且不留文件。缺省即原流式复制。
- 元数据标题写入 `display_title` 作为暂定标题；`CopilotixTask.titleSource='pdf-metadata'` 只在插入时把 `titleSource`／`provisionalTitle` 写进 parse job checkpoint，读取时不返回。解析完成时若标题仍等于暂定值即改用解析标题；用户选「原文件名」的标题不覆盖。无 schema／migration；旧 checkpoint 没有这两个键，行为不变。
- 状态投影：parse job 的 `uploading`／`parsing` 改按 runner 写入的 `checkpoint.stage`（无 stage 时回退插入时的 `phase`），修正整个解析期间都显示「上传中」；失败的翻译保留 `translationProgress`，界面据此把失败落在翻译步骤。首页导入进度卡、文库浏览面板与阅读器都用 `renderer/documentStatus.ts` 显示「上传 → 解析 → 翻译 n/总数」。回归：`utilityOperations`、`v2TaskRepositoryCompat`、`parsePipelineConcurrency`、`ipcContracts`、`titleNaming` 测试。

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

- Parser API 使用 `desktop/src/features/parsing/contract/parserApi.ts` 中受控的固定来源与 v4 路径；Token 只发送到固定 API 请求；预签名上传/下载不带 Token；
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

## 10. Reader 問答與索引邊界

單篇文獻問答、切塊索引與證據構造見 [維護契約](READER_AI_CHAT_PLAN_ZH.md)。多文獻 FTS／向量／混合檢索路線已於 2026-10-12 放棄並刪除相關代碼與計劃；schema 4 的 rag_* 語義／向量表及 `rag-embed`／`rag-delete` 作業類型只為 migration checksum 與舊庫兼容保留：除刪除文檔／內容換版時的兼容清理（FK RESTRICT 要求）外不再讀寫。來源身份始終綁定 artifact／revision／hash，不把 BlockMapping.id 當成跨文檔身份。

## 11. 公开 API 打包与 verified atomic release

Renderer 的公开 API 是 preload 暴露的 `window.copilotix`；它与四个 bundle 一起进入打包输入。`desktop/scripts/package-directory.mjs` 负责 Windows x64 目录版，发布顺序必须保持：

1. 只在仓库根目录精确的 `.release-next-{buildId}` staging 中构建；不得把 `desktop/out/` 当正式发布目录。
2. 校验 `main/preload/renderer/utility` bundle、独立 `uninstall-cleanup.js`、`app.asar` 必需 entry、`@napi-rs/keyring` unpack 路径、Electron locale、fuses、运行时文件以及体积上限（当前 `app.asar < 40 MiB`、运行目录 `< 360 MiB`、精简 ZIP `< 155 MiB`、Setup `< 180 MiB`）。
3. 以同一已验证运行目录生成 NSIS Setup 与 ZIP、`release-manifest.json` 和 `SHA256SUMS.txt`，并重新解压 ZIP 校验入口/ASAR/资源/哈希。正式构建验证主程序、Setup 与内嵌卸载器签章。
4. 启动已打包的 `Copilotix.exe --copilotix-packaged-smoke`，只接受与 package 版本及 Electron 版本匹配的精确 marker 和空 stderr；该 smoke 是 CLI 启动检查，不创建 Renderer 窗口。
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

覆盖统计各单元的 main／core／runtime／contract 层，范围与阈值由 `vitest.config.ts` 维护。一般 push／PR 执行 lint、typecheck、受影响单元测试＋必跑安全集、四 bundle 和 smoke＋受影响 E2E（见开发文档）；版本 tag 或手动 `full_validation` 才执行完整覆盖率、全量 Electron、打包和安装验收。发布门禁失败不能称为发布通过；日常核心回归也不代表完整发布验收。

单元/集成测试至少覆盖：Core RPC schema/1 MiB/超时/取消、sender/frame/URL、Utility ready/restart/drain、STRICT migration/checksum、Repository/lease/checkpoint/retry、PathPolicy/符号链接、流式导入与 atomic artifact、翻译 cache/表格协议、映射/标注以及 release transaction/manifest/fuse/packaged smoke。真实 API、真实翻译和真实 PDF 属于 opt-in fixture，不是所有 PR 的默认证据。

### 12.2 本地驗證邊界

本地驗證是否執行按根 AGENTS 與當次使用者指示；只聲明實際運行的環境與範圍。packaged CLI smoke 不啟動 Renderer，不能代替 GUI／GPU 驗收。不得為本地驗證降低產品默认或 CI 的 sandbox。

## 13. P0/P1 Definition of Done

| 里程碑 | 必须满足 |
|---|---|
| P0：边界与持久化 | Electron 44.1.1/Node 24.19.0 锁定；sandbox Renderer；最小 preload API；IPC/Core RPC schema、sender 校验、1 MiB、timeout/cancel/restart；Utility 独占 SQLite/compute；v2 userData/DB/`documents-v2/{documentId}`；STRICT migrations；PathPolicy；coverage gates 通过 |
| P1：可恢复工作流 | durable parse/translate jobs；lease/heartbeat/checkpoint/retry/recovery；Utility 流式导入、解析归一化和 translation plan；artifact hash/revision、fsync/atomic publish、结果 ZIP 排除内部文件；provider/credential 边界；verified atomic release 与 packaged CLI smoke |
| 文档基线 | 区分现有功能与目标设计；公共 API/路径/错误/数据表变更有 schema、测试、兼容与恢复说明 |

任何 DoD 未满足都只能标记为 partial/proposed，不能使用“已完成”作为发布结论。

## 14. 已知結構債（未處理）

- `v2TaskRepositoryCompat.ts`（約 1300 行）仍以舊 `CopilotixTask` 投影同時承擔文檔、artifact、翻譯塊、標註、設置；宜按聚合拆成獨立 Repository，Main 側 `TaskRepositoryCompat` 隨之收窄。
- 過大單文件：`paperArchive/PaperArchiveScene.ts`、`compute/markdownTranslationPlan.ts`、`MarkdownPane.tsx`、`MarkdownMinimap.tsx`、`PdfPane.tsx`。
- Renderer 根目錄平鋪十餘個 reader／pdf 模組，待按「閱讀工作台／文庫」分子目錄；搬移前先與其他 worktree 協調以免衝突。
- `ragSchemas`／`sqliteRagRepository`／`rag-content-index` 的 rag 前綴已名不副實；作業類型字串已持久化，只能改代碼名。`database:flush` operation 目前 Main 未調用。

## 15. 維護與後續事項

協作、文檔精簡、本地驗證與發布授權統一見根 [AGENTS.md](../AGENTS.md)。變更前定位 port／schema／handler／repository，跨邊界修改須保留兼容、回滾與相關回歸。macOS／Linux 的 Vault、原生窗口、路徑、打包與簽名尚未完成发布驗收。


## Codex provider（本机 App Server）

- Main 的 `platform/codex/runtime/codexRuntime.ts` 通过 `codex.exe app-server --listen stdio://` 建立 JSON-RPC；`modelGateway.ts` 统一远端与 Codex 流式调用，翻译适配器保留现有表格 ID 校验。翻译、问答、Paper Brief 和图片解读共享此运行时；不提供 embeddings 或 PDF 解析替代。
- `platform/codex/contract/codex.ts` 定义可兼容旧设置的可选配置与状态。Preload 只开放经 Main 校验的检查／模型测试与原生选执行文件 IPC；无令牌接口。模型、视觉输入和推理强度来自当前模型目录，模型缺失显式失败。旧四服务顺序可读取，默认追加但不启用 Codex。2026-10-21 起（产品决策：多数用户以 Codex 为主，接受自动切换）翻译不再在 Codex 处截止：Codex 退避重试后仍失败的单元按顺序落到下一个已启用且凭据有效的服务；不新增开关，「模型设置」中关闭其他翻译来源即为仅用 Codex。manifest 逐块 provider/model 不变；Main 读取时对 provider≠preferredProvider 的完成块附加可选 `fallbackProvider`（IPC `translatedMarkdownBlockSchema` 新增可选字段，旧 manifest 无 provider 时不标记，无迁移），译文视图不常驻标注（2026-10-24 起），该段右键菜单首行显示「此段由 X 回退翻译」，不进入选区、标注偏移或复制文本。档案卡在 Codex 失败（非上下文超限）或一次修复后仍不符合字数／结构契约时，改用翻译顺序中下一个已启用且 Key 有效的 Qwen／DeepSeek，从干净提示重新生成并各有一次修复，档案卡状态显示实际模型名；`paper-insight` 日志的 `problems` 只记字段路径与字数（如 `analysis.abstract:178`）；问答、图片解读不回退。
- 交互保留独立 FIFO，后台共用等待队列，由空闲槽位领取下一请求，最多 8 个独立进程槽位，每槽同时一个请求。槽内复用经过隔离配置校验的进程，每次请求创建新 ephemeral thread；闲置 30 秒、协议／连接出错或退出关闭进程，turn 正常结束为 failed 时保留进程供重试。避免每段重复 account/read／model/list；不复用论文会话。最终回答、token usage、结构化 schema 经业务校验后落盘。CLI 限定 0.159.x，子进程不经 shell，工作目录在 userData 的 codex-runtime。
- 翻译按 32 条元数据分页预取，同时准备最多 64 个单元，Codex／Qwen／DeepSeek 请求上限 8。Codex 仅合并同一作业 signal 的短片段：每批最多 16 组／64 片段／约 8K 字符，单个超长组独立发送而不截断；短传输 ID 在本地还原后逐单元校验、保存。表格保留行列结构，使用同样的短 ID 映射与完整性检查。翻译 low、档案 medium；thread/start 与 turn/start 均使用任务实际档位，问答沿用全局设置。读取相同输出根目录的设置不重建翻译计划。
- 会话级覆盖关闭 shell、MCP、应用、插件、浏览器、联网搜索、记忆和子代理，设置只读沙箱、无持久历史、忽略项目文档；启动时读回隔离配置。工具请求一律拒绝并终止任务。覆盖不写入用户配置。用户文档、图片与历史均作为不可信内容；图片只接收应用已验证的 PNG/JPEG 数据。
- 初始化 RPC 15 秒，生成空闲 120 秒、总计 10 分钟；排队取消立即返回，运行取消请求 turn/interrupt，5 秒后关闭进程。进程异常、非成功完成、空结果和工具尝试均不能当作成功；退出关闭所有进程。不会静默切换模型或其他供应商。诊断不记录提示正文、图片或令牌。
- 限流与重试（2026-10-21）：ChatGPT 后端对 Codex 账户按速率返回 429，app-server 内部重试数秒后以 `codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } }` 结束 turn；8 槽并发约 10 个请求后即触发，旧 `turnError` 只认字符串变体，统一成不可重试的「Codex 生成失败」，每批 16 单元秒失败（真实论文 435 块首轮失败 154）。现 `turnError` 解析对象变体与 HTTP 状态：429／rateLimitExceeded／serverOverloaded 为限流，连接／流中断及 5xx 为暂时错误，额度、登录、上下文与 4xx 不重试。后台通道由 `CodexBackoff` 共享冷却：限流时并发减半（下限 1）并按 5 秒起指数退避（≤60 秒、抖动），同一冷却窗内其他在途失败不再减半，持续成功逐槽恢复到 8；未输出任何增量的请求最多尝试 6 次，已有部分输出或交互通道不重试。Main 日志 `codex.generation.failed`（lane、attempt、category=变体:状态、retryable、willRetry、cooldownMs、concurrency、耗时）、`codex.concurrency`、`paper-insight`（stage、provider、category）只记分类，不记 prompt、论文、上游错误文本或凭据。只改 Main 运行时，不涉 IPC／Core RPC／schema。实测：同篇 431 个翻译单元经真实 Codex 与 64 单元并发全部成功（305 秒，35 次 429 均重试成功，最多第 3 次）；回归见 codexRuntime、paperInsight 测试。
- SQLite migration **5 / add-codex-provider** 仅扩展 documents、translation_blocks、translation_cache 的 provider 约束；迁移 1–4 不改，复制原数据并恢复索引。仅在事务外临时关闭外键，提交前检查外键，异常回滚并恢复外键开关；沿用迁移前快照。旧程序不可直接打开 schema 5，回退需用迁移前快照恢复，不删除用户原库。聊天／解读 JSON 增加 codex 枚举，既有内容不改写；token 统计兼容缺失的 Codex 计数。
- 回归入口：codexConnection、codexRuntime、codexIntegration、credentialGate、v2Database 测试；真实调用仅显式 `COPILOTIX_CODEX_LIVE=1` 运行 e2e/codex.spec.ts，使用合成论文。2026-10-13 本机 111 个测试文件通过（759 通过、3 跳过），类型检查与 lint 通过；合成文本翻译、表格、证据问答、Brief schema／引用、图片解读和取消实测成功，Electron 设置→授权→真实问答→引用落盘流程通过；不替代真实论文人工质量审阅或远端 CI。使用步骤见 [服务配置](wiki/Service-Setup.md)。

2026-10-13：使用程序即同意向已配置、已啟用的模型服務發送功能所需內容，問答／檔案卡／圖片解讀不再彈出單獨授權或提供撤銷入口。舊 chatConsent 欄位僅供 wire 相容，忽略舊值且保存設定時清除持久化記錄。Codex「測試連接」成功填入實際 exe 路徑，所選模型測試全部成功顯示「驗證成功」。存儲統計在啟動與文檔更新時預載，按文庫根目錄緩存 60 秒、合併並行掃描，存儲頁立即顯示已有結果；手動刷新強制更新。

窗口控制固定在标题栏的独立持久区域，层级高于普通弹层，按钮显式 no-drag；e2e/window-controls.spec.ts 验证跨页面、最大化／还原及删除确认弹窗时三个按钮可见且命中正确元素。


2026-10-14：Codex 连接状态经校验 IPC `codex:cached` 读取，Renderer 共享缓存避免设置页重挂载丢失；每次程序启动恢复上次状态后后台自动检测，不自动发送模型测试消息。Main 在 `userData/codex-runtime/connection-status.json` 原子保存最多 8 组程序路径／推理强度对应的状态、模型目录与已测模型；不存登录令牌，不修改 Codex 登录文件。版本／程序变化不继承旧验证，实际登录失效显示未登录；快照损坏或缺失重新检测，卸载清数据按既有 userData 验证清单覆盖此文件。
问答 turn JSON 增加可选 completedAt、durationMs 和 usage（输入／输出／总 Token），completed stream 可选 metadata 携带实际模型及时间。旧记录无需迁移、照常读；旧客户端／旧记录缺字段时显示未提供，不将未知用量记为零。新结果元信息随原有原子 turn 保存。2026-10-14 此次按用户要求不运行测试、lint 或类型检查，仅构建打包并保留打包内置校验。


普通 ChatGPT 聊天接入分析（2026-10-14，尚未实现）：可用 OpenAI Responses API 请求聊天模型（chat-latest 为 ChatGPT 当前 Instant 别名），也可按 Sign in with ChatGPT 的本地／开源应用授权流程请求账户目录中的可用模型；两者均不要求经过 Codex agent。订阅接入仍取决于实际资格与模型目录，不能直接使用 ChatGPT backend-api 或假设已有 Codex 登录代表获得所有聊天模型权限。
来源：[chat-latest](https://developers.openai.com/api/docs/models/chat-latest)、[订阅推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。订阅路线当前不支持图片生成、Code Interpreter、文件搜索等托管工具；标准平台 API 可另接对应工具。API 不返回 ChatGPT 客户端的完整呈现树；模型接口切换与富内容 UI 是两项工作。
当前 Chat 已支持 Markdown 文本、标题、列表、表格及 KaTeX 公式；图示四宫格可由结构化 JSON 与本地组件复现，来源胶囊需要返回的引用元信息与独立组件。当前回答中的图片和外链仅显示文本，未加载图片；图片需增加验证、资源下载／持久化与受控展示，生成图片还需独立工具。交互图表／地图／视频／音频／Canvas 等需对应资源和组件，不能靠文本回答自动保持 ChatGPT 原格式。本次仅修改页签、公式渲染和隐藏用时，保留既有 Codex 路由。
