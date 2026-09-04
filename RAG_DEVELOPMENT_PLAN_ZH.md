---
document_id: mineru-desktop-rag-development-plan
document_version: 4
status: proposed
baseline_ref: refactor/p0-p1-architecture
baseline_verified_at: 2026-09-04
scope: RAG future design on the P0/P1 Desktop boundary
---

# MinerU Desktop 论文知识库与 RAG 开发计划

> 本文是未来切块、索引、向量检索和论文问答的规划入口。它不宣布任何 RAG 功能已经存在。当前架构事实见 `ARCHITECTURE_ZH.md`；若规划与源码、schema 或测试冲突，以当前实现为准，并把差异记为后续事项。

## 0. 当前状态：明确未实现

P0/P1 当前**尚未实现 RAG**。仓库中没有：

- chunk 生成器或 chunk 持久化；
- 文档索引服务、全文索引/FTS/FTS5 表；
- embedding provider、embedding 任务或 embedding cache；
- vector store、ANN 或精确向量检索；
- reranker、retrieval service、query backend；
- chat provider、聊天会话/消息、流式回答或引用后端。

`ReaderChatSelection` 和 `ReaderChatSelectionFragment` 只是 Renderer 侧的类型化选区 payload；它不是聊天 API，不代表存在 IPC、会话、模型调用、检索、引用或历史。阅读器已有的 PDF/Markdown mapping 可以成为未来 provenance 的输入，但不能被称为 RAG。

因此本文件的所有 `planned`、`proposed`、端口、数据表、指标和阶段都是未来设计；在对应实现、migration、测试、评测和隐私审查合入前，不得在 README、UI、发布说明或 issue 中写成“支持知识库问答”。

## 1. 设计前提与非目标

### 1.1 必须继承的 P0/P1 事实

| 边界 | 约束 |
|---|---|
| Runtime | Electron `44.1.1`、Node `24.19.0` |
| 进程 | Renderer → Zod 验证的 Preload 领域 API → Main 协调/net/credential → Utility SQLite/compute |
| RPC | versioned request/response/event envelope、UUID requestId、JSON、payload/envelope 各 ≤ `1 MiB`、timeout/cancel/restart |
| 持久化 | `%APPDATA%\MinerU-Translation-v2\mineru-desktop-v2.sqlite3`；Utility 独占 SQLite 连接；STRICT migration ledger |
| 文档产物 | `<outputRoot>\documents-v2\{documentId}`；artifact 有 revision、hash、job 归属和受 PathPolicy 保护的相对路径 |
| 作业 | durable parse/translate jobs，lease、heartbeat、checkpoint、retry、过期恢复 |
| 文件 | 流式输入、专属 staging、fsync/atomic rename、成功后登记 artifact；结果 ZIP 排除内部目录 |
| 密钥 | Token/API Key 只在 Main/Credential Vault；Renderer 与 SQLite 不得到明文 |

RAG 不能把数据库连接、重型向量扫描、模型推理或任意网络引入 Renderer/Main 事件循环；必须复用 Utility/compute 和显式 Provider port。

### 1.2 首版非目标

首版不强制加入 Python 本地模型、第二个数据库、Qdrant/LanceDB、`sqlite-vec`、LangChain、图像 embedding、自动 query rewrite、多租户云同步或自动上传全文。任何新增原生模块、模型权重或网络服务都必须先有体积、ABI、许可、隐私、取消、崩溃恢复和发布 smoke 证据。

## 2. 目标架构（未来）

```text
Reader/Library UI
  -> Preload RAG domain API（Zod request/response/event）
  -> Main 权限、scope、job orchestration、credential、network adapter
  -> Utility Core RPC（≤1 MiB JSON；不传正文/向量）
       ├─ ArtifactReader / Chunker / provenance
       ├─ STRICT SQLite metadata + FTS index
       ├─ embedding worker/provider adapter
       ├─ VectorStore（首版可 exact Float32）
       └─ RAG durable jobs/checkpoints
  -> Retriever（lexical + dense + optional reranker）
  -> CitationResolver（验证 hash/mapping/page）
  -> ChatProvider（可选云端/本地，显式授权）
  -> 流式回答事件 + 可点击 Reader citation
```

