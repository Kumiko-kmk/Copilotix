---
document_id: mineru-desktop-rag-development-plan
document_version: 4
status: proposed
baseline_ref: refactor/p0-p1-architecture
baseline_verified_at: 2026-09-04
scope: future RAG design on the P0/P1 Desktop boundary
---

# MinerU Desktop 论文知识库与 RAG 开发计划

> 本文是未来切块、索引、向量检索和论文问答的规划入口。它不宣布任何 RAG 功能已经存在。当前架构事实见 `ARCHITECTURE_ZH.md`；若规划与源码、schema 或测试冲突，以当前实现为准，并把差异登记为后续事项。

## 0. 当前状态：明确未实现

P0/P1 当前**尚未实现 RAG**。仓库中没有 chunk 生成器/持久化、文档索引、embedding provider、vector store、SQLite FTS/FTS5、reranker、retrieval service、query backend、chat provider、聊天会话/消息、流式回答或引用后端。

`ReaderChatSelection` 和 `ReaderChatSelectionFragment` 只是 Renderer 侧的类型化选区 payload；它不是聊天 API，不代表存在 IPC、会话、模型调用、检索、引用或历史。阅读器已有 PDF/Markdown mapping 可以成为未来 provenance 的输入，但不能被称为 RAG。

本文件的 `planned`、`proposed`、端口、数据表、指标和阶段都是未来设计；在实现、migration、测试、评测和隐私审查合入前，不得在 README、UI、发布说明或 issue 中写成“支持知识库问答”。

## 1. 设计前提与非目标

### 1.1 必须继承的 P0/P1 事实

| 边界 | 约束 |
|---|---|
| Runtime | Electron `44.1.1`、Node `24.19.0` |
| 进程 | Renderer → Zod 验证的 Preload 领域 API → Main 协调/net/credential → Utility SQLite/compute |
| RPC | versioned request/response/event envelope、UUID requestId、JSON、payload/envelope 各 ≤ `1 MiB`、timeout/cancel/restart |
| 持久化 | `%APPDATA%\MinerU-Translation-v2\mineru-desktop-v2.sqlite3`；Utility 独占连接；STRICT migration ledger |
| 文档产物 | `<outputRoot>\documents-v2\{documentId}`；artifact 有 revision、hash、job 归属和 PathPolicy 相对路径 |
| 作业 | durable parse/translate jobs，lease、heartbeat、checkpoint、retry、过期恢复 |
| 文件 | 流式输入、专属 staging、fsync/atomic rename、成功后登记 artifact；结果 ZIP 排除内部目录 |
| 密钥 | Token/API Key 只在 Main/Credential Vault；Renderer 与 SQLite 不得到明文 |

RAG 不得把数据库连接、重型向量扫描、模型推理或任意网络引入 Renderer/Main 事件循环；必须复用 Utility/compute 和显式 Provider port。

### 1.2 首版非目标

首版不强制加入 Python 本地模型、第二个数据库、Qdrant/LanceDB、`sqlite-vec`、LangChain、图像 embedding、自动 query rewrite、多租户云同步或自动上传全文。任何新增原生模块、模型权重或网络服务都必须先有体积、ABI、许可、隐私、取消、崩溃恢复和发布 smoke 证据。

## 2. 目标架构（未来）

