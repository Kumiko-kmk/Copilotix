---
document_id: mineru-desktop-rag-development-plan
document_version: 3
status: proposed
baseline_ref: master
baseline_commit: 10225a12c88ac0c4fb1107aa28e3fb5ca28e98b2
baseline_verified_at: 2026-09-02
reassessed_at: 2026-09-02
working_snapshot_branch: master
working_snapshot_head: 10225a12c88ac0c4fb1107aa28e3fb5ca28e98b2
working_tree_status: clean after merge documentation verification
merge_sources: cd8ca7f85bd481711a1294d12b142a4ca0546002 (UI overhaul), 7436da449b41760a8eee72481761c52982dda62f (English title filename)
reassessment_changes: English title filename feature merged into master; architecture/RAG/release documentation reconciled
coordination_owner: integration-agent
---

# MinerU Desktop 论文知识库与 RAG 开发总纲

> 本文是切块、向量化、检索和论文库问答的规划与协作单一入口。`ARCHITECTURE_ZH.md` 继续描述现有 Desktop 架构；本文只记录经提交绑定的事实、RAG 目标架构、实施顺序、验收门槛和多 Agent 协作约束。

## 0. 如何使用本文

### 0.1 三类信息必须分开

本文中的结论按以下层级解释，后续 Agent 不得把它们混写：

1. **已提交基线**：只指本地 `master@10225a12c88ac0c4fb1107aa28e3fb5ca28e98b2` 中可由 Git 复现的内容。
2. **工作树观察**：只指明确标注日期和分支的未提交内容；当前验证时 `master` 工作树干净，因此本文不把旧的 feature 分支观察冒充为当前能力。
3. **目标设计**：本文提出的 RAG 方案；在代码和测试合入前都不能写成“已实现”。

更新本文时必须同时更新 front matter 的 `document_version`、基线提交和验证日期。若只有工作树变化而 master 未前进，只更新“工作树观察”，不得移动基线。

### 0.2 多 Agent 并行规则

- 并行 Agent 可以共同阅读本文，但不得在同一个 Git 工作树中同时修改同一文件。
- 并行实现应使用独立分支或独立 worktree；共享工作树只允许只读审阅。
- 集成 Agent 独占本文的“基线、公共契约、决策记录、总进度”章节。
- 实现 Agent 只修改自己领取的工作项和所属代码文件；需要改变公共契约时先提交设计说明，由集成 Agent 更新本文。
- 一个工作项只允许一个 owner；两个工作项不得同时占有同一高风险文件。
- 不运行跨仓库格式化、依赖升级、清理或批量重写，除非该操作就是已领取工作项。
- 开始和结束都记录 `git status --short --branch`；不得还原、覆盖或顺手提交其他 Agent/用户的改动。
- 提交必须包含该功能依赖的 tracked 与 untracked 新文件。禁止在存在新模块时使用 `git commit -am`。

### 0.3 事实冲突处理

事实优先级为：当前提交中的源码与测试 > 当前提交中的生成配置 > 文档描述。发现冲突时：

1. 在本文“已知不一致”中登记；
2. 用最小测试或源码位置给出证据；
3. 不在同一工作项中顺手修复无关冲突；
4. 基线前进后再删除已经解决的记录。

## 1. 执行结论

### 1.1 可行性

| 能力 | 可行性 | 主要依据 | 主要难点 |
|---|---|---|---|
| 结构化切块 | 高 | 已有 Markdown AST、`sourceIndex`、`mappingIds`、页码与 bbox | 章节聚合、超长表格/段落、版本化 |
| 论文库元数据与全文搜索 | 高 | 已有 SQLite、任务与本地产物 | 正式迁移、中文词法检索、删除语义 |
| 远程 Embedding | 高 | 已有 Provider、凭据库、网络与重试模式 | 隐私授权、批处理、限流、模型指纹 |
| 本地 Embedding | 中 | Electron 可启 utility process/worker | 模型下载、许可、体积、CPU/GPU 与取消 |
| 小中型库精确向量检索 | 高 | SQLite BLOB + worker 可避免新增服务 | 线性扫描规模上限需实测 |
| 大型库 ANN | 中 | 可在统一 `VectorStore` 后接扩展 | Windows 原生包、ASAR、ABI、双存储一致性 |
| 带页码引用的单/多论文问答 | 高 | Reader 已支持 mapping 驱动的 PDF/Markdown 跳转 | 引用校验、无答案拒答、流式 IPC |
| 完全离线解析 + RAG | 中偏低 | Python MinerU 源码存在 | Desktop 当前不运行 Python；这是独立大型工程 |

结论：**优先交付“可搜索、可点击、可重建的论文库”，再叠加问答。** 不应以聊天 UI 作为第一个里程碑，因为切块、索引版本和引用契约才是长期正确性的基础。

### 1.2 推荐首版

首版采用：

- Desktop TypeScript 主线，不修改 Python MinerU 引擎；
- 原文 Markdown 为规范语料，译文只作辅助检索字段；
- SQLite 管理元数据、FTS5 和 Float32 BLOB；
- worker/utility process 执行批量嵌入与精确余弦扫描；
- OpenAI-compatible embedding/chat 作为可替换 Provider，云端必须显式启用；
- FTS/BM25 与向量候选经 RRF 融合；
- 回答只引用应用生成的证据 ID，应用端验证并映射回 Reader。

首版不把 `sqlite-vec`、LanceDB、Qdrant、LangChain 或模型权重设为必需依赖。

## 2. 已提交基线：master@10225a1

### 2.1 Git 与产品边界

- 本地 `master` 当前合并提交为 `10225a1`，合并了 UI overhaul（`cd8ca7f`）与英文标题文件名功能（`7436da4`）；英文标题命名现已属于 master 能力。
- 本地分支均无 upstream，仓库也没有 remote-tracking refs；本文只能判断本地进度，不能据此推断与远端仓库的差异。
- master 共 13 个本地提交（含合并提交）：导入 MinerU 上游快照、Desktop、官方 API/Reader 修复、上传恢复、版面对齐、译文联动、Reader/目录发布、表格翻译/阅读器标注/发布治理、UI overhaul 与英文标题命名。
- Desktop 是独立 Electron 客户端，不在运行时 import、spawn 或打包仓库中的 Python `mineru/`。
- Desktop 固定调用 MinerU 官方 v4 API，下载 ZIP 后在本地标准化、翻译和阅读。

### 2.1.1 解析后英文标题命名兼容边界