责任保持清晰：Renderer 负责搜索/聊天交互和引用跳转；Preload 只公开最小领域 API；Main 负责权限、作业、Provider、网络和隐私提示；Utility 负责持久化、切块、索引、embedding 批处理和向量计算。正文、查询全文、embedding 和模型响应不直接通过 Core RPC 发送，应通过 Utility 侧 artifact/job/token 或受控小批次协议处理。

## 3. 未来端口与公共契约

以下是 planned ports，名称和字段可在实现前调整，但必须保持依赖倒置、可测试和可替换：

| 端口 | 所属/职责 | 必须验证 |
|---|---|---|
| `ArtifactReaderPort` | Utility 读取已发布 Markdown/layout/mapping/manifest | documentId、artifact revision、hash、PathPolicy |
| `ChunkerPort` | 从规范 artifact 生成有序 chunk | chunker version、最大长度、稳定 ID、取消 |
| `EmbeddingProviderPort` | 远程或本地生成向量 | provider/model/dimensions/metric、Key、timeout、429/5xx、NaN |
| `EmbeddingWorkerPort` | Utility worker/utility process 批处理 embedding | 背压、取消、内存和崩溃恢复 |
| `LexicalIndexPort` | 创建/查询 FTS5 或兼容 lexical index | tokenizer 能力、scope、revision、删除 |
| `VectorStorePort` | 写入/删除/查询 Float32 或 ANN 后端 | profile fingerprint、维度、距离、revision、原子 rebuild |
| `RetrieverPort` | 融合 lexical/dense 候选 | scope、去重、top-k、score provenance |
| `RerankerPort` | 可选二次排序 | 输入上限、模型指纹、超时、不可用时退化 |
| `CitationResolverPort` | 将候选验证并映射到 Reader | content hash、mappingIds、页码、offset 单位 |
| `ChatProviderPort` | 生成回答/流事件 | 显式授权、上下文上限、取消、无答案策略 |
| `RagJobRepositoryPort` | 持久化 chunk/index/embed/rebuild/chat jobs | lease、checkpoint、retry、幂等、状态机 |

新增 Renderer API 仍必须遵循现有 IPC envelope、sender 检查、Zod schema、1 MiB、超时和事件取消规则。RAG 不得暴露通用 URL、SQL、文件路径、API Key 或任意模型代理。

## 4. 数据模型与迁移

当前 v2 schema 没有 RAG 表。未来新增表必须使用连续、可校验 checksum 的 STRICT migration；空库、已有 v2 库、重复启动、checksum mismatch、事务回滚和删除恢复都必须测试。建议的最小模型如下：