```text
Reader/Library UI
  -> Preload RAG domain API（Zod request/response/event）
  -> Main（权限、scope、作业编排、credential、network adapter）
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

Renderer 负责搜索/聊天交互和引用跳转；Preload 只公开最小领域 API；Main 负责权限、作业、Provider、网络和隐私提示；Utility 负责持久化、切块、索引、embedding 批处理和向量计算。正文、查询全文、embedding 和模型响应不直接通过 Core RPC 发送，应通过 Utility 侧 artifact/job/token 或受控小批次协议处理。

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
| `RagJobRepositoryPort` | 持久化 RAG jobs | lease、checkpoint、retry、幂等、状态机 |

新增 Renderer API 仍必须遵循现有 IPC envelope、sender 检查、Zod schema、1 MiB、超时和事件取消规则。RAG 不得暴露通用 URL、SQL、文件路径、API Key 或任意模型代理。

## 4. 数据模型与迁移

当前 v2 schema 没有 RAG 表。未来新增表必须使用连续、可校验 checksum 的 STRICT migration；空库、已有 v2 库、重复启动、checksum mismatch、事务回滚和删除恢复都必须测试。建议最小模型：

| 表 | 关键字段 | 语义/所有者 |
|---|---|---|
| `rag_documents` | `document_id`, `source_artifact_id`, `source_hash`, `state`, `error` | v2 document 的 RAG 投影；Utility |
| `rag_revisions` | `revision_id`, `document_id`, `artifact_hash`, `chunker_fingerprint`, `embedding_profile`, `state` | 不可变索引代次；重建产生新 revision |
| `rag_chunks` | `chunk_id`, `revision_id`, `ordinal`, `content_hash`, `source_text`, `translated_text`, `section_path`, `mapping_ids`, `page_start/end`, `offsets`, `token_count`, `content_type` | 检索单元及 provenance |
| `rag_embeddings` | `revision_id`, `chunk_id`, `profile_id`, `dimensions`, `metric`, `normalized`, `vector_blob` | 与 revision/profile 绑定的向量 |
| `rag_embedding_cache` | `profile_fingerprint`, `content_hash`, `dimensions`, `vector_blob`, `created_at` | 可治理的跨 revision 缓存 |
| `rag_fts` | `revision_id`, `chunk_id`, `source`, `translated`, `title`, `section` | FTS5/external-content lexical index |
| `rag_jobs` | `job_id`, `document_id`, `revision_id`, `stage`, `status`, `lease_*`, `checkpoint_json`, `attempt`, `error` | RAG 作业，复用 durable job 原则 |
| `rag_queries` | `query_id`, `scope`, `query_hash`, `created_at`, `privacy_mode` | 只保存最小可选诊断，默认不存全文 |
| `rag_conversations`/`rag_messages` | `conversation_id`, `message_id`, `role`, `content_ref`, `created_at` | 用户显式开启历史后才保存 |
| `rag_citations` | `message_id`, `ordinal`, `revision_id`, `chunk_id`, `content_hash`, `excerpt`, `mapping_ids`, `page_start/end`, `scores` | 回答引用快照；支持 source unavailable |

所有外键、document scope、revision scope 和删除级联必须在数据库约束中表达。FTS、向量后端或外部索引如果不能同事务更新，必须有状态、重试、tombstone 和重建任务，不得宣称已删除而仍可召回。

## 5. 指纹、稳定身份与切块规范

规范输入是已登记的 parsed Markdown artifact；翻译 Markdown 是辅助字段，不替代原文。建议：

```text
artifact_hash = sha256(canonical artifact bytes + mapping/layout revision)
chunker_fingerprint = version + rules + parser settings snapshot
embedding_fingerprint = provider + model + dimensions + normalization + metric
embedding_cache_key = embedding_fingerprint + content_hash
chunk_id = sha256(document scope + revision input + ordinal/content identity)
```

解析配置、artifact hash、chunker fingerprint 或 embedding profile 改变时创建新 revision；不能静默重写旧 chunk/向量。现有 `BlockMapping.id` 适合当前 Reader 定位，不直接当作跨导入/跨 revision 的 canonical chunk ID。

每个 chunk 至少携带 `chunkId`、`revisionId`、`ordinal`、`contentHash`、`sourceText`、可选 `translatedText`、`sectionPath`、`mappingIds`、page range、source offsets、`offsetUnit: utf16`、token count 和 content type。按 Markdown AST/逻辑 block 保序；标题继承到正文上下文；长段、表格、公式、代码、caption 和跨页内容都有显式规则；无可靠 mapping 时只能降级为文档/页/章节引用。

source 是规范语料，translated 仅作辅助 lexical 或显式 variant embedding；原文/译文候选按 canonical chunk 去重。首版不做图片视觉 embedding，模型不得返回未经应用验证的路径、页码、mapping 或 chunk ID。

## 6. 索引、Embedding 与向量后端

实现前先探测打包 Electron runtime 的 FTS5 能力和 tokenizer。若中文分词不可用，必须用可重复 tokenizer fixture、译文字段或替代 lexical adapter，并在设置页说明召回限制。FTS 必须绑定 revision/chunkId，支持增量/重建/删除和崩溃恢复。

Embedding 是独立 Provider，不得假设翻译 endpoint 支持 `/embeddings`。配置至少包括 provider、base URL、model、dimensions、metric、归一化、batch/timeout；API Key 继续由 Main Credential Vault 管理，Renderer 仅见 `hasKey`。每批验证向量长度、有限数值、非空、profile fingerprint 和 document/revision 归属。

首版可以在 Utility worker 中对 SQLite Float32 BLOB 做精确余弦扫描，先基准再决定 ANN。不得仅凭直觉加入原生 ANN 扩展；任何 ANN adapter 都要提供 Windows 依赖、ASAR unpack、ABI、体积、许可、删除一致性和 packaged smoke 证据。建议对 10k/50k/100k chunks 记录 query p50/p95、构建时间、峰值内存、索引大小和恢复时间。

## 7. 检索、问答与引用

```text
query -> scope/filter -> lexical candidates + dense candidates
      -> canonical chunk 去重 -> RRF/可解释融合
      -> optional reranker -> context budget + citation validation
      -> ChatProvider 或“无足够证据”