- 新任务在创建时保存不可变的 `originalName`；解析完成后从 `block_list.json` 的首个非 discarded `title` 块提取英文标题，Markdown heading 只作兜底。
- 安全标题写入 `title`（不含扩展名），用户可见 `name` 更新为 `<title>.pdf`，输出目录移动为 `<title>-<taskId>`，并同步 `outputDir`、`sourcePath`。
- 任务目录内的 `original.pdf`、`full.md`、`full.zh-CN.md`、`layout.json`、`block_list.json` 和 `mineru-asset://<taskId>/original.pdf` 不改名；MinerU 上传仍使用 `originalName`。
- 旧数据库行迁移为 `originalName = name`、`title = NULL`，旧任务目录和用户可见名称不自动移动或重命名；未来回填必须是显式操作。
- 标题缺失、非法或目录移动失败时保留原路径/原名并继续解析与翻译，记录可诊断日志；重复重试不会继续追加后缀。

### 2.2 技术栈

| 层 | 当前实现 |
|---|---|
| 桌面容器 | Electron 37、electron-vite 4、Node 24 |
| Renderer | React 19、Ant Design 5、PDF.js 5 |
| Markdown | unified、remark、react-markdown、KaTeX |
| 主进程数据 | `node:sqlite` 的 `DatabaseSync`，WAL + foreign keys |
| 队列 | `p-queue` |
| 凭据 | `@napi-rs/keyring`（当前实现类名仍为 `WindowsCredentialVault`）/ Windows Credential Manager |
| 测试 | TypeScript、Vitest、Playwright |
| 发布 | electron-builder Windows x64 目录版 + ZIP |

关键配置：`package.json`、`desktop/package.json`、`desktop/electron.vite.config.ts`。

### 2.3 当前数据流

```text
PDF 选择/拖入
  -> 主进程校验大小、SHA-256 去重、复制 original.pdf
  -> MinerU 官方 API v4 批量申请上传 URL
  -> PUT 上传、轮询、下载结果 ZIP
  -> 标准化 full.md / layout.json / content_list.json? / 图片
  -> 生成 block_list.json
  -> Markdown AST 逻辑块翻译与缓存
  -> full.zh-CN.md / translation.*
  -> PDF + 原文 + 译文 + JSON 阅读器
```

主要实现位置：

- 应用组装与 IPC：`desktop/src/main/index.ts`
- 任务、标准化和输出：`desktop/src/main/taskService.ts`
- 官方 API：`desktop/src/main/parserClient.ts`
- SQLite：`desktop/src/main/database.ts`
- 版面映射：`desktop/src/main/blockMapping.ts`
- Markdown 原子块与对齐：`desktop/src/shared/markdownBlocks.ts`
- 翻译：`desktop/src/main/translation/`
- 阅读文档模型：`desktop/src/shared/readerDocument.ts`
- Reader：`desktop/src/renderer/pages/ReaderPage.tsx`

### 2.4 已实现能力

- PDF 导入、拖放、200 MiB 限制、SHA-256 去重和重复覆盖选项；
- 每批最多 50 文件，批处理、上传和后处理分级并发；
- MinerU 云端 VLM/pipeline、OCR、公式、表格与语言配置；
- 上传/轮询失败处理、远端批次恢复和手动重试；
- `full.md`、layout、内容列表、图片和 `block_list.json` 标准化；
- AST 级翻译、四 Provider 回退、块级缓存、断点恢复和 partial 状态；
- PDF Range、自定义安全资源协议、bbox 覆盖和跨页逻辑块；
- PDF 与原/译 Markdown 双向定位、页眉/脚注/页脚/页码恢复；
- 任务列表、设置、托盘、通知、打开目录和结果导出；
- 表格翻译协议 v2、参考文献原文保护、Reader 原文/译文标注持久化、Windows x64 目录版与 ZIP 发布流程、单元测试和 E2E。

### 2.5 当前明确缺失

- 没有独立论文/集合领域模型，现有列表仍是“解析任务”；
- 没有 RAG 级切块、全文索引、Embedding、向量检索、reranker；
- `ReaderChatSelection`/`ReaderChatSelectionFragment` 只有 renderer 侧选区载荷，尚无会话、消息、流式回答、取消、引用记录与历史；
- 没有索引任务、索引状态、revision、重建、GC；
- 没有本地解析或 Desktop Office 导入；
- 没有正式 schema version / migration ledger；新增的 `reader_annotations` 仍通过启动时建表，不能替代正式迁移；
- IPC 依赖 TypeScript 类型，缺少统一运行时 schema 校验和 sender 校验；
- 启动时在途解析/翻译任务只会标记失败，不会自动恢复全部工作；
- `TaskService` 已集中网络、文件、状态、翻译、映射和 ZIP，不能继续塞入 RAG；路径边界检查还硬编码 `\\`，是 macOS 移植前必须修复的安全/兼容问题。

### 2.6 基线验证记录

`ARCHITECTURE_ZH.md` 在 `83795dd` 中记录的提交内验证为：

- typecheck 通过；
- 17 个 Vitest 文件、75 个测试通过、4 个可选 fixture 跳过；
- 7 个 E2E 通过、4 个外部服务/真实 fixture 测试跳过；
- build、目录版打包、ZIP 结构和 smoke 通过。

这些是 2026-09-01 对 `master@83795dd` 的历史复核记录；合并后的验证结果见第 3.4 节。没有在真实 macOS 上运行。

## 3. master@10225a1 新增能力与当前缺口

当前 master 已同时包含 UI/Reader 体验改造、表格翻译/阅读器标注、目录版发布治理和解析后英文标题命名。相对于 `83795dd`，UI overhaul 与英文标题功能进一步稳定了用户可见名称、Reader 入口和发布产物契约；这些能力仍不是 RAG 索引或问答本身，但为后续语料溯源提供了稳定基础。

### 3.1 表格翻译协议 v2

`desktop/src/main/translation/tableTranslation.ts` 使用 `parse5` 解析 HTML 表格，保留单元格顺序、空单元格、`rowspan`、`colspan`、caption、footnote 及原始 HTML 结构。Qwen/DeepSeek 使用结构化 JSON，TranSmart 使用有序文本数组，Bing 使用 segment 级短请求；所有响应在 segment 数量、ID、空白和重复项校验通过后才整体回填。

这提高了表格作为 RAG 语料的完整性，但 segment ID 不是 PDF `mappingId`，当前也没有单元格级 bbox 映射。因此首版 chunk/citation 只能承诺表格级或逻辑块级溯源，不能编造单元格级跳转。

### 3.2 Reader 标注与“添加到对话”准备

- SQLite 新增 `reader_annotations`，按 task、original/translated 视图、稳定 block key 和 UTF-16 区间保存高亮/下划线；任务删除时外键级联清理，标注不写回 Markdown 或结果 ZIP。
- 新增 `reader-annotations:get/replace` IPC；renderer 通过 CSS Custom Highlight API 绘制，支持跨 block 选区、重叠区间合并和 quote/prefix/suffix 重定位。
- `ReaderChatSelection` 与 `ReaderChatSelectionFragment` 已定义选区载荷，但“添加到对话”目前只有 renderer 回调，没有 chat IPC、会话、消息、检索或回答后端。