| 表 | 关键字段 | 语义/所有者 |
|---|---|---|
| `rag_documents` | `document_id`, `source_artifact_id`, `source_hash`, `state`, `error` | 一个 v2 document 的 RAG 投影；Utility |
| `rag_revisions` | `revision_id`, `document_id`, `artifact_hash`, `chunker_fingerprint`, `embedding_profile`, `state` | 不可变索引代次；重建产生新 revision |
| `rag_chunks` | `chunk_id`, `revision_id`, `ordinal`, `content_hash`, `source_text`, `translated_text`, `section_path`, `mapping_ids`, `page_start/end`, `offsets`, `token_count`, `content_type` | 检索单元及完整 provenance |
| `rag_embeddings` | `revision_id`, `chunk_id`, `profile_id`, `dimensions`, `metric`, `normalized`, `vector_blob` | 与 revision/profile 绑定的 Float32 或 adapter 数据 |
| `rag_embedding_cache` | `profile_fingerprint`, `content_hash`, `dimensions`, `vector_blob`, `created_at` | 可容量治理的跨 revision 缓存；不能绕过来源校验 |
| `rag_fts` | `revision_id`, `chunk_id`, `source`, `translated`, `title`, `section` | FTS5 external-content 或等价 lexical index；不保存密钥 |
| `rag_jobs` | `job_id`, `document_id`, `revision_id`, `stage`, `status`, `lease_*`, `checkpoint_json`, `attempt`, `error` | RAG 作业；复用 durable job 原则 |
| `rag_queries` | `query_id`, `scope`, `query_hash`, `created_at`, `privacy_mode` | 只保存最小可选诊断，不默认保存全文 query |
| `rag_conversations`/`rag_messages` | `conversation_id`, `message_id`, `role`, `content_ref`, `created_at` | 用户显式开启历史后才保存；敏感内容治理 |
| `rag_citations` | `message_id`, `ordinal`, `revision_id`, `chunk_id`, `content_hash`, `excerpt`, `mapping_ids`, `page_start/end`, `scores` | 回答时的不可变引用快照；支持源不可用标记 |

所有外键、document scope、revision scope 和删除级联必须在数据库约束中表达。FTS、向量后端或外部索引如果不能同事务更新，必须有状态、重试、tombstone 和重建任务，不得宣称已删除而仍可召回。

## 5. Artifact 指纹、稳定身份与切块规范

### 5.1 指纹与谱系

规范输入是已登记的 parsed Markdown artifact；翻译 Markdown 是辅助字段，不替代原文。建议：

```text
artifact_hash = sha256(canonical artifact bytes + mapping/layout revision)
chunker_fingerprint = version + rules + parser settings snapshot
embedding_fingerprint = provider + model + dimensions + normalization + metric
embedding_cache_key = embedding_fingerprint + content_hash
chunk_id = sha256(document scope + revision input + ordinal/content identity)
```

解析配置、artifact hash、chunker fingerprint 或 embedding profile 改变时创建新 revision；不能静默重写旧 chunk/向量。现有 `BlockMapping.id` 含 document 语义，适合当前 Reader 定位，不直接当作跨导入/跨 revision 的 canonical chunk ID。

### 5.2 Chunk 最低契约

每个 chunk 至少携带：

```ts
type PlannedChunk = {
  chunkId: string
  revisionId: string
  ordinal: number
  contentHash: string
  sourceText: string
  translatedText: string | null
  sectionPath: string[]
  mappingIds: string[]
  pageStart: number | null
  pageEnd: number | null
  sourceStartOffset: number | null
  sourceEndOffset: number | null
  offsetUnit: 'utf16'
  contentType: 'paragraph' | 'heading' | 'table' | 'formula' | 'caption' | 'code' | 'list' | 'other'
}
```

规则：

1. 按 Markdown AST/逻辑 block 切分，保持原顺序；标题继承到正文上下文，不制造无上下文孤立 chunk。
2. 长段按语义边界和重叠上限切分；表格保留表头、caption/footnote 与 cell provenance，不截断成无效 JSON/Markdown。
3. 公式、代码、引用、图片 caption 采用显式 content type；首版不做图片视觉 embedding。
4. source 是规范语料；translated 仅用于辅助 lexical 或按显式 variant 生成 embedding。原文/译文候选必须按 canonical chunk 去重。
5. 记录 mappingIds、page range、section path、内容 hash 和 mapping confidence；无可靠映射时只能降级为文档/页/章节引用，不能声称句子级 bbox。
6. Offset 使用 JavaScript UTF-16；未来跨语言处理必须显式声明转换，不得把字节 offset 当字符 offset。

## 6. 索引、Embedding 与向量后端

### 6.1 Lexical/FTS