```

混合检索必须记录候选来源和分数，避免原文/译文重复占满 top-k；多论文 scope 要有公平性和去重测试。Reranker 不得绕过初始 scope、hash 或敏感内容政策。

回答只能引用应用生成并验证过的 citation/chunk。若候选不足、引用 hash 不匹配、Provider 不可用或用户未授权外发，返回明确无答案/需配置状态，不编造结论。未来流式协议只传有序的小型 `started/delta/citation/complete/error/cancelled` 事件；正文保存在受控 artifact/消息引用中，并可取消。

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

点击引用时优先用可靠 `mappingId` 跳 Reader；只有页码时跳页；都没有时打开文档并显示章节/excerpt。引用保存 revision/content hash；文档删除后显示 source unavailable，而不能映射到新内容。

## 8. 状态、恢复、删除与安全

未来索引状态：

```text
unindexed -> queued -> chunking -> lexical-indexing
                     -> embedding -> vector-indexing -> ready
ready --artifact/settings/model changed--> stale -> queued
任何阶段 --cancel/error--> partial/failed
```

每批更新 durable checkpoint；lease 过期由 Utility repository 恢复；重启后依据 revision/content hash 跳过已提交批次。旧 revision 保持只读，直到新 revision ready 并完成原子切换。

删除文档时先停止/取消 RAG jobs，再删除或 tombstone 投影、chunks、FTS、向量和 cache。引用可保留最小快照并标记 source unavailable；彻底删除还要清理 excerpt、消息正文、query 和外部索引。跨 SQLite/外部后端删除必须可重试、可审计。

默认本地优先，不上传论文正文、query、选区或 embedding；云 embedding/chat 必须逐 Provider 显式启用并说明发送内容。密钥只进 Credential Vault；日志不记录 query 全文、论文正文、embedding、Authorization、预签名 URL 或完整回答。scope、documentId、hash、mapping 和 PathPolicy 要在每个检索、引用、chat、导入和删除操作上验证。本地模型/ANN 需要供应链、hash、许可、资源和离线策略。

## 9. 分阶段路线与 DoD

| 阶段 | 交付范围 | 退出 DoD |
|---|---|---|
| RAG-0 契约/谱系 | planned schema、migration 扩展、artifact fingerprint、ports、隐私设置 | 空库/升级/回滚/checksum 测试；未实现时无 RAG 表被误用 |
| RAG-1 切块预览 | `ChunkerPort`、稳定 ID、mapping/page provenance、预览 API/UI | 同输入顺序/ID 稳定；长段、表格、公式、代码、跨页和低置信 mapping fixture 通过；不调用模型 |
| RAG-2 全文搜索 | FTS5 探测、词法 index、scope、增量/重建/删除 | tokenizer/打包 smoke；金标关键词/标题/术语 recall 达标；崩溃恢复通过 |
| RAG-3 Embedding/向量 | provider、Vault 配置、batch worker、Float32 exact store、cache | 维度/NaN/profile、429/5xx、取消、lease、restart、删除、重建和 p95/内存测试 |
| RAG-4 混合检索 | lexical+dense、RRF、去重、可选 reranker | scope 隔离；Recall@5/10 优于 FTS-only 或解释退化；分数/provenance 可审计 |
| RAG-5 问答/引用 | ChatProvider、流式事件、历史、CitationResolver、Reader 跳转 | citation hash/mapping/page 可验证；citation precision/recall、unsupported claim rate、拒答达标；取消/重启/删除通过 |
| RAG-6 发布/规模化 | 本地模型/ANN（可选）、规模基准、权限/许可/离线策略 | 体积、ABI、路径、许可、隐私、CI、packaged smoke 与 verified atomic release 有证据 |

RAG 只有同时满足 schema/migration、ports、IPC/preload、状态 ownership、artifact revision 重建、删除/外发设置、工程 coverage、专项评测、Windows packaged smoke 和 verified atomic release，才可由 proposed 改为 implemented。当前 Desktop coverage gate 仍是 lines/statements/functions `80%`、branches `75%`；新 RAG 代码不得通过扩大 exclude 规避门禁。

## 10. 测试、评测与协作纪律

工程测试覆盖 migration、chunk/provenance、FTS、embedding、vector profile、retrieval scope/RRF、reranker 降级、chat 流式顺序/取消、citation 校验、日志脱敏、Renderer 无密钥、PathPolicy 和 Utility 崩溃恢复。评测集必须去敏、版本化，覆盖标题/术语/跨页/表格/公式/多论文/无答案/恶意 prompt；报告 chunk 覆盖、Recall@5/10、MRR/nDCG、citation precision/recall、unsupported claim rate、拒答、延迟、内存和索引大小。指标是未来门槛，不伪造当前结果。

一个工作项一个 owner；同一工作树同一时刻不允许多个 Agent 修改同一文件，并行实现使用独立 branch/worktree。`shared` schema、Preload API、Main IPC、Core RPC、v2 migration、JobRepository、Artifact/PathPolicy 和 release scripts 是高风险边界；修改前先登记 owner、输入/输出、兼容、恢复和测试。开始/结束记录 `git status --short --branch`；不得覆盖他人改动、reset、stash、清理 release 或修改其他 worktree。每项标注 `planned`/`implemented`/`verified`/`blocked` 并附源码、测试和评测证据；未运行 package/E2E 不得写成通过。

## 11. 当前平台与发布限制

在当前 Windows build `26200` + GameViewer 环境，sandboxed Renderer/GPU 原生启动失败；本机没有 GUI E2E 通过证据。不得声称 Desktop GUI E2E 本机通过，也不得建议产品默认或 CI 降低 sandbox。专用 packaged CLI smoke 已通过，且不启动 Renderer；它只能证明打包入口的 CLI marker，不证明 UI、GPU、Renderer 或 RAG。

RAG 若增加 worker、模型或原生 vector backend，必须复用 verified atomic release：在精确 release staging 中构建、审计、解压校验、哈希和 packaged smoke 成功后再原子发布到 `release/`；失败恢复旧目录并保留 staging。模型缓存、查询历史、密钥和临时索引不能进入 release ZIP。

## 12. 已知后续事项

根仓库许可证文件和 `desktop/package.json` 的许可证元数据目前不一致；这只登记为后续法务/发布事项，本计划不修改许可证文本、package 声明或署名信息。RAG 的模型、FTS tokenizer、向量后端、云 Provider 和数据保留策略都需在对应阶段单独完成许可与隐私评审。