这套 block key、mapping ID、页码和 UTF-16 offset 机制应成为未来 citation anchor 的参考；`reader_annotations` 是用户标注，不得与 `answer_citations` 混为同一张表或同一删除语义。

### 3.3 发布治理对 RAG 的约束

当前 master 新增 `clean-output.mjs`、`release-policy.mjs` 和 Windows 目录版/ZIP 门禁：app.asar ≤ 40 MiB、运行目录 ≤ 330 MiB、ZIP ≤ 140 MiB，并禁止 `@napi-rs/canvas`。当前 ignored 产物约为 app.asar 20.24 MiB、运行目录 297.31 MiB、ZIP 125.64 MiB，ZIP 余量约 14 MiB；本地 embedding/聊天模型不得直接塞进发行 ZIP，应按需下载到用户模型目录或使用 loopback 服务。

发布脚本会先精确删除整个 `release/` 再构建，失败时删除半成品但不保留旧发布物，因此应称“清理后重建”，不能称失败安全的原子替换。

### 3.4 当前验证与文档/源码不一致

2026-09-02 在合并后的 `master@10225a1`、Node 24.11.1、pnpm 11.19.0 上重新执行：

| 检查 | 结果 |
|---|---|
| `pnpm desktop:typecheck` | 通过 |
| `pnpm desktop:test` | 24 个文件通过；106 passed；4 skipped |
| `pnpm desktop:build` | 通过；main/preload/renderer bundle 生成成功，build 前清理 `desktop/out` |
| `pnpm --dir desktop exec playwright test e2e/reader.spec.ts` | 6 passed；2 个可选真实 fixture 跳过 |
| `pnpm --dir desktop exec playwright test e2e/ui-chrome.spec.ts` | 2 passed |
| `pnpm --dir desktop exec playwright test e2e/smoke.spec.ts -g "minimal new parse page"` | 1 passed |
| `git diff --check` | 通过 |
| 正式 release / packaged smoke | 本次未在 master 重跑；Windows 目录版流程与门禁保留在提交记录中 |

仍需登记的事实：

- `database.ts` 只有 `CREATE TABLE IF NOT EXISTS` 与少量 `ALTER TABLE`，RAG 新表前仍需正式 migration ledger。
- translation cache 已包含流水线版本和表格协议版本，但尚未包含完整 prompt/策略指纹。
- `TaskService.delete()` 与 `resolveAsset()` 用 `${root}\\` 做边界判断，在 POSIX 分隔符下不可靠；必须改为 `path.relative()` 等跨平台实现并补测试。
- `WindowsCredentialVault` 是平台命名和实现耦合点；虽锁文件包含 `@napi-rs/keyring` 的 darwin-arm64/x64 可选包，仍需在真实 macOS 的 Keychain、签名更新和权限提示下验证。

### 3.5 已知文档/源码不一致

- 基线架构文档称 translation cache key 不含“prompt 或流水线版本”；源码 `markdownPipeline.ts` 已包含 `TRANSLATION_PIPELINE_VERSION`，准确缺口是它未表达完整 prompt/策略指纹。
- 基线架构文档已更新为 master 基线 + feature worktree 策略；既有 `feature/ui-overhaul` 等 worktree 保持不动。
- 基线架构文档的“当前工作树”会随本地状态漂移，后续应只用提交号描述稳定事实。
- 在研发布文档称 release “原子重建”，但脚本会先删除旧 `release/` 再构建；它会清理失败半成品，却不保留失败前产物，严格说不具备原子替换语义。
### 3.6 macOS 可移植性重新评估

RAG 数据模型、SQLite/FTS5、Markdown/PDF Reader、网络 Provider 和大多数 React/TypeScript 逻辑本身与平台无关；真正的移植边界在 Electron 壳、原生凭据、路径安全、托盘/Dock、原生模块和发布链路。当前结论是“可行，但不是改一个构建目标即可”：

| 层次 | 当前状态 | 迁移工作 |
|---|---|---|
| 核心业务/RAG | 高度可复用 | 保持主进程服务接口，先补 POSIX 路径和运行时 schema 测试 |
| 凭据与生命周期 | 需适配 | 将 `WindowsCredentialVault` 抽象为 `CredentialVault` adapter；验证 macOS Keychain、Dock activate、window-all-closed、Tray 菜单和通知 |
| 打包/CI | Windows-only | 增加 darwin arm64（必要时 x64/universal）dir/zip/dmg 目标、`.icns`、asarUnpack、macOS runner、签名与 notarization |
| 交付验证 | 缺失 | 在真实 Mac 上跑 keychain、PDF 资源协议、SQLite WAL、拖放、休眠/恢复、升级和 E2E |

建议工作量（仅 macOS 可运行 + 可重复 unsigned 开发包）：约 1–2 人周；生产级 arm64 发布、CI、签名/notarization 和回归：约 3–6 人周。若同时支持 Intel 或 universal、自动更新和本地模型，再增加约 1–3 人周。真实工期取决于是否已有 Apple Developer 账号、证书、Mac CI 和可复现测试样本。

实施顺序建议：先完成平台 adapter 与路径安全修复，再做 RAG schema/artifact/chunk；这样 RAG 的文件、缓存和引用契约不会被后续 macOS 修复反复搬迁。GPT-5.6-sol 可以承担大部分代码改造、测试补齐和 CI 草案，但不能代替真实 Mac、Apple 证书/公证权限和最终 UI/Keychain 验收；应按“小步提交 + Mac 验收门”交付，不能一次性全权盲改。

## 4. 产品目标与非目标

### 4.1 目标用户流程

1. 用户导入并解析论文；
2. 论文进入本地论文库，显示索引状态；
3. 用户可预览章节、切块和页码来源；
4. 用户按单篇、选中集合或全库搜索；
5. 用户用自然语言提问；
6. 回答带可验证引用；
7. 点击引用打开现有 Reader，并跳转到对应页/逻辑块；
8. 模型、切块策略或索引后端改变后，可安全重建且旧索引在新索引完成前仍可用。

### 4.2 首轮范围

- 已成功标准化的 `completed` / `partial` PDF 任务；
- 单论文与多论文集合；
- 原文规范索引、可选译文辅助字段；
- 本地元数据与索引；
- 可配置本地/远程 embedding 与 chat Provider；
- 全文、向量和混合检索；
- 非流式问答先行，流式和取消在后续里程碑；
- 页码、section、mapping 和 excerpt 引用。

### 4.3 明确非目标

- 不在 RAG MVP 中接入或打包 Python MinerU 本地解析；
- 不在 MVP 中支持 DOCX/PPTX/XLSX Desktop 导入；
- 不在 MVP 中自动下载并打包大型模型；
- 不把云 Provider 设为默认或静默上传论文；
- 不以 ANN、reranker、知识图谱或 Agent 工具调用作为首轮前置条件；
- 不让 Renderer 直接访问 SQLite、文件、模型、密钥或任意网络地址。