实现前先探测打包 Electron runtime 的 FTS5 能力和 tokenizer。若中文分词不可用，必须用可重复的 tokenizer fixture、译文字段或替代 lexical adapter，并在设置页说明召回限制。FTS index 必须绑定 revision/chunkId、支持增量/重建/删除和崩溃恢复；它不是当前 v2 `settings` 或 `translation_cache` 的替代。

### 6.2 Embedding provider

Embedding 是独立 Provider，不得假设翻译 endpoint 支持 `/embeddings`。配置至少包括 provider、base URL、model、dimensions、metric、归一化、batch/timeout；API Key 继续由 Main Credential Vault 管理，Renderer 仅见 `hasKey`。

每批都要验证向量长度、数值有限、非全空、profile fingerprint 和 document/revision 归属。429/5xx/网络错误要可重试并写 checkpoint；用户取消、超时、Utility 崩溃和模型维度变化要可恢复且不污染旧 revision。

### 6.3 首选后端与扩展边界

首版可以在 Utility worker 中对 SQLite Float32 BLOB 做精确余弦扫描，先基准再决定 ANN。不得仅凭直觉加入原生 ANN 扩展；`sqlite-vec` 或其他后端只能通过 `VectorStorePort`，并提供 Windows 依赖、ASAR unpack、ABI、体积、fuse、删除一致性和 packaged smoke 证据。

最低基准集建议覆盖 10k/50k/100k chunks：query p50/p95、构建时间、峰值内存、索引大小、批量恢复时间和发布包增量。只有在目标硬件的实际门槛不满足时才引入 ANN。

## 7. 检索、重排、问答与引用

### 7.1 检索流水线

```text
query（用户显式提交）
  -> scope/filter（选中文档、库、语言、revision）
  -> lexical candidates（BM25/FTS）
  -> dense candidates（embedding/vector）
  -> canonical chunk 去重与 provenance 合并
  -> RRF/可解释融合
  -> optional reranker（失败则退化）
  -> context budget + citation validation
  -> ChatProvider 或“无足够证据”
```

混合检索必须记录候选来源和分数，避免原文/译文重复占满 top-k；多论文 scope 要有公平性和去重测试。Reranker 是可选的二次排序器，不得绕过初始 scope、hash 或敏感内容政策。

### 7.2 回答协议

回答只能引用应用生成并验证过的 `citationId`/`chunkId`；模型生成的路径、URL、页码、mapping 或 chunk ID 一律当作不可信文本。若候选不足、引用 hash 不匹配、Provider 不可用或用户未授权外发，返回明确无答案/需配置状态，不编造结论。

流式协议未来应传小型事件（started/delta/citation/complete/error/cancelled），大正文保存在受控 artifact/消息引用中；每个事件要有 conversation/request ID、顺序和上限。取消应同时停止 ChatProvider、检索/重排任务和 UI 订阅，不留下假完成消息。

### 7.3 Citation 契约

```ts
type Citation = {
  citationId: string
  revisionId: string
  chunkId: string
  contentHash: string
  excerpt: string
  mappingIds: string[]
  pageStart: number | null
  pageEnd: number | null
  retrievalScore: number
  source: 'lexical' | 'dense' | 'hybrid'
}
```

打开引用时优先复用可靠 `mappingId` 跳 Reader；只有页码时跳页；都没有时打开文档并显示章节/excerpt。引用快照记录 revision/content hash，即使用户之后删除文档也必须显示 source unavailable，而不能映射到同 ID 的新内容。

## 8. 状态、恢复、删除与隐私

### 8.1 未来 RAG 状态

```text
unindexed -> queued -> chunking -> lexical-indexing
                     -> embedding -> vector-indexing -> ready
ready --artifact/settings/model changed--> stale -> queued
任何阶段 --cancel/error--> partial/failed
```

每批 chunk/index/embedding 后更新 durable checkpoint；lease 过期由 Utility repository 恢复；重启后根据 revision/content hash 跳过已提交批次。旧 revision 保持只读，直到新 revision ready 并完成原子切换。

### 8.2 删除语义