## 5. 目标架构与边界

```text
MinerU 标准化产物
  -> DocumentArtifactService
  -> ChunkingService
  -> IndexingService + RagJobRepository
       -> EmbeddingProvider
       -> LexicalIndex
       -> VectorStore
  -> RetrievalService
       -> Query embedding
       -> FTS + vector candidates
       -> fusion / dedupe / diversity / optional rerank
  -> RagChatService
       -> ContextBuilder
       -> ChatProvider
       -> CitationValidator
  -> typed IPC / preload
  -> LibraryPage / SearchPage / ChatPage / Reader citation jump
```

### 5.1 进程职责

| 位置 | 允许职责 | 禁止职责 |
|---|---|---|
| Renderer | 表单、状态展示、搜索/聊天 UI、引用点击 | 文件、SQLite、密钥、模型推理、任意 IPC |
| Preload | 暴露最小、类型化、参数受限 API | 暴露 `ipcRenderer`、Node 或通用 send/invoke |
| Main | 权限、作业编排、Provider、持久化、路径与 URL 校验 | 长时间 CPU 扫描/推理阻塞事件循环 |
| Worker/utility process | 嵌入、批量向量计算、可选本地模型 | 直接向 Renderer 暴露能力、持有不必要权限 |

Electron 官方将 `utilityProcess` 定义为带 Node.js 与消息端口的独立进程；本项目可用它隔离本地模型或重型向量计算。轻量纯 JS 扫描也可先用 `worker_threads`，二者都必须支持取消、超时、背压和崩溃恢复。

### 5.2 新服务

| 服务 | 单一职责 |
|---|---|
| `DocumentArtifactService` | 读取/校验 `full.md`、mapping、layout、manifest，生成 artifact fingerprint |
| `ChunkingService` | 从逻辑块构建版本化、可追溯 chunk |
| `RagJobService` | 索引作业排队、重试、恢复、取消与进度 |
| `IndexingService` | 构建不可变 revision 并原子激活 |
| `EmbeddingProviderRegistry` | 注册、探测和选择 embedding Provider |
| `VectorStore` | 构建、查询、激活和删除向量 revision |
| `LexicalIndex` | FTS 建索引与查询 |
| `RetrievalService` | 过滤、召回、融合、去重、多文档均衡 |
| `RagChatService` | 会话、上下文、生成、取消与用量记录 |
| `CitationValidator` | 验证证据 ID、页码、excerpt 与 Reader 跳转数据 |

`TaskService.processParsedTask()` 在标准化完成后只应提交独立索引作业，不能等待索引完成，也不能把 `indexing` 塞进现有 `TaskStatus`。

### 5.3 建议目录

```text
desktop/src/main/rag/
  contracts.ts
  documentArtifactService.ts
  chunkingService.ts
  ragRepository.ts
  ragJobService.ts
  indexingService.ts
  providers/
    embeddingProvider.ts
    chatProvider.ts
    openAiCompatibleEmbedding.ts
    openAiCompatibleChat.ts
  index/
    lexicalIndex.ts
    exactSqliteVectorStore.ts
  retrieval/
    retrievalService.ts
    rankFusion.ts
  chat/
    contextBuilder.ts
    citationValidator.ts
    ragChatService.ts
desktop/src/shared/ragTypes.ts
desktop/src/renderer/pages/LibraryPage.tsx
desktop/src/renderer/pages/ChatPage.tsx
```

目录名可在第一个实现提交中调整一次；合入公共契约后不得由后续 Agent 任意搬迁。

## 6. 数据模型、迁移与谱系

### 6.1 先建立正式迁移

在增加 RAG 表前，引入 `schema_migrations(version INTEGER PRIMARY KEY, name, applied_at)`，每个 migration 在事务中执行。要求：

- 空数据库从 0 建到最新；
- master 旧数据库无损升级；
- 重复启动幂等；
- migration 失败回滚并保留可诊断错误；
- 不删除未知用户数据；
- 每个 schema 变化都有 fixture 测试。

首版尽量只新增表，不改写已有 `tasks` 与翻译表。

### 6.2 建议表

| 表 | 核心字段 | 说明 |
|---|---|---|
| `rag_documents` | `document_id`, `task_id`, `source_hash`, `artifact_hash`, `current_revision_id`, `index_state`, `error` | 一个已解析任务对应一个库文档；后续再抽象跨任务 canonical paper |
| `rag_revisions` | `revision_id`, `document_id`, `chunker_fingerprint`, `embedding_fingerprint`, `backend`, `state`, `created_at` | 不可变索引代次 |
| `rag_chunks` | `chunk_id`, `revision_id`, `ordinal`, `content_hash`, `markdown`, `translated_text`, `section_path`, `source_indices`, `mapping_ids`, `page_start/end`, `token_count`, `content_type` | 规范检索单元与溯源 |
| `rag_embeddings` | `chunk_id`, `profile_id`, `dimensions`, `metric`, `normalized`, `vector BLOB` | 首版 Float32 BLOB；后端可替换 |
| `rag_embedding_cache` | `embedding_fingerprint`, `content_hash`, `vector BLOB` | 跨重建复用，需容量治理 |
| `rag_jobs` | `job_id`, `document_id`, `revision_id`, `stage`, `status`, `progress`, `attempt`, `checkpoint`, `error` | 独立于解析状态 |
| `rag_collections` | `collection_id`, `name`, `created_at` | 用户论文集合 |
| `rag_collection_documents` | `collection_id`, `document_id` | 多对多 |
| `chat_sessions` | `session_id`, `title`, `scope`, `provider_fingerprint`, `created_at`, `updated_at` | 检索范围与会话 |
| `chat_messages` | `message_id`, `session_id`, `role`, `content`, `status`, `usage`, `created_at` | 用户/助手消息 |
| `answer_citations` | `message_id`, `ordinal`, `revision_id`, `chunk_id`, `excerpt`, `content_hash`, `scores`, `page_start/end`, `mapping_ids` | 保存引用快照，保证历史可解释 |

FTS5 表单独维护，只保存用于检索的 title、section、source 和 translated 字段。启动时必须探测 FTS5/所需 tokenizer；能力缺失时退化到向量检索并在设置页明确提示。

### 6.3 指纹与稳定 ID

```text
artifact_hash = sha256(
  full.md
  + block_list version/content
  + BLOCK_MAPPING_VERSION
  + markdown mapping algorithm version
  + parserModel (vlm/pipeline)
  + forceOcr / ocrLanguage
  + formulaEnabled / tableEnabled
  + translation pipeline/table protocol versions when translated text is indexed
)

chunker_fingerprint =
  algorithm name + version + token counter + size/overlap policy
  + normalization policy + table/formula policy

embedding_fingerprint =
  provider + model + dimensions + metric
  + normalization version + input variant

embedding_cache_key =
  embedding_fingerprint + content_hash

chunk_id = sha256(
  source_hash + chunker_fingerprint
  + logical ordinal/source range + content_hash
)
```

现有 `BlockMapping.id` 包含 `taskId`，同一 PDF 重导入后会改变；它适合 Reader 内部定位，不适合跨任务文档去重键。视觉模型/标准模型、OCR 开关、公式/表格开关和 OCR 语言都可能改变 Markdown、阅读顺序、表格/公式和 mapping，因此必须生成新的 artifact/revision，不能复用旧索引。chunk 必须同时保存独立稳定身份、`blockKey`、mapping IDs、页码、section path、mapping confidence 和文本 offset 单位；Reader 当前 offset 是 JavaScript/UTF-16，citation 与“添加到对话”必须沿用或明确转换规则。

### 6.4 不可变 revision

1. 创建 `building` revision；
2. 写入 chunks；
3. 分批生成/复用 embeddings 与 FTS；
4. 校验维度、计数、引用与内容哈希；
5. 事务内切换 `current_revision_id` 并标记 `ready`；
6. 异步清理旧 revision。

构建失败或应用崩溃时继续使用旧 revision。禁止先删旧索引再建新索引。

### 6.5 重建矩阵

| 变化 | 行为 |
|---|---|
| 仅排序参数变化 | 不重建索引 |
| 仅 ANN/精确后端变化 | 复用 embeddings，重建 vector index |
| embedding 模型/维度/归一化/距离变化 | 重嵌入 |
| chunker 或 artifact hash 变化 | 重新切块并索引 |
| 译文完成度变化 | 若译文参与检索，建立新 revision；否则不影响原文索引 |
| Provider prompt 变化 | chat 不重建；query rewrite/rerank 按各自指纹失效 |

### 6.6 删除语义

必须把以下操作拆开：

- 从任务列表删除；
- 从论文库移除；
- 删除原始/解析文件；
- 删除聊天历史；
- 清理 embedding cache 和旧 revision。

首版可让 `rag_documents.task_id` 级联删除 chunks/embeddings/FTS，但 `answer_citations` 应保留最小引用快照并标记 source unavailable。若用户选择“彻底删除”，还应删除引用 excerpt、相关缓存与外部索引 tombstone。所有删除都要有跨 SQLite/外部后端的失败恢复测试。

## 7. 切块规范

### 7.1 输入

规范输入为：

- `full.md`；
- `block_list.json` 的当前或可迁移 mapping；
- 可选 `translation.manifest.json` / `full.zh-CN.md`；
- parser settings snapshot 与 artifact hash。

`content_list.json` 是可选增强，不得成为唯一输入。

### 7.2 两级切块

1. 使用 Markdown AST 与 `alignMarkdownBlocks()` 生成原子逻辑块；
2. 根据 heading 层级维护 `sectionPath`；
3. 在同一章节内聚合连续短块；
4. 默认目标约 350–700 tokens，硬上限约 900–1200 tokens；具体值进入 fingerprint；
5. overlap 以一个相邻原子块为单位，不按任意字符重复；
6. 超长单段按句子/token 边界拆分，但保留相同 mapping/page 溯源；
7. 标题不能单独成为无上下文 chunk，应附着到后续正文或作为 metadata；
8. 页眉、页脚、打印页码和明显 discarded 噪声不进入正文检索。

### 7.3 特殊内容

- 表格、caption 和紧邻 footnote 尽量作为整体；超长表格按行分片并重复表头。
- 公式块、代码块、图片说明、引用链接不得被普通文本清洗破坏。
- 图片只索引 caption/alt/邻近文本；首版不做视觉 embedding。
- 无 mapping 的正文仍可检索，但引用只能退化到 paper/section，不能编造页码。
- 每个 chunk 记录 mapping coverage/confidence；低置信映射不得宣称精确 bbox。

### 7.4 原文与译文

- 原文是规范内容和引用来源；
- 译文可以作为同一 chunk 的辅助 FTS 字段；
- 若需要双向量，使用 `source` / `translated` 两个 input variant，召回后按 canonical chunk 去重；
- 不把原文和译文当作两个独立论文，否则会重复召回和重复计数；
- 回答引用默认展示原文 excerpt，可在 UI 中附带译文。

### 7.5 Chunk 最低契约

```ts
interface RagChunk {
  chunkId: string
  revisionId: string
  documentId: string
  ordinal: number
  contentHash: string
  markdown: string
  translatedText?: string
  embeddingText: string
  sectionPath: string[]
  sourceIndices: number[]
  blockKey?: string
  mappingIds: string[]
  pageStart?: number
  pageEnd?: number
  textOffsetUnit: 'utf16-code-unit'
  tokenCount: number
  contentType: 'prose' | 'table' | 'formula' | 'code' | 'caption' | 'mixed'
  mappingConfidence: 'high' | 'page-only' | 'none'
}
```

表格内部的 translation segment ID 只用于译文回填，不能冒充 `mappingId` 或 citation anchor；引用表格时至少保存所属逻辑 block、页码和可验证 excerpt。

## 8. Embedding 与向量后端

### 8.1 Provider 必须独立

翻译接口只有 `translate(text)`，不能扩成万能 LLM 接口。建议：

```ts
interface EmbeddingProvider {
  fingerprint(): EmbeddingFingerprint
  embedDocuments(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
  embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array>
}

interface ChatProvider {
  complete(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>
  stream?(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent>
}

interface VectorStore {
  buildRevision(revisionId: string, chunks: AsyncIterable<IndexedChunk>): Promise<void>
  search(request: VectorSearchRequest): Promise<VectorHit[]>
  activateRevision(documentId: string, revisionId: string): Promise<void>
  deleteRevision(revisionId: string): Promise<void>
}
```

OpenAI-compatible 只是一种 adapter。Embedding base URL、model、dimensions、API key、批大小和超时必须单独配置、单独测试，不能假设翻译模型端点一定支持 `/embeddings`。

### 8.2 首版后端选择

首版使用 SQLite 保存 Float32 BLOB，在 worker 中做规范化后的精确余弦检索。原因：

- 不增加服务或第二份数据库；
- 备份、迁移、删除和重建简单；
- 不新增 Windows 原生模块和 ASAR/ABI 风险；
- 对个人论文库可先通过真实基准确定上限。

本机 Node 24.11.1 / SQLite 3.50.4 已探测到 `ENABLE_FTS5`，并成功创建 FTS5 内存表；打包后的 Electron runtime 仍必须单独做同样的启动探测。

### 8.3 候选后端边界