用户删除文档时，先停止/取消其 RAG jobs，再删除或 tombstone `rag_documents`、chunks、FTS、向量和 cache。回答引用可保留最小快照并标记 source unavailable；用户选择彻底删除时还必须清理 excerpt、消息正文、query 和外部索引。任何跨 SQLite/外部向量后端的删除都要可重试、可审计，不能仅删除 UI 列表。

### 8.3 隐私与安全门槛

- 默认本地优先，不上传论文正文、query、选区或 embedding；云 embedding/chat 必须逐 Provider 显式启用，并在 UI 告知发送内容类型。
- API Key 只进 Credential Vault；不写 SQLite、日志、RAG 表、Renderer 或 artifact ZIP。
- 日志只保留 operation/job/provider code、耗时和计数；不记录 query 全文、论文正文、embedding、Authorization、预签名 URL 或完整回答。
- scope 和 documentId 必须在每个检索、引用、chat 和删除操作上验证；不能接受模型回传的路径和任意 URL。
- 模型/索引目录必须使用 PathPolicy，拒绝 symlink、`..`、跨 root 和未校验压缩条目；本地模型/ANN 需要完整供应链、许可和 hash 校验。
- 用户删除、导出、历史保留期限和云端 Provider 的数据处理须有可见设置；不能以“本地应用”暗示云端零留存。

## 9. 分阶段路线与 DoD

| 阶段 | 交付范围 | 退出 DoD |
|---|---|---|
| RAG-0 契约/谱系 | planned schema、migration ledger 扩展、artifact fingerprint、ports、隐私设置 | 空库与 v2 升级/回滚/checksum 测试；无 RAG 表在功能未实现时被误用 |
| RAG-1 切块预览 | `ChunkerPort`、稳定 chunk ID、mapping/page provenance、预览 IPC/UI | 同输入顺序/ID 稳定；长段、表格、公式、代码、跨页和低置信 mapping fixture 通过；不调用模型 |
| RAG-2 全文搜索 | FTS5 探测、词法 index、scope、增量/重建/删除 | tokenizer/打包 runtime smoke；金标关键词/标题/术语 recall 达到评测门槛；崩溃恢复通过 |
| RAG-3 Embedding/向量 | provider、Vault 配置、batch worker、Float32 exact store、cache | 维度/NaN/profile 校验；429/5xx/取消/lease/restart/删除/重建测试；p95/内存基准有记录 |
| RAG-4 混合检索 | lexical+dense、RRF、去重、可选 reranker | scope 隔离；Recall@5/10 优于 FTS-only 基线或明确解释退化；分数/provenance 可审计 |
| RAG-5 问答/引用 | ChatProvider、流式事件、历史、CitationResolver、Reader 跳转 | 每条引用 hash/mapping/page 可验证；unsupported claim rate、citation precision/recall、无答案拒答达标；取消/重启/删除通过 |
| RAG-6 发布/规模化 | 本地模型/ANN（可选）、10k/50k/100k benchmark、权限/许可/离线策略 | 体积、ABI、路径、许可、隐私、代理、离线、CI、packaged smoke 与 verified atomic release 全部有证据 |

### 总体 RAG DoD

RAG 只有同时满足以下条件才可从 proposed 改为 implemented：

1. schema/migration、ports、IPC/preload 和错误/取消协议已在源码中实现；
2. chunk、index、embedding、vector、retrieval、chat、citation 的状态和 ownership 可由代码复现；
3. 解析 artifact 或 parser settings 改变时 revision 可重建，失败不破坏旧 revision；
4. 文档删除、缓存清理、历史保留和云端外发都有用户可见语义与测试；
5. 实际 coverage gate 仍满足 lines/statements/functions `80%`、branches `75%`，并有专项集成/评测结果；
6. Windows 发布的完整目录、manifest/hash、packaged CLI smoke 和原子 release 验证通过；
7. 不把当前 ReaderChatSelection 或 UI 占位按钮作为聊天能力证据。