| 后端 | 定位 | 何时评测 | 主要风险 |
|---|---|---|---|
| SQLite BLOB + exact scan | 默认 MVP | 立即实现 | 线性扫描 |
| `sqlite-vec` | 可选 SQLite ANN adapter | exact scan 不达门槛后 | 当前仍为 alpha；扩展加载、Windows DLL、打包 |
| LanceDB | 可选嵌入式大索引 | 大库与多模态明确需要时 | 原生/Arrow 依赖、独立目录、双写/备份 |
| Qdrant | 高级外部 Provider | 团队/服务部署场景 | 额外进程、端口、安全、运维，不适合作默认桌面依赖 |

不凭感觉切换后端。建立 10k、50k、100k chunk 基准，记录 query p50/p95、构建时间、峰值内存、索引大小和打包增量。若目标最低硬件上的 p95、内存或容量门槛不满足，再选择 adapter。

### 8.4 本地优先与隐私

- 默认不上传论文文本；云 embedding/chat 必须由用户显式开启并展示将发送的内容类型。
- 本地 endpoint 只允许 `127.0.0.1` / `localhost` 的 HTTP；远程默认要求 HTTPS。
- 拒绝 `file:`、`data:` 等协议，限制重定向和响应体大小。
- API key 继续进入 Credential Vault，Renderer 只看 `hasKey`。
- 本地模型按需下载到用户模型目录，记录 URL、SHA-256、许可、版本和磁盘占用；不放进发行 ZIP。
- 日志不得记录 query 全文、论文正文、embedding、Authorization 或完整 Provider URL 查询参数。

## 9. 检索、问答与引用

### 9.1 检索流水线

```text
query + document/collection scope
  -> 规范化与可选查询改写
  -> FTS 候选 + dense 候选
  -> Reciprocal Rank Fusion
  -> canonical chunk 去重
  -> 相邻 overlap 去重
  -> 每篇论文命中上限 / 多文档多样性
  -> 可选 reranker
  -> token budget 裁剪
  -> 证据 C1...Cn
```

首版建议分别取较宽候选，再向生成模型提供约 6–10 个证据块；这些数量必须是设置或算法常量并进入评测，而不是散落的 magic number。

### 9.2 回答协议

- 模型只能使用应用提供的 `[C1]`、`[C2]` 等证据 ID；
- 证据不足时必须明确拒答或说明不确定；
- 应用解析回答后验证每个 citation ID 是否存在；
- 模型生成的文件名、页码、URL 或 chunk ID 一律不直接信任；
- 未被引用的实质性结论应标记为 unsupported 或触发重试；
- 论文内容中的 prompt injection 只作为资料，不得覆盖 system/developer 指令；
- query、检索结果、最终上下文和回答分别记录耗时与 fingerprint，不记录敏感正文到普通日志。

### 9.3 引用契约

```ts
interface CitationRef {
  citationId: string
  documentId: string
  taskId: string
  revisionId: string
  chunkId: string
  contentHash: string
  title: string
  sectionPath: string[]
  pageStart?: number
  pageEnd?: number
  mappingIds: string[]
  excerpt: string
  retrievalScore: number
  rerankScore?: number
  sourceAvailable: boolean
}
```

点击引用时优先使用第一个可靠 `mappingId` 复用现有 `BlockSelection`；只有页码时跳页；两者都没有时打开论文并显示 section/excerpt。长段被切成多个 chunk 时首版只保证段落 bbox，不承诺句子级高亮。

## 10. 状态、恢复与取消

### 10.1 索引状态

```text
unindexed -> queued -> chunking -> embedding -> indexing -> ready
                 |          |           |          |
                 +----------+-----------+--------> failed

ready --artifact/model/chunker changed--> stale -> queued
```

该状态属于 `rag_documents/rag_jobs`，不修改解析任务的 `completed/partial`。

### 10.2 恢复要求

- 每批 embedding 后写 checkpoint；
- Provider 429/5xx 按可重试策略退避，4xx 配置错误直接失败；
- dimensions 与 fingerprint 不一致立即拒绝写入；
- 取消使用 `AbortSignal` 贯穿 Provider、worker 和 job；
- 应用重启后可继续未完成 revision，或安全丢弃 building revision 后重建；
- worker 崩溃只失败当前 job，不影响 Reader 和旧索引；
- 所有失败在 UI 中提供可读原因与“重试/重建”操作。

## 11. IPC 与 UI 契约

### 11.1 建议 IPC

| IPC | 作用 |
|---|---|
| `library:list` | 论文库与索引状态 |
| `library:index` | 索引选中任务 |
| `library:rebuild` | 新建 revision |
| `library:remove` | 明确的移出库语义 |
| `library:search` | 全文/混合搜索 |
| `chat:create` / `chat:list` | 会话 |
| `chat:messages` | 历史 |
| `chat:ask` | 首版非流式请求 |
| `chat:cancel` | 取消生成 |
| `chat:delta` | 后续流式事件 |
| `citation:open` | 经主进程校验后打开 Reader |
| `rag:status-changed` | 索引进度事件 |

所有输入都应有运行时 schema、大小限制、枚举白名单和 sender 校验。共享类型、preload、main handler、服务与测试必须在同一原子提交更新。

### 11.2 UI 顺序

1. 任务页先显示“加入论文库/索引状态”；
2. 新增论文库页：标题、状态、集合、索引设置、重建；
3. 新增搜索页或 Library 内搜索：结果 snippet、section、页码、打开引用；
4. 检索质量稳定后新增 Chat 页；
5. 后续加入流式、停止、重试、会话范围和引用 hover 预览。

## 12. 分阶段路线与验收

### Phase 0：锁定新 master 基线与平台边界

目标：在 RAG 开发前把 `master@10225a1` 的已合入能力、验证结果和 macOS 风险写成可复现基线。

- 更新 `ARCHITECTURE_ZH.md` 与本文的提交号、测试数字、表格翻译/标注能力和已知不一致；
- 修复或单独领取 POSIX 路径边界校验，补 Windows/POSIX 双平台单测；
- 将 `CredentialVault`、发布脚本和 Electron 生命周期列为平台 adapter，不把 Windows-only 假设带入 RAG 服务；
- typecheck、全部单测、相关 build 通过；正式 release 和真实 macOS smoke 由对应平台工作项执行。

退出条件：`master` 指向清晰提交，工作树状态可解释，RAG 服务边界不依赖 Windows 文件名/路径。

### Phase 1：迁移、artifact 与切块预览

- 正式 migration ledger；
- `DocumentArtifactService` 与 fingerprint；
- 章节感知 chunker；
- `rag_documents/revisions/chunks/jobs`；
- chunk 预览和点击 Reader 引用；
- 不调用 embedding/LLM。

退出条件：旧 DB 无损升级；同一输入重复构建 ID/顺序稳定；所有可引用 chunk 可打开正确页/块；失败不影响解析与阅读。

### Phase 2：全文搜索

- FTS5 能力探测；
- 中英字段与 tokenizer 策略；
- collection/document scope；
- 搜索结果引用跳转；
- 查询延迟和索引大小基准。

退出条件：金标关键词、标题、术语、表格查询达到约定 recall；打包 runtime 通过 FTS smoke。

### Phase 3：Embedding 与混合检索

- 独立 EmbeddingProvider；
- Vault/config/test connection；
- worker 批处理、取消、重试；
- Float32 BLOB exact vector store；
- RRF、去重和多文档均衡；
- revision 重建和缓存复用。

退出条件：维度变化、模型变化、崩溃恢复、删除和重建测试通过；真实问题集的 Recall@5/10 优于 FTS-only 基线；UI 无明显主线程卡顿。

### Phase 4：带引用问答

- 独立 ChatProvider；
- 会话、消息、scope 和引用持久化；
- ContextBuilder、拒答、证据 ID 校验；
- 点击引用回 Reader；
- 先非流式，确保正确性。

退出条件：citation precision/recall、unsupported claim rate 和无答案拒答达到门槛；每个引用均可追溯到 revision/chunk/content hash。

### Phase 5：流式、本地模型与规模化

- 流式 IPC、取消和错误恢复；
- 按需下载本地 embedding/Chat 模型或 loopback endpoint；
- 10k/50k/100k chunk 基准；
- 达到升级门槛后评测 sqlite-vec/LanceDB adapter；
- 可选 reranker、query rewrite 和多模态。

退出条件：发布包、模型目录、许可、校验、代理、离线、资源限制和安全测试完整。

## 13. 测试与评测门禁

### 13.1 单元/集成测试

- migration：空库、master 旧库、重复启动、失败回滚；
- chunk：顺序、章节继承、稳定 ID、长段、表格、公式、图片、discarded；
- provenance：mapping/page coverage、无 mapping 降级、重复导入；
- embedding：批次、缓存、429/5xx、取消、维度/NaN/空向量；
- revision：幂等、原子激活、中断、旧 revision 可用、GC；
- retrieval：FTS、dense、RRF、scope、去重、多论文均衡；
- chat：证据预算、无答案、非法 citation ID、prompt injection；
- deletion：任务、论文库、文件、聊天和外部 tombstone 组合；
- security：IPC runtime validation、sender、URL、日志脱敏、Renderer 无密钥。

### 13.2 真实评测集

维护 50–100 个有金标证据的问题，覆盖：

- 单论文与跨论文；
- 中英跨语言查询；
- 标题、摘要、方法、实验、表格、公式和图注；
- 重复术语与同名概念；
- OCR/阅读顺序缺陷；
- 资料中不存在答案的问题。

### 13.3 指标

| 层 | 指标 |
|---|---|
| 解析/切块 | 正文覆盖率、顺序、mapping/page coverage、重复率 |
| 检索 | Recall@5/10、MRR/nDCG、金标页/块命中率 |
| 生成 | citation precision/recall、unsupported claim rate、拒答准确率 |
| 交互 | 引用打开成功率、首 token/完整回答耗时、取消延迟 |
| 系统 | 构建吞吐、查询 p50/p95、峰值内存、DB/索引/模型磁盘占用 |

生成评测与检索评测必须分开，避免把错误来源混为“模型效果不好”。

## 14. 风险登记

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| 解析配置未完整快照，谱系不可复现 | 高 | Phase 1 保存 parser settings snapshot 与 artifact hash |
| `TaskService` 继续膨胀 | 高 | 先拆 artifact/job/index 服务，只提交 job |
| CPU/本地模型阻塞 Electron main | 高 | worker/utility process，取消与资源门槛 |
| 引用看似精确但 mapping 错误 | 高 | mapping confidence、页级降级、金标定位评测 |
| 云 Provider 泄露未公开论文 | 高 | 默认本地、显式 opt-in、Vault、日志脱敏 |
| 模型/维度/归一化混用 | 高 | embedding fingerprint 与写入校验 |
| 原生向量模块破坏 Windows 发布 | 高 | adapter 隔离、非 MVP、打包 smoke 与体积门禁 |
| FTS 中文分词质量不足 | 中 | tokenizer 基准、译文字段、dense 融合 |
| 原/译文重复召回 | 中 | canonical chunk + input variant 去重 |
| WAL、cache、旧 revision 膨胀 | 中 | 容量统计、LRU/TTL、显式 GC 和 VACUUM 策略 |
| 论文内容 prompt injection | 中 | 资料/指令分离、证据 ID 白名单、输出校验 |
| 删除跨 SQLite/外部索引不一致 | 中 | tombstone、重试 GC、端到端删除测试 |
| Node `node:sqlite` API 状态变化 | 中 | 锁定 Node/Electron、升级测试、Repository 隔离 |
| 发布许可元数据不一致 | 中 | 分发前统一根 LICENSE 与 desktop package 声明 |

## 15. 多 Agent 工作项地图

状态枚举：`proposed | claimed | in-progress | review | done | blocked`。只有集成 Agent 修改状态；owner 领取后必须填写分支/worktree 和证据。

| ID | 工作项 | 依赖 | 建议文件所有权 | 状态 |
|---|---|---|---|---|
| BASE-001 | 发布清理/体积门禁已合入 master | 无 | package、release scripts/tests、lockfile | done（83795dd） |
| BASE-002 | 整表翻译/阅读器标注已合入 master | 无 | translation、reader、annotation tests | done（83795dd） |
| BASE-003 | 更新现有架构基线与验证记录 | BASE-001/002 | `ARCHITECTURE_ZH.md`、本文 | done（合并后复核） |
| BASE-004 | 英文标题命名与 UI overhaul 整合 | BASE-003 | task/database、Reader E2E、EdgeDock | done（10225a1 + follow-up） |
| PORT-001 | POSIX 路径与跨平台 CredentialVault adapter | BASE-003 | `taskService.ts`、vault、security tests | proposed |
| PORT-002 | macOS arm64 打包、CI、E2E smoke | PORT-001 | package、scripts、workflow、resources | proposed |
| RAG-001 | schema migration ledger | BASE-003 | `database.ts` 或新 migration 模块 | proposed |
| RAG-002 | shared RAG contracts + runtime schema | RAG-001 | `shared/ragTypes.ts`、schema | proposed |
| RAG-003 | artifact service 与 fingerprint | RAG-001/002 | `main/rag/documentArtifactService.ts` | proposed |
| RAG-004 | chunker 与 provenance | RAG-002/003 | chunking service/tests | proposed |
| RAG-005 | revision/job repository | RAG-001/002 | rag repository/job tests | proposed |
| RAG-006 | Library UI + index IPC | RAG-002/005 | IPC/preload/LibraryPage | proposed |
| RAG-007 | FTS5 index + search | RAG-004/005 | lexical index/tests | proposed |
| RAG-008 | EmbeddingProvider + Vault/config | RAG-002 | providers/settings/tests | proposed |
| RAG-009 | worker + exact vector store | RAG-004/005/008 | worker/vector store/tests | proposed |
| RAG-010 | hybrid retriever | RAG-007/009 | retrieval/tests | proposed |
| RAG-011 | ChatProvider + context/citation | RAG-010 | chat service/tests | proposed |
| RAG-012 | Chat UI + history + citation jump | RAG-006/011 | ChatPage/Reader integration/E2E | proposed |
| RAG-013 | benchmark/evaluation harness | RAG-004/007/009 | fixtures/eval scripts | proposed |
| RAG-014 | optional ANN backend spike | RAG-013 | isolated adapter/benchmark | proposed |