## 10. 评测、测试与门禁

### 10.1 工程测试

必须覆盖：migration 空库/升级/回滚/checksum、chunk 稳定性和 provenance、FTS tokenizer/重建/删除、embedding batch/cache/维度/限流/取消、vector profile 隔离、retrieval scope/去重/RRF、reranker 降级、chat 流式顺序/取消、citation hash/mapping/page 校验、日志脱敏、Renderer 无密钥、PathPolicy 和 Utility 崩溃恢复。

工程 coverage gate 不是 RAG 目标值，而是当前 Desktop 的实际 gate：lines `80%`、statements `80%`、functions `80%`、branches `75%`，由 `desktop/vitest.config.ts` 在 `pnpm desktop:test:coverage` 中执行；覆盖范围和排除项以该配置为准。RAG 新代码必须纳入合适的 include，而不是通过扩大 exclude 降低门槛。

### 10.2 评测集与指标

在实现前建立版本化、去敏的论文集合和金标问题：标题/术语/跨页段落/表格/公式/多论文/无答案/恶意 prompt。至少报告：chunk 顺序/覆盖/重复率、mapping/page coverage、Recall@5/10、MRR/nDCG、hybrid 相对 FTS-only 增益、citation precision/recall、unsupported claim rate、拒答准确率、首 token/完整回答延迟、取消延迟、内存/索引大小。指标是未来阶段门槛，不应伪造当前结果。

## 11. 多 Agent 协作与变更纪律

1. 一个工作项一个 owner；同一工作树同一时刻不允许多个 Agent 修改同一文件。并行实现使用独立 branch/worktree，集成时保留最小 diff。
2. `shared/*` schema、Preload API、Main IPC、Core RPC、v2 migration、JobRepository、Artifact/PathPolicy、release scripts 是高风险边界；修改前先登记 owner、输入/输出、兼容策略、失败恢复和测试。
3. 文档、schema、migration、实现和测试必须同步；新增 RAG 表或 Provider 前先完成 RAG-0，不能在普通任务中顺手改公共数据结构。
4. Agent 开始/结束都记录 `git status --short --branch`；不得覆盖他人改动、`reset`、stash、清理 release 或修改其他 worktree。
5. 每个工作项标注 `planned`、`implemented`、`verified` 或 `blocked`，并附源码/测试/评测证据。未运行的 package/E2E 不得写成通过。
6. 文档维护 owner 负责 baseline、公共契约、决策记录和总进度；实现 Agent 只修改领取的代码和测试。任何契约变更都要通知集成 Agent。
7. 不以“模型返回了页码/路径/引用”为可信证据；必须由应用端 schema、scope、hash 和 PathPolicy 验证。

## 12. 当前平台与发布限制

在当前 Windows build `26200` + GameViewer 环境，sandboxed Renderer/GPU 原生启动失败；本机没有 GUI E2E 通过证据。不得声称 Desktop GUI E2E 本机通过，也不得建议产品默认或 CI 降低 sandbox。专用 packaged CLI smoke 已通过，且不启动 Renderer；它只能证明打包入口的 CLI 启动 marker，不证明 UI、GPU、Renderer 或 RAG。

RAG 实现若增加 worker、模型或原生 vector backend，必须复用 Desktop 的 verified atomic release：所有内容先在精确 release staging 中构建、审计、解压校验、哈希和 packaged smoke 成功，再原子发布到 `release/`；失败保留 staging/恢复旧 release。不得把 RAG 目录、模型缓存、查询历史或密钥放进 release ZIP。

## 13. 已知后续事项

根仓库许可证文件和 `desktop/package.json` 的许可证元数据目前不一致；这只登记为后续法务/发布事项，本计划不修改许可证文本、package 声明或署名信息。RAG 的模型、FTS tokenizer、向量后端、云端 Provider 和数据保留策略都需在对应阶段单独完成许可与隐私评审。