高风险文件 `database.ts`、`main/index.ts`、`taskService.ts`、`shared/types.ts`、`preload/index.ts` 一次只允许一个活跃工作项占有。IPC 公共契约改动由 RAG-002/RAG-006 协调后串行集成。

### 15.1 领取模板

```text
Work item: RAG-___
Owner:
Branch/worktree:
Baseline commit:
Files owned:
Public contracts affected:
Expected tests:
Out of scope:
```

### 15.2 完成模板

```text
Work item: RAG-___
Result:
Commits:
Files changed:
Contracts/migrations:
Commands run and results:
Known limitations:
Follow-up IDs:
Final git status:
```

## 16. 工作目录简洁性规则

“简洁”不是强行得到 clean status，而是状态可解释、无意外产物、每项改动有归属。

- 开始前记录 status，结束后比较差异；
- 不删除或还原进入任务前已经存在的修改；
- 每个提交只包含一个主题及其完整依赖；
- `node_modules/`、`desktop/out/`、`release/` 等生成目录不提交；
- 临时 fixture 放系统 temp 或测试专用目录，并在测试后清理；
- 不在仓库根留下 patch、日志、下载模型、解压包或临时 DB；
- 不用“全仓格式化”制造与功能无关的 diff；
- release 清理属于显式工作项，不能在普通测试中删除用户发布产物；
- 提交前运行 `git diff --check`、typecheck 和相关测试；
- 若工作树进入任务前已 dirty，最终报告必须列出“原有修改”和“本次新增修改”。

2026-09-01 复核时 `master` 工作树为 clean；本次只会产生本文和架构文档的明确修订，构建生成的 `desktop/out/` 保持 ignored。历史快照中的 `node_modules/`、`release/`、Playwright report/test-results 大小不再视为当前容量事实；正式 release 脚本会删除整个 `release/`，未经明确工作项不得调用。

## 17. 决策记录

| ID | 日期 | 决策 | 状态 |
|---|---|---|---|
| ADR-001 | 2026-08-31 | RAG MVP 在 Desktop TypeScript 层实现，不修改 Python MinerU | accepted |
| ADR-002 | 2026-08-31 | 先做可搜索、可点击、可重建论文库，再做聊天 | accepted |
| ADR-003 | 2026-08-31 | 解析状态与索引状态分离 | accepted |
| ADR-004 | 2026-08-31 | 原文为规范语料，译文是辅助检索字段 | accepted |
| ADR-005 | 2026-08-31 | 首版 SQLite BLOB 精确检索；ANN 只在基准失败后评测 | accepted |
| ADR-006 | 2026-08-31 | 索引采用不可变 revision 与原子激活 | accepted |
| ADR-007 | 2026-08-31 | Embedding、Chat、VectorStore 独立于 TranslationProvider | accepted |
| ADR-008 | 2026-08-31 | 云 Provider 默认关闭并要求显式隐私授权 | accepted |

修改 accepted 决策时不要覆盖原行；新增 superseding ADR，并说明迁移与兼容影响。

## 18. 证据与外部参考

### 18.1 仓库证据

- 当前架构：`ARCHITECTURE_ZH.md`
- Desktop 使用说明：`desktop/README_zh-CN.md`
- 公共契约：`desktop/src/shared/types.ts`
- SQLite：`desktop/src/main/database.ts`
- 任务与产物：`desktop/src/main/taskService.ts`
- Markdown 逻辑块：`desktop/src/shared/markdownBlocks.ts`
- PDF 版面映射：`desktop/src/main/blockMapping.ts`
- 阅读映射：`desktop/src/shared/readerDocument.ts`
- Reader 标注：`desktop/src/shared/readerAnnotations.ts`、`desktop/src/renderer/readerAnnotations.ts`
- Provider：`desktop/src/main/translation/providers.ts`
- 整表翻译：`desktop/src/main/translation/tableTranslation.ts`
- Electron 安全边界：`desktop/src/main/index.ts`、`desktop/src/preload/index.ts`

### 18.2 官方资料（核对日期：2026-09-01）

- Node `node:sqlite`：<https://nodejs.org/api/sqlite.html>。`DatabaseSync` API 同步执行，因此重型扫描不得留在 Electron main 事件循环。
- SQLite FTS5：<https://www.sqlite.org/fts5.html>。
- Electron utility process：<https://www.electronjs.org/docs/latest/api/utility-process>。
- Electron 安全清单：<https://www.electronjs.org/docs/latest/tutorial/security>，特别是 context isolation、sandbox、最小 preload API 与 IPC sender 校验。
- Electron macOS 签名与公证：<https://www.electronjs.org/docs/latest/tutorial/code-signing>；Keychain/safeStorage 等能力不能只用未签名开发包判断。
- Electron app 生命周期：<https://www.electronjs.org/docs/latest/api/app>；`activate` 与 `window-all-closed` 在 macOS 上需要单独验收。
- Electron 原生模块 ABI：<https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules>；`@napi-rs/keyring` 的 darwin 包仍需按 Electron 版本打包 smoke。
- sqlite-vec 安装/扩展说明：<https://github.com/asg017/sqlite-vec/blob/main/site/getting-started/installation.md>。
- LanceDB embedded quickstart：<https://docs.lancedb.com/quickstart>。
- Qdrant local quickstart：<https://qdrant.tech/documentation/quick-start/>。其服务默认无认证，若作为高级后端必须单独加固。

## 19. 下一步

下一位集成 Agent 应先完成 `BASE-003`，并为 `PORT-001` 与 `RAG-001` 分配不重叠的 owner；`database.ts`、`taskService.ts`、`main/index.ts`、`shared/types.ts`、`preload/index.ts` 仍按高风险文件串行占有。当前 `master` 已 clean，不需要再拆分旧 WIP；任何 Agent 仍必须在开始和结束时记录 status，并在 macOS 相关改动合入前提供真实 Mac 验收证据。
