---
document_id: copilotix-desktop-rag-development-plan
document_version: 6
status: proposed
baseline_ref: refactor/p0-p1-architecture
baseline_verified_at: 2026-09-16
scope: RAG future design on the P0/P1 Desktop boundary
implementation_plans: docs/rag-implementation/README.md
---

# Copilotix Desktop 论文知识库与 RAG 开发计划

> 2026-09-23 implementation audit and continuation: [RAG review handoff](RAG_REVIEW_HANDOFF_20260923.md). This document retains its historical baseline; consult the handoff for verified current behavior and remaining work.

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

### 0.1 结论先行

结合当前代码边界、Windows 桌面发布约束和论文阅读场景，建议采用以下主线，而不是一开始堆叠复杂框架：

1. **切块：Markdown AST + layout/block mapping 的结构感知层次切块**。叶子块负责精确召回，父块负责补全上下文；只有超长正文按句子边界继续切分，并限制重叠。首版不使用纯固定字符切块、纯语义切块或 LLM 自动切块。
2. **词法检索：SQLite FTS5 BM25 双通道**。英文/拉丁文本用 `unicode61`（可选 Porter），中文与混合术语用 FTS5 `trigram`；短于 3 个字符的中文词、公式、缩写和标识符另走精确匹配降级。这样既保留论文术语的精确命中，也不引入 `jieba` 一类原生分词依赖。
3. **向量检索：可替换的 OpenAI-compatible Embedding Provider + 1024 维、L2 归一化、余弦/点积**。中国区首个经过评测的推荐配置为 `qwen3.7-text-embedding` 1024 维；成本优先可换 `qwen3.7-text-embedding-flash`，兼容基线可接 `text-embedding-v4` 或 `text-embedding-3-large`。模型名不是数据库常量，必须由 profile 指纹隔离。
4. **向量存储：先用 Utility worker 中的 Float32 精确扫描建立正确性基线**；达到实测规模门槛后，再通过 `VectorStorePort` 切换 `sqlite-vec`。`sqlite-vec` 当前仍是 `0.1.x alpha`，不能直接作为唯一持久化真相。
5. **检索：BM25 top 40 + dense top 40 → RRF(`k=60`) → 邻接/父块扩展 → 可选 cross-encoder rerank top 30 → 最终 8–12 个证据块**。RRF 对不同分数尺度更稳，且每个结果来源可解释。
6. **问答：检索增强生成，而不是把整篇论文无条件塞进长上下文**。回答必须引用应用签发并校验过的 citation；证据不足时明确拒答。选区问答优先使用选区与相邻块，整篇/多论文问题才进入完整混合检索。
7. **先进技术的采用顺序**：先实现确定性的结构上下文前缀；评测证明有收益后再启用 LLM Contextual Retrieval；Late Chunking、RAPTOR、多向量 ColBERT 和图 RAG 均保留为后续实验，不作为 P0 默认路径。

这条路线的核心取舍是：优先获得可追溯、可恢复、可评测的强基线，再让每项更复杂算法通过离线评测证明增益。对个人论文库，可靠引用、精确术语、跨语言查询和低维护成本，比追求单一排行榜上的最高分更重要。

### 0.2 当前功能实现流程（源码核对）

当前 Desktop 的真实链路如下：

```text
用户选择/拖入 PDF
  -> Renderer 调用 window.copilotix.importDocuments
  -> Preload 固定 channel + Zod 双向校验
  -> Main DocumentCommandService 校验 PDF/凭证/200 MB 上限
  -> Utility 流式导入、SHA-256、原子发布 original.pdf
  -> SQLite documents + parse job
  -> Main JobScheduler claim/lease/heartbeat
  -> ParseJobRunner 调 Copilotix v4 API 上传、轮询、下载 ZIP
  -> Utility normalizeParserOutput
       发布 full.md / layout.json / block_list.json / 可选 images、content_list
       记录 artifact revision/hash
  -> 创建依赖 parse job 的 translate job
  -> TranslationJobRunner + TranslationPlanOrchestrator
       Utility 按 Markdown AST/表格生成 plan
       Main 选择 Qwen/DeepSeek/Bing/TranSmart provider
       Utility 校验并原子生成 full.zh-CN.md + manifest/checkpoint
  -> ReaderPage 加载 DocumentDetails
       左侧 PDF.js，右侧原文/译文/JSON
       block mapping 联动定位，annotation revision 做高亮/下划线并发保护
```

对应代码证据：

| 环节 | 当前实现位置 | 可复用点 / RAG 含义 |
|---|---|---|
| 页面与阅读器 | `desktop/src/renderer/pages/ReaderPage.tsx`、`ReaderTextPane.tsx`、`PdfPane.tsx` | 可增加搜索/聊天侧栏与引用跳转；Renderer 不能直接访问文件、数据库或密钥 |
| 公开 API | `desktop/src/shared/ipcSchemas.ts`、`types.ts`、`preload/index.ts` | 新增 `rag:*` 显式领域方法与流事件，不能暴露通用 IPC/SQL/URL |
| 文档命令 | `desktop/src/main/documentCommandService.ts` | 导入、删除、重试已有清晰命令边界；删除需扩展到索引和会话 |
| 作业调度 | `desktop/src/main/jobScheduler.ts`、`desktop/src/core/jobs.ts` | 可复用 lease/checkpoint/retry/cancel；现有 `jobs.kind` 只允许 `parse/translate`，迁移时必须重建 CHECK 约束 |
| 解析 | `desktop/src/main/parseJobRunner.ts`、`parserClient.ts` | parsed artifact 成功发布后即可建立离线 content revision；不等待翻译或 AI 配置 |
| 翻译 | `desktop/src/main/translationJobRunner.ts`、`translation/translationPlanOrchestrator.ts` | “Utility 生成小型 work descriptor → Main 调网络 → Utility 校验落库”的模式可直接复用于 embedding |
| Markdown 逻辑块 | `desktop/src/shared/markdownBlocks.ts` | 已使用 remark/GFM/math AST，并可对齐 mapping；应提取为 Chunker 的结构基础而非再写正则切块 |
| PDF 映射 | `desktop/src/core/blockMapping.ts` | 已合并跨页/续块并保留 bbox、pageIndex、discarded；是 citation provenance 的权威输入之一 |
| Artifact | `desktop/src/main/artifactService.ts`、Utility normalize operations | 可复用 revision/hash/PathPolicy/原子发布；RAG 必须绑定具体 artifact revision |
| SQLite | `desktop/src/utility/core/persistence/v2Database.ts` | `node:sqlite`、WAL、foreign keys、STRICT 与 checksum migration 可继续使用 |
| 凭证与网络 | `desktop/src/main/credentialVault.ts`、`translation/providers.ts`、Settings 中的 provider priority | Embedding/Rerank/Chat 建立独立能力配置，但优先引用已有 Vault 凭证，避免要求用户重复保存同一把 Key；密钥仍只在 Main/Vault |

### 0.3 当前缺口不是“装一个 RAG 库”

| 缺口 | 如果忽略会发生什么 | 本计划的处理 |
|---|---|---|
| chunk 与 artifact 没有版本谱系 | 重新解析后旧向量仍被召回，页码与引用错位 | 不可变 `rag_content_revision` + content hash + 原子 active content revision 切换；vector index 另行发布 |
| 中英文跨语言与精确术语同时存在 | 只用向量会漏公式/缩写，只用 BM25 会漏中文问英文 | 原文/译文双词法通道 + 多语言 dense + RRF |
| 表格、公式、caption 不是普通段落 | 行列语义被切断，回答数字却无法定位 | 类型感知 chunk + 重复表头 + caption/footnote/公式关系边 |
| Reader 选区只是前端 payload | “解释这一段”若仍全库检索会被相似段落干扰 | 独立 selection 路由，选区作为 pinned evidence |
| Core RPC 限制 1 MiB 且不能搬全文/大量向量 | JSON 浮点数组轻易突破上限并阻塞进程 | work descriptor + 受控 request/response artifact，RPC 只传 ID、hash 和小结果 |
| 当前 job kind 只有 parse/translate | 顺手塞入索引状态会破坏 CHECK 和恢复语义 | 显式 migration；拆分离线 `rag-content-index` 与需授权的 `rag-embed`，分别 checkpoint |
| 模型/API 会变化 | 换模型后维度混用、缓存污染或召回漂移 | Provider adapter + immutable profile fingerprint + 灰度重建 |
| LLM 会生成看似真实的页码/引用 | 用户无法核验，形成科研误导 | citation 由应用端生成，模型只能引用允许的 citationId |

### 0.4 从用户实际运行流程重新审查后的修正

2026-09-16 按“首次导入 → 等待处理 → 阅读 → 本地检索 → 可选开启 AI → 提问 → 删除/清理”的真实用户旅程重新核对后，原第 5 版有几处会造成运行时体验错误，必须按本版修正：

1. **解析/翻译状态与知识库状态必须分离。** `DocumentWorkflowStatus` 继续只表示导入、解析和翻译；不能加入 `indexing` 导致已可阅读的文档看起来仍未完成。知识库另有本地索引、语义索引和问答可用性状态。
2. **本地检索不能依赖 AI Key。** parsed artifact 发布后自动建立 chunk 与 FTS；即使用户从未配置 Qwen/DeepSeek，仍能立即搜索原文并跳转来源。
3. **不能等待翻译才开始索引。** 原文索引是主数据；译文完成后只增加或刷新译文词法字段，不应重建原文 chunk、改变 citation 身份或使已有向量失效。
4. **保存 API Key 不等于同意上传论文内容。** 语义索引默认关闭；首次开启时明确说明会发送哪些文本、给哪个服务、用途和删除边界。Chat 与 rerank 也分别显示外发范围。
5. **能力配置不能机械复制翻译设置。** Bing/TranSmart 只能用于翻译；DeepSeek Chat 兼容端点不代表支持 embedding；同一供应商已有 Vault 凭证时可被 capability profile 引用，但每项能力必须独立探测模型与端点。
6. **Reader 不增加永久第三列。** 当前最小窗口宽度与 PDF/文本双栏布局下，搜索/问答使用 400–480 px 可折叠右侧抽屉；多论文检索进入顶层“知识库”页面。
7. **选区必须绑定 artifact 快照。** 现有 `ReaderChatSelection` 只含前端文本/映射信息，不足以防止重新解析后的错引；请求必须携带 artifact/revision 身份，后端重新校验选区与来源。
8. **后台运行要可见、可控。** 主窗口关闭后作业可能继续在托盘运行；本地切块和 embedding 必须低优先级、可暂停/取消/重试，并且不能阻塞阅读、解析或翻译。
9. **删除语义必须完整。** 删除任务时，应用数据库中的 chunk、FTS、向量和 tombstone 必须删除；`deleteFiles` 只决定是否删除原始/解析文件，不能让已删除论文继续被召回。
10. **存储治理必须覆盖两个位置。** 现有输出目录页面还需同时统计 `userData` 内的数据库、FTS、向量缓存和聊天历史，并提供分类清理，而不是只显示 `outputRoot`。

由此，运行时能力不再是单一“RAG 已完成/未完成”，而是三个独立维度：

```text
阅读可用性：由现有 parse/translate workflow 决定
本地检索：   parsed artifact -> chunk/FTS，默认自动、离线可用
AI 增强：    显式同意 + 有效 capability profile -> embedding/rerank/chat
```

### 0.5 当前基线门禁（2026-09-16 实测）

- `pnpm desktop:typecheck`：通过。
- `pnpm desktop:test`：未全绿；当前结果为 1 个失败、59 个通过的 test files，267 个通过、3 个跳过的 tests。失败用例为 `desktop/tests/taskService.test.ts` 中的 `resumes a remote checkpoint without resubmitting and runs one dependent translation`，预期 `succeeded`、实际 `partial`。
- 该失败发生在任何 RAG 代码修改前，必须由子计划 `00_BASELINE_STABILIZATION.md` 先定位并恢复全绿；不得把它忽略、改名为“已知失败”或降低测试/coverage 门禁后继续。

## 1. 设计前提与非目标

### 1.1 必须继承的 P0/P1 事实

| 边界 | 约束 |
|---|---|
| Runtime | Electron `44.1.1`、Node `24.19.0` |
| 进程 | Renderer → Zod 验证的 Preload 领域 API → Main 协调/net/credential → Utility SQLite/compute |
| RPC | versioned request/response/event envelope、UUID requestId、JSON、payload/envelope 各 ≤ `1 MiB`、timeout/cancel/restart |
| 持久化 | `%APPDATA%\Copilotix-Translation-v2\copilotix-desktop-v2.sqlite3`；Utility 独占 SQLite 连接；STRICT migration ledger |
| 文档产物 | `<outputRoot>\documents-v2\{documentId}`；artifact 有 revision、hash、job 归属和受 PathPolicy 保护的相对路径 |
| 作业 | durable parse/translate jobs，lease、heartbeat、checkpoint、retry、过期恢复 |
| 文件 | 流式输入、专属 staging、fsync/atomic rename、成功后登记 artifact；结果 ZIP 排除内部目录 |
| 密钥 | Token/API Key 只在 Main/Credential Vault；Renderer 与 SQLite 不得到明文 |

RAG 不能把数据库连接、重型向量扫描、模型推理或任意网络引入 Renderer/Main 事件循环；必须复用 Utility/compute 和显式 Provider port。

### 1.2 首版非目标

首版不强制加入 Python 本地模型、第二个数据库、Qdrant/LanceDB、`sqlite-vec`、LangChain、图像 embedding、自动 query rewrite、多租户云同步或自动上传全文。任何新增原生模块、模型权重或网络服务都必须先有体积、ABI、许可、隐私、取消、崩溃恢复和发布 smoke 证据。

### 1.3 真实使用场景与检索路由

不能用同一条“向量 top-k → LLM”流水线处理所有论文问题。建议在 Main 的 `QueryPlanner` 中做轻量、确定性的路由；只有歧义的多轮问题才调用小模型改写。

| 场景 | 示例 | 推荐路由 | 原因 |
|---|---|---|---|
| 选区解释/翻译追问 | “这段为什么这样推导？” | 选区 pinned evidence → 同 mapping/前后各 1 个叶子块 → 必要时父块 → Chat | 用户已给出最可靠 scope，无需向量检索稀释上下文 |
| 本论文事实问答 | “训练集有多少样本？” | 当前文档过滤 → lexical+dense → rerank → 证据回答 | 数字和专名需要 BM25，语义表述需要 dense |
| 公式/符号检索 | “式(7)里的 λ 是什么？” | 公式编号/符号精确检索优先 → 公式块及解释邻居 → dense 补充 | Embedding 对短符号、编号和 LaTeX 不稳定 |
| 表格问答 | “表 2 中哪个方法最高？” | caption/表号精确命中 → 表格块/行组 → 相关 footnote → Chat | 必须保留表头、行列和脚注，不能只召回一个单元格 |
| 方法/结论综述 | “作者的主要贡献和局限是什么？” | 标题/摘要/引言/结论 section boost + 多粒度检索 → rerank | 答案常跨多个章节，需要父块与结果多样性 |
| 多论文比较 | “这些论文在数据集和指标上有何差异？” | 所选文档集合 → 每文档配额 → hybrid → 按文档聚合证据 → Chat | 防止某一长论文占满 top-k，并保留对比覆盖率 |
| 中文问英文论文 | “消融实验说明了什么？” | 中文译文 lexical + 原文 multilingual dense，canonical chunk 去重 | 只搜原文 BM25 无法跨语言；只搜译文可能丢专名 |
| 查找原句/术语 | “找到包含 boundary condition 的段落” | phrase/BM25/trigram 优先，可不调用 LLM | 搜索任务不应被生成式回答替代 |
| 多轮追问 | “那它比上一种方法好在哪？” | 使用最近对话与已引用实体生成 standalone query；同时检索原问题与改写问题并融合 | 单独嵌入代词问题缺少语义，但改写也可能偏移，双路更稳 |
| 无答案/超出论文 | “作者 2027 年又发表了什么？” | 检索 → 证据门槛/覆盖检查 → 明确无答案 | 默认知识边界是本地所选论文，禁止用模型记忆伪装论文证据 |
| 文档内搜索 | 输入关键词并浏览所有位置 | 纯 lexical、过滤/高亮/跳页 | 延迟最低、结果可穷举，不需要付费 API |

推荐的首版 UI 明确分成三种动作：

- **搜索**：返回命中片段、章节、页码和匹配来源，不生成答案；
- **询问本文/所选论文**：执行 RAG，并展示答案与引用；
- **询问选中内容**：固定选区证据，默认不搜索其他论文，用户可主动扩展范围。

这种区分比一个万能聊天框更重要：它让用户知道系统搜索了哪里、是否调用云 API，以及回答证据来自哪个 revision。

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

### 2.1 推荐的跨进程 embedding 流程

Embedding 同时需要 Main 中的密钥/网络能力和 Utility 中的正文/SQLite 能力。不可为了省事把 API Key 发给 Utility，也不可把几百个 JSON float 数组经 Core RPC 搬运。建议复用现有 translation plan 模式：

```text
Utility RagContentIndexManager（此前已离线发布 content revision/chunks）
  1. 用户同意且 profile 有效后，EmbeddingWorkPlanner 读取 ready chunks，生成 embedding request 文件
  2. listEmbeddingWork() 只返回 unitId、contentRevisionId、contentHash、profileId、requestPath、responsePath
        ↓ 小型 Core RPC descriptor
Main RagEmbeddingJobRunner
  3. PathPolicy 校验并读取有限批次 request（默认 10–20 条）
  4. Credential Vault 取 key，EmbeddingProvider 发起 API 请求
  5. 校验响应条数/维度/finite 值，写受控 response partial 并原子 rename
        ↓ 小型 Core RPC apply(unitId, responsePath, responseHash)
Utility EmbeddingWorkPlanner / VectorStore
  6. 再次校验 job/contentRevision/vectorIndex/profile/hash，L2 归一化并写 embedding/cache
  7. 批次 checkpoint；全部成功后构建/发布 vector index
```

对于支持 `encoding_format=base64` 的 API，可把每条向量保存成 base64 编码的 little-endian Float32；不支持时由 Main 将有限 JSON float 转成二进制响应文件。无论格式如何，Utility 都必须拒绝：维度不符、NaN/Infinity、全零向量、条目数/顺序不符、hash 不符和旧 job 的迟到响应。

查询时只有一个 query embedding，可以使用有上限的 base64 Float32 Core RPC 传入 Utility；若以后加入多 query expansion，仍限制为小批次。检索结果只返回 8–30 个有大小上限的摘要/证据 DTO，不返回全库正文。

### 2.2 推荐的运行时组件

| 层 | 新组件 | 说明 |
|---|---|---|
| Shared | `ragSchemas.ts`、`ragTypes.ts`、`ragProtocol.ts` | IPC/Core RPC/流事件/错误码的单一来源 |
| Renderer | `SearchPanel`、`ChatPanel`、`CitationCard`、`IndexStatus` | 仅展示 DTO；引用跳转复用 Reader selection/mapping |
| Main | `RagCommandService`、`RagContentIndexJobRunner`、`RagEmbeddingJobRunner`、`RetrievalOrchestrator`、`ChatOrchestrator` | scope、授权、作业、网络 Provider、流式生命周期 |
| Main Provider | `EmbeddingProvider`、`RerankerProvider`、`ChatProvider` | OpenAI-compatible 为首个适配层，特性探测而非猜测 endpoint |
| Utility | `RagContentIndexManager`、`EmbeddingWorkPlanner`、`StructureAwareChunker`、`FtsIndex`、`ExactVectorStore` | 大文本、SQLite、tokenization、向量扫描留在受控计算侧 |
| Persistence | `RagRepository` + migration 4+ | content revision/vector index/chunk/profile/cache/conversation/citation；不扩散 SQL 到 Main |
| Worker | `VectorSearchWorker`（Node worker thread 或独立 Utility child） | 精确扫描/ANN 查询不得阻塞 Utility RPC loop |

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
| `rag_documents` | `document_id`, `active_content_revision_id`, `local_state`, `local_error`, `updated_at` | 一个 v2 document 的知识库投影；不修改现有 parse/translate workflow 状态 |
| `rag_content_revisions` | `content_revision_id`, `document_id`, `artifact_id`, `artifact_hash`, `mapping_hash`, `chunker_fingerprint`, `lexical_generation`, `state` | 原文 chunk/provenance/词法索引的不可变代次；与 embedding profile 解耦 |
| `rag_chunks` | `chunk_id`, `content_revision_id`, `ordinal`, `content_hash`, `source_text`, `section_path`, `mapping_ids`, `page_start/end`, `offsets`, `token_count`, `content_type` | canonical 原文检索单元及完整 provenance；发布后不被译文刷新改写 |
| `rag_chunk_variants` | `content_revision_id`, `chunk_id`, `variant_kind`, `language`, `artifact_id/hash`, `generation`, `text` | 译文等可替换词法变体；独立于 canonical chunk/citation 身份 |
| `rag_vector_indexes` | `vector_index_id`, `content_revision_id`, `profile_id`, `state`, `checkpoint`, `error`, `created_at` | 每个内容代次可有多个语义索引；失败不影响本地检索 |
| `rag_embeddings` | `vector_index_id`, `chunk_id`, `dimensions`, `metric`, `normalized`, `vector_blob` | 与 vector index/profile 绑定的 Float32 或 adapter 数据 |
| `rag_embedding_cache` | `profile_fingerprint`, `content_hash`, `dimensions`, `vector_blob`, `created_at` | 可容量治理的跨 revision 缓存；不能绕过来源校验 |
| `rag_fts` | `content_revision_id`, `chunk_id`, `source`, `translated`, `title`, `section` | FTS5 external-content 或等价 lexical index；不保存密钥，可从 chunk 重建 |
| `rag_queries` | `query_id`, `scope`, `query_hash`, `created_at`, `privacy_mode` | 只保存最小可选诊断，不默认保存全文 query |
| `rag_conversations`/`rag_messages` | `conversation_id`, `message_id`, `role`, `content_ref`, `created_at` | 用户显式开启历史后才保存；敏感内容治理 |
| `rag_citations` | `message_id`, `ordinal`, `artifact_id`, `content_revision_id`, `chunk_id`, `content_hash`, `excerpt`, `mapping_ids`, `page_start/end`, `scores` | 回答时的不可变引用快照；支持源不可用标记 |

所有外键、document scope、content revision/vector index scope 和删除级联必须在数据库约束中表达。FTS、向量后端或外部索引如果不能同事务更新，必须有状态、重试、tombstone 和重建任务，不得宣称已删除而仍可召回。

### 4.1 数据建模修正与主键建议

实现时建议增加 `rag_profiles`，并把 profile 从自由 JSON 提升为受约束实体：

```ts
type RagProfile = {
  profileId: string
  fingerprint: string       // canonical JSON 后的 SHA-256
  embeddingProvider: string
  embeddingModel: string
  dimensions: number
  metric: 'cosine' | 'dot'
  normalized: boolean
  queryInstruction: string | null
  documentInstruction: string | null
  chunkerVersion: number
  lexicalVersion: number
  createdAt: string
}
```

关键约束：

- `rag_chunks` 主键建议为 `(content_revision_id, chunk_id)`，并对 `(content_revision_id, ordinal)` 唯一；不能假定同内容在不同论文中是同一个引用位置。
- `content_hash` 只表示 canonical chunk 内容，可用于 embedding cache；它不是 citation 身份。
- `rag_embeddings` 主键为 `(vector_index_id, chunk_id)`，并用 CHECK 固定 `dimensions > 0`、`length(vector_blob) = dimensions * 4`；profile 由 `rag_vector_indexes` 约束。
- 内容代次和向量代次分别发布。先建立 `building` content revision，chunk 与原文 FTS 完整后，在单个 SQLite 事务里切换 `rag_documents.active_content_revision_id`，此时本地搜索已可用；vector index 完整后再单独切为 `ready`，不能阻塞或回滚本地能力。
- 译文完成只增加 `lexical_generation` 并事务性替换当前 content revision 对应的 `rag_chunk_variants`/译文 FTS。只要原文 artifact 与 mapping 未变，不创建新 content revision，不改写 `rag_chunks`，也不重算向量。
- FTS 虚拟表不能提供与普通表完全相同的外键语义，`rag_chunks` 是事实表；FTS 是可删除、可重建的派生索引。
- embedding cache 必须有 LRU/总字节上限，并且 cache key 包含完整 profile fingerprint；不同维度、instruction 或归一化策略绝不共享。
- 对话正文默认不落库；开启历史时优先存本地加密或明确提示“本机其他同账户进程可能读取应用数据”。Credential Manager 只适合密钥，不适合大量聊天正文。

### 4.2 作业表选择

不建议长期维护一套与现有 scheduler 重复的 `rag_jobs` lease 实现。推荐迁移现有 `jobs` 表，将 `kind` 扩为：

```text
parse | translate | rag-content-index | rag-embed | rag-delete
```

`rag-content-index` 表达 `chunking → source lexical → publishing`，parsed artifact 发布后自动排队；它不需要网络或 AI Key。`rag-embed` 表达 `planning → batching → embedding → vector publishing`，只有用户显式启用语义索引且 profile/凭证有效时才排队。翻译成功触发当前内容代次的译文词法刷新，可作为 `rag-content-index` 的幂等子阶段或小型 Utility operation，但不得触发完整向量重建。这样可复用现有 claim、lease、heartbeat、retry、cancel、事件和 UI 状态，同时保证云端失败不会拖垮本地搜索。SQLite 不能直接修改现有 CHECK，需要在 migration 中：新建 `jobs_new` → 复制并校验数据 → 重建索引/外键 → 原子替换；必须用现有数据库 fixture 验证升级和回滚。

这三类 RAG job 使用独立的低优先级资源 lane 和并发限制，不能投影为 `DocumentWorkflowStatus`。Task/Reader UI 通过单独的 `KnowledgeStatus` 查询显示本地索引与语义索引进度；主窗口关闭后若继续在托盘运行，必须保留暂停、取消、失败和重试的可见入口。

如果团队希望先隔离风险，也可在子计划 02 暂建 `rag_jobs`，但它必须复用抽取后的通用 repository/state-machine，不能复制两份状态转换代码；最终仍应合并到统一 durable job 模型。

## 5. Artifact 指纹、稳定身份与切块规范

### 5.1 指纹与谱系

规范输入是已登记的 parsed Markdown artifact；翻译 Markdown 是辅助字段，不替代原文。建议：

```text
content_revision_hash = sha256(canonical artifact bytes + mapping/layout revision)
chunker_fingerprint = version + rules + parser settings snapshot
embedding_fingerprint = provider + model + dimensions + normalization + metric
embedding_cache_key = embedding_fingerprint + content_hash
chunk_id = sha256(document scope + content revision input + ordinal/content identity)
```

解析配置、artifact hash、mapping hash 或 chunker fingerprint 改变时创建新 content revision；embedding profile 改变时只创建新的 vector index，不能让本地搜索暂时不可用，也不能静默重写旧 chunk/向量。译文更新只刷新译文词法变体。现有 `BlockMapping.id` 含 document 语义，适合当前 Reader 定位，不直接当作跨导入/跨 revision 的 canonical chunk ID。

### 5.2 Chunk 最低契约

每个 chunk 至少携带：

```ts
type PlannedChunk = {
  chunkId: string
  contentRevisionId: string
  ordinal: number
  contentHash: string
  sourceText: string
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

译文不放入 canonical `PlannedChunk`。它通过独立 `ChunkTextVariant` 绑定 `contentRevisionId + chunkId + translationArtifactId/hash + generation`；这样重新翻译不会改变 chunk/citation 身份，也不会把可变译文伪装成不可变来源。

规则：

1. 按 Markdown AST/逻辑 block 切分，保持原顺序；标题继承到正文上下文，不制造无上下文孤立 chunk。
2. 长段按语义边界和重叠上限切分；表格保留表头、caption/footnote 与 cell provenance，不截断成无效 JSON/Markdown。
3. 公式、代码、引用、图片 caption 采用显式 content type；首版不做图片视觉 embedding。
4. source 是规范语料；translated 仅用于辅助 lexical 或按显式 variant 生成 embedding。原文/译文候选必须按 canonical chunk 去重。
5. 记录 mappingIds、page range、section path、内容 hash 和 mapping confidence；无可靠映射时只能降级为文档/页/章节引用，不能声称句子级 bbox。
6. Offset 使用 JavaScript UTF-16；未来跨语言处理必须显式声明转换，不得把字节 offset 当字符 offset。

### 5.3 选定算法：结构感知的层次切块

#### 第一步：构建规范文档树

使用项目已经依赖的 `remark-parse + remark-gfm + remark-math` 解析 `full.md`，构建：

```text
Document
  ├─ metadata(title/authors，可得则填)
  ├─ Section(h1)
  │    ├─ Section(h2/h3...)
  │    ├─ paragraph/list/code/math/table/figure-caption
  │    └─ ...
  └─ references/appendix（显式标签）
```

同时用现有 `alignMarkdownBlocks()` 与 `block_list.json` 附加 `mappingIds/page/bbox`。注意当前对齐算法会过滤全 discarded mapping，并以 canonical text 顺序匹配；因此 chunker 必须记录 `mappingConfidence = exact | range | media | fallback | none`，不能仅凭 `mappingIds.length > 0` 假定精确。

#### 第二步：生成父块与叶子块

推荐初始参数（必须进入 `chunker_fingerprint`，后续由评测调整）：

| 参数 | 建议默认值 | 说明 |
|---|---:|---|
| 叶子目标长度 | `420 tokens` | 适合细粒度证据检索，不把多个实验结论过度压缩进一个向量 |
| 叶子软下限 | `180 tokens` | 相邻短段优先合并，标题/caption/公式等独立类型除外 |
| 叶子硬上限 | `700 tokens` | 超过则必须按句子/安全边界拆分 |
| 长正文重叠 | `64 tokens`，且不超过前块 `15%` | 只用于一个逻辑段内部被迫切分；普通 AST 块之间不复制 |
| 父块目标长度 | `1,400 tokens` | 作为上下文扩展，不直接挤占初始 top-k |
| 父块硬上限 | `2,000 tokens` | 超过按子章节/逻辑块分组 |
| heading context | 最多 `128 tokens` | 标题路径 + 论文标题的确定性前缀 |
| 最终上下文 | 通常 `8–12` 个叶子证据，去重后 `6k–12k tokens` | 由 ChatProvider 上下文上限动态裁剪 |

canonical chunk 边界使用**版本化、确定性的本地 token 估算器**并留 15% 安全余量，不能把 JavaScript `string.length` 当 token 数，也不能让更换 embedding/chat provider 悄悄改变 chunk identity。Provider adapter 在发请求前再用能力上限/可用 tokenizer 做 preflight；单个 canonical chunk 超过模型上限时应拒绝该 profile 或生成仅用于 embedding 的可追溯 sub-unit，不能静默改写 canonical citation chunk。

父块不一定额外生成向量。首版让叶子块进入 BM25/dense，叶子命中后按 `parentChunkId` 拉取父上下文或相邻兄弟，可减少索引体积和重复候选。只有评测显示“综述型问题”召回不足，才给父块单独建立 dense variant。

#### 第三步：类型特化

| 类型 | 切块规则 | 检索/回答注意 |
|---|---|---|
| heading | 不作为孤立叶子；写入后续块的 `sectionPath` 和 embedding/lexical context | heading 本身仍可做导航命中 |
| paragraph | 先按 AST 段落合并短块；超长时用 `Intl.Segmenter` 句边界，保护缩写、引用和 inline math | 仅被迫拆分时重叠 |
| list | 尽量保留完整列表；超长则每组重复列表标题/引导句 | 不在一个 item 内随意截断 |
| table | 小表整体；大表按行分组，每组重复 caption、列头、单位，携带 row range 和 footnote | 生成答案前验证列头与数值在同一上下文 |
| formula/math | display formula 与编号整体保存，并链接前后解释块；inline math 随段落 | 公式编号、变量、LaTeX 进入精确词法字段 |
| figure/chart | caption + 文中引用句形成文本 chunk；图片本体首版不 embedding | 不根据图片内容回答，除非后续明确启用多模态索引 |
| code | fence 整体；超长按函数/空行等语法安全边界 | 保留语言标识，不做普通句切分 |
| references | 独立 section，默认检索降权但可显式搜索 | 防止参考文献标题干扰正文答案 |
| header/footer/discarded | 默认不索引 | 用户打开“包含页眉/附录”时才加入 scope |

#### 第四步：确定性上下文前缀

Embedding 和 BM25 的“检索文本”可使用下面的版本化前缀，但 citation 展示必须使用原始正文：

```text
[论文] {paperTitle}
[章节] {h1 > h2 > h3}
[类型] {paragraph|table|formula|caption...}
[位置] 第 {pageStart+1}-{pageEnd+1} 页
[正文] {sourceText}
```

这能以零 LLM 成本解决 “it / the proposed method / this result” 失去上下文的问题，并且完全可重复。可在后续实验增加 50–100 token 的 LLM contextual summary，但必须保存生成模型/prompt/version、只用于检索、不作为事实证据，并与确定性前缀做 A/B 测试。

### 5.4 为什么不选其他切块方案作为默认

| 方案 | 优点 | 对本项目的主要问题 | 决策 |
|---|---|---|---|
| 固定字符/固定 token + overlap | 最容易实现 | 切断表格、公式、标题层级和 PDF mapping；重复率高 | 只作为测试基线，不上线 |
| 纯递归分隔符 | 比固定长度稍好 | 不理解 Markdown AST、表格和 math，分隔符随语言变化 | 不选；AST 已存在且更可靠 |
| embedding semantic chunking | 可在主题变化处切分 | 建索引前就需模型；结果受模型/阈值影响，ID 不稳定，重建成本高 | 只用于超长无结构正文的实验 |
| LLM 自动切块 | 语义强，可生成上下文 | 昂贵、慢、非确定、可能改写/漏文；隐私外发扩大 | 不作为 canonical chunker |
| Late Chunking | 长上下文模型先编码整段、后池化，可保留跨块语境 | 需要模型暴露 token-level hidden states；大多数远程 embedding API 只返回整条向量，与当前 Provider 架构不兼容 | 保留本地模型实验，不阻塞子计划 03 |
| RAPTOR | 对跨章节、多跳和摘要型问题有潜力 | 需聚类与递归 LLM 摘要；成本、更新、引用谱系与幻觉面显著增大 | 子计划 13 以后、仅在综述问题评测证明必要时引入 |
| 每页一个 chunk | 页码天然明确 | 双栏/跨页段落和长页会混入多个主题；当前 mapping 已能给更细 provenance | 不选 |

结构感知层次切块相对这些方案的优势不是“最复杂”，而是它直接复用项目已有 AST、表格协议和 PDF mapping，结果确定、可增量、可引用，也最容易对错误定位和写 fixture。

## 6. 索引、Embedding 与向量后端

### 6.1 Lexical/FTS

实现前先探测打包 Electron runtime 的 FTS5 能力和 tokenizer。若中文分词不可用，必须用可重复的 tokenizer fixture、译文字段或替代 lexical adapter，并在设置页说明召回限制。FTS index 必须绑定 revision/chunkId、支持增量/重建/删除和崩溃恢复；它不是当前 v2 `settings` 或 `translation_cache` 的替代。

推荐建立两个派生 FTS 索引并在应用层融合：

1. `rag_fts_words`：`tokenize='unicode61 remove_diacritics 2'`；英文可实验 `porter unicode61`。列建议为 `title, section, source, translated, identifiers`，BM25 初始权重可设 `title=4, section=3, identifiers=2.5, source=1, translated=0.8`。
2. `rag_fts_trigram`：`tokenize='trigram case_sensitive 0'`；覆盖中文、无空格语言、混合术语和子串。它支持通用子串匹配，但短于 3 个 Unicode 字符的 MATCH 不会命中，因此必须有受 scope 限制的 exact/LIKE 或预生成 CJK bigram 降级。

查询字符串绝不能直接拼 FTS 语法。先做长度/NUL/控制字符限制，将普通用户输入作为转义 phrase/AND terms；“精确短语、任意词、排除词”等高级能力由结构化 DTO 表达并生成参数化 SQL。公式标识符额外规范化全角/半角、Unicode 希腊字母与常见 LaTeX 表示，但保留原字符串用于 exact match。

为什么仍选择 BM25：论文检索中模型名、数据集、化学式、基因名、公式编号和数值常要求精确匹配；dense 相似并不等于包含该术语。SQLite FTS5 已提供 BM25、snippet/highlight、external/contentless 索引，无需引入第二个搜索服务。代价是中文分词一般，因此采用 word + trigram 双索引，而不是假装默认 `unicode61` 已正确分词中文。

### 6.2 Embedding provider

Embedding 是独立 Provider，不得假设翻译 endpoint 支持 `/embeddings`。配置至少包括 provider、base URL、model、dimensions、metric、归一化、batch/timeout；API Key 继续由 Main Credential Vault 管理，Renderer 仅见 `hasKey`。

每批都要验证向量长度、数值有限、非全空、profile fingerprint 和 document/revision 归属。429/5xx/网络错误要可重试并写 checkpoint；用户取消、超时、Utility 崩溃和模型维度变化要可恢复且不污染旧 revision。

### 6.3 Embedding 模型与维度决策

截至本计划核对日期，建议把“默认模型”理解为可更新的**经过本项目评测的 profile**，而不是硬编码厂商名：

| Profile | 推荐用途 | 优点 | 注意事项 |
|---|---|---|---|
| `qwen3.7-text-embedding`, 1024d | 中国区、质量优先的首选候选 | 官方支持 201 种语言/方言、长输入、可选维度；适合中文问英文论文 | 新模型必须先跑本项目金标；模型区域、价格和 endpoint 均需配置 |
| `qwen3.7-text-embedding-flash`, 1024d | 成本/吞吐优先 | 同系列跨语言能力，调用成本更低 | 是否达到质量门槛由 Recall/nDCG 决定，不能仅因“flash”默认替换 |
| `text-embedding-v4`, 1024d | 稳定兼容候选 | Qwen3 Embedding 系列、100+ 语言、OpenAI-compatible API、维度可调 | 单批条目和 8k 输入限制与新模型不同，adapter 必须读取 capability |
| `text-embedding-3-large` | 国际 Provider 兼容基线 | API 成熟、支持 dimensions 参数，适合验证通用 adapter | 供应区域、数据政策、成本需单独确认；不可复用其他模型索引 |
| 本地 `Qwen3-Embedding-0.6B` / `BGE-M3` | 离线隐私模式的后续候选 | 开放权重、多语言；BGE-M3 还能实验 sparse/multi-vector | Python/ONNX/runtime、模型体积、CPU 延迟、许可、打包与更新复杂，不放进首版 EXE |

首版统一使用 `1024` 维、L2 归一化后的 Float32，检索使用 dot product（与 normalized cosine 排序等价）。1024 维在精度、磁盘和扫描成本之间较平衡：每向量约 4 KiB，10 万 chunk 仅原始向量约 390 MiB；2048 维翻倍，而是否产生可测质量提升尚未知。只有离线评测显示明显增益，才为高精度 profile 使用 1536/2048 维。

模型特定的 query/document instruction 必须由 adapter 维护。例如 instruction-aware 模型对 query 前缀敏感，而 passage 通常不应套同一个 query instruction。instruction 文本是 profile fingerprint 的一部分；修改它等同换模型，需要重建索引。

#### 原文还是译文做 embedding

首版建议只对 `deterministic context + sourceText` 建一条 dense vector，译文进入 lexical 字段，不额外生成同等 dense 候选。原因是：推荐模型本身跨语言；双份向量会使同一证据重复占 top-k、增加一倍成本与存储，而且机器翻译可能扭曲术语。

如果金标评测显示中文查询召回不足，可为译文建立 `variant='translated'` 的第二向量，但检索后必须按 canonical chunkId 去重并合并 provenance。严禁把译文 chunk 当成另一个引用来源。

### 6.4 首选后端与扩展边界

首版可以在 Utility worker 中对 SQLite Float32 BLOB 做精确余弦扫描，先基准再决定 ANN。不得仅凭直觉加入原生 ANN 扩展；`sqlite-vec` 或其他后端只能通过 `VectorStorePort`，并提供 Windows 依赖、ASAR unpack、ABI、体积、fuse、删除一致性和 packaged smoke 证据。

最低基准集建议覆盖 10k/50k/100k chunks：query p50/p95、构建时间、峰值内存、索引大小、批量恢复时间和发布包增量。只有在目标硬件的实际门槛不满足时才引入 ANN。

建议把升级门槛写死在 ADR，而不是凭感觉切换：

| 规模 | 默认后端 | 升级条件（目标 Windows x64 中端机器） |
|---:|---|---|
| `< 20k chunks` | worker 内 exact Float32 scan | 以正确性、简单删除和零 ANN 召回损失为先 |
| `20k–100k` | exact scan + 分块/内存映射优化；同时评测 sqlite-vec | 若 dense p95 > 150 ms 或峰值内存 > 512 MiB，进入 ANN 候选验证 |
| `> 100k` | 通过评测的 sqlite-vec/ANN adapter | 必须达到 Recall@10 ≥ exact 的 0.97，且过滤、删除、重建、打包 smoke 全通过 |

这些是首轮工程目标，不是未经测试的性能承诺。精确扫描必须放在 worker，按 `document/revision/profile` 先过滤 rowid，再计算相似度；不得在 Utility 主 RPC loop 用 JavaScript 对全库同步循环。

#### 后端比较

| 后端 | 优点 | 缺点 | 决策 |
|---|---|---|---|
| SQLite BLOB + exact | 无新依赖、结果精确、删除/事务最简单 | O(Nd)，大库延迟与内存增加 | 首版正确性基线 |
| `sqlite-vec` | 与 SQLite 同进程、包体小、API 简洁 | 当前发布仍为 `0.1.x alpha`；原生扩展加载、过滤能力、ABI/ASAR 需验证 | 达门槛后的首选 ANN/加速候选，不是唯一真相 |
| HNSW 原生 Node 库 | 查询快、成熟算法 | 构建/删除/持久化复杂，Node ABI 和 Windows 打包风险高 | 暂不选 |
| Qdrant | 过滤、HNSW、运维能力强 | 桌面端要携带服务/端口/升级/数据目录，明显过重 | 仅未来团队共享/服务端模式 |
| LanceDB | 本地列式与向量能力丰富 | Arrow 依赖和包体更大，引入第二套存储与事务边界 | 暂不选 |
| 云向量库 | 扩展与运维交给云 | 上传论文/向量、持续费用、删除一致性和离线不可用 | 默认禁用，仅显式企业模式 |

### 6.5 缓存、批处理与失败恢复

- Embedding 请求默认 10–20 条/批，但最终值由 Provider capability 决定；同时限制总 token、响应字节和并发（初始并发 `2`）。
- 429 优先尊重 `Retry-After`，否则 full-jitter exponential backoff；408/5xx/网络错误重试，400/401/403/维度错误不盲目重试。
- cache 命中只省 API 调用，仍需验证向量尺寸、profile、contentHash 并写入目标 revision。
- 每提交一批，checkpoint 记录最后稳定 ordinal、成功/失败数量和 response hash；重启时只恢复未提交批次。
- 任何 chunk embedding 失败使 building vector index 为 `partial/failed`，旧 ready vector index 与 active content revision/FTS 均保持可搜索；不允许“90% 向量已生成”就悄悄发布。

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

#### 推荐的可执行默认参数

```text
lexical word topK       = 30
lexical trigram topK    = 30
dense topK              = 40
每路单文档最大候选       = 12（多论文 scope 时）
RRF k                    = 60
RRF 后 canonical candidates = 40
rerank input             = top 30
rerank output            = 12
最终 context             = 8–12（按 token budget、去重与覆盖裁剪）
邻接扩展                  = 命中块前后各最多 1 个；仅同 section/revision
```

RRF 分数：

```text
score(d) = Σ_r weight_r / (60 + rank_r(d))
```

初始令 word/trigram 合并为 lexical 权重 `1.0`、dense 权重 `1.0`。不要直接加 BM25、cosine 与 rerank 原始分数，因为它们的范围和分布不同，换模型后尤其不稳定。权重、k 和 topK 进入 retrieval profile，必须通过评测集调整。

#### 查询预处理

1. NFKC 规范化、去控制字符、保留大小写原文副本；最长建议 2,000 字符。
2. 抽取带信息量的精确 token：引号短语、式/表/图编号、年份、数值、单位、模型/数据集名、英文缩写、LaTeX/Unicode 符号。
3. scope 必须先由 UI 的 documentId/revision/tag 决定，模型不得扩展 scope。
4. 单轮明确问题直接检索；短代词追问才做 standalone rewrite。
5. rewrite 时同时保留原 query，两个 dense/lexical 排名用 RRF 合并，防止改写丢失术语。
6. 搜索模式不调用 rewrite/reranker/chat，除非用户显式开启“语义搜索”。

#### 多样性与上下文扩展

Rerank 后不要简单取前 12 个：

- canonical chunkId 去重，source/translated variant 合并；
- 同一父块最多先取 2 个叶子块，除非用户问题明确指向该章节；
- 多论文比较时先保证每个高相关文档至少 1–2 个证据，再按相关性补满；
- 如果连续叶子块都命中，合并展示/上下文但保留各自 citation span；
- 可用 MMR 做最终多样性裁剪，但只在评测证明减少重复且不损害证据完整性后启用；首版用确定性配额更易解释。

### 7.2 选定的重排策略

Cross-encoder/generative reranker 同时观察 query 与 candidate，通常比单独 cosine 更能判断“这段是否直接回答问题”，但它增加一次网络调用。因此：

| 模式 | 行为 | 适用 |
|---|---|---|
| `off` | RRF 后直接扩展/裁剪 | 离线、低延迟、纯搜索 |
| `fast` | top 20–30 输入低成本多语言 reranker | 默认交互问答候选 |
| `quality` | top 30–40 输入高质量 reranker | 多论文比较、复杂问题 |

中国区首个推荐候选为 `qwen3.7-text-rerank`；兼容/成本档可评测 `qwen3-rerank`，国际 Provider 可适配 Cohere `rerank-v4.0-fast/pro`。旧 `gte-rerank` 已不应作为新默认。具体模型仍是 profile，不写死在检索逻辑。

传给 reranker 的文本为“论文标题 + sectionPath + type + 原始 chunk”，不传整个父块。结果必须关联输入 candidateId，拒绝缺失、重复、越界或数量不符的响应；超时/429 可降级回 RRF，并在 UI/trace 标记 `rerankDegraded=true`，不能让整次问答无期限等待。

#### 为什么是 BM25 + dense + RRF + rerank

| 单独方案 | 会擅长什么 | 会漏什么 |
|---|---|---|
| 只用 BM25 | 精确术语、编号、数字、原句 | 同义改写、中文问英文、概念性问题 |
| 只用 dense | 语义和跨语言 | 短符号、罕见实体、精确数值，且相似不等于可回答 |
| 只用 reranker 扫全库 | 排序质量可能高 | 计算/费用不可接受；reranker 不是召回器 |
| 直接拼接分数 | 实现简单 | 分数尺度依赖模型/语料，难迁移和解释 |
| RRF 无 reranker | 稳健、便宜、可解释 | 对细微否定、可回答性和表格语义判断有限 |

组合方案让每一级解决不同问题：双路保证召回，RRF 稳定融合，reranker 提升前排精度，父块/邻居恢复上下文。任何一级失败都有清晰降级路径。

### 7.3 回答协议

回答只能引用应用生成并验证过的 `citationId`/`chunkId`；模型生成的路径、URL、页码、mapping 或 chunk ID 一律当作不可信文本。若候选不足、引用 hash 不匹配、Provider 不可用或用户未授权外发，返回明确无答案/需配置状态，不编造结论。

流式协议未来应传小型事件（started/delta/citation/complete/error/cancelled），大正文保存在受控 artifact/消息引用中；每个事件要有 conversation/request ID、顺序和上限。取消应同时停止 ChatProvider、检索/重排任务和 UI 订阅，不留下假完成消息。

#### 生成提示与输出结构

不要让 Provider 直接自由生成 Markdown 然后用正则猜引用。内部回答协议建议为：

```ts
type GroundedAnswer = {
  answer: string
  claims: Array<{
    text: string
    citationIds: string[]
  }>
  insufficientEvidence: boolean
  missingInformation?: string[]
}
```

Provider 支持 JSON Schema/structured output 时使用结构化输出；不支持时用严格 JSON envelope 并在 Main 验证。UI 可再把 claims 渲染成带角标的自然段。系统提示必须清楚区分：system policy、user question、trusted metadata、untrusted paper excerpts；论文中的“忽略之前指令”等文字只是数据。

回答规则：

1. 只根据 `<evidence citation_id="...">` 中的内容作答；模型不能创建 citationId。
2. 每个外部可核验事实/数字/结论至少挂一个 citation；同一 citation 可支持多个相邻 claim。
3. 矛盾证据要并列说明，不得擅自选择；多论文对比要标明论文归属。
4. 公式/表格回答必须包含对应 formula/table chunk；只有正文二手描述时要明确说明。
5. 证据不足、检索为空、hash 失配、scope 被删除或 Provider 不可用时返回明确状态，不用模型常识补齐。
6. 模型完成后运行 citation validator：ID 存在、属于本 request/scope/revision、hash 一致、claim 至少有证据；失败可重试一次结构化修复，否则降级展示“回答未通过引用校验”。
7. RAG 仅是读操作；首版 ChatProvider 不拥有打开任意 URL、执行命令、改文件或删除文档的工具权限。

#### 证据阈值不要拍脑袋

不同 embedding/reranker 的分数不可共用固定阈值。首版用以下组合判定是否回答：候选是否存在、是否有 lexical exact/高排名 dense、reranker top score 与 top gap、问题实体覆盖率、citation validator 结果。阈值从金标的 precision-recall 曲线选择，优先控制 unsupported claim，而不是追求每个问题都回答。

### 7.4 Citation 契约

```ts
type Citation = {
  citationId: string
  contentRevisionId: string
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

打开引用时优先复用可靠 `mappingId` 跳 Reader；只有页码时跳页；都没有时打开文档并显示章节/excerpt。引用快照记录 artifact/content revision/content hash，即使用户之后删除文档也必须显示 source unavailable，而不能映射到同 ID 的新内容。

### 7.5 多轮会话策略

- 默认发送给模型的历史只保留最近 6 轮或一个滚动摘要，且摘要不能作为论文证据。
- standalone query rewrite 输入最近问题、最近回答中的已验证实体/citation 元数据，不输入整个历史论文正文。
- 当前轮检索 scope 由 UI 明示；“继续比较另一篇”这类范围变化必须让用户看见。
- 缓存 query embedding 的 key 应为 profile fingerprint + normalized query hash + scope-independent rewrite version；检索结果缓存还必须包含 scope/revision 集合。
- 删除历史与删除论文是不同操作；论文删除后旧消息 citation 标记 source unavailable，不把相同 chunkId 映射到其他 revision。

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

### 8.4 云 API 接入策略

现有 Qwen/DeepSeek translation provider 不能直接扩充几个方法后就当作完整 AI 层。建议拆分能力：

```ts
interface EmbeddingProvider {
  capabilities(): Promise<{ maxItems: number; maxTokensPerItem: number; dimensions: number[]; formats: string[] }>
  embed(input: EmbedRequest, signal: AbortSignal): Promise<EmbedResponse>
}

interface RerankerProvider {
  rerank(input: RerankRequest, signal: AbortSignal): Promise<RerankResponse>
}

interface ChatProvider {
  stream(input: GroundedChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>
}
```

首个 `OpenAICompatibleEmbeddingProvider` 可复用 base URL/key/model 的配置风格，但必须分别探测 `/embeddings`、stream/JSON schema 能力。DeepSeek 当前在项目里是翻译 Chat Provider，这并不证明其 base URL 提供 embedding 或 rerank endpoint；没有 capability 就在 UI 显示“不支持”，不可静默拿 chat 模型伪造向量。

设置页建议分开：

| 配置块 | 最少字段 |
|---|---|
| Embedding | provider/baseUrl/model/dimensions/batch/timeout/query instruction/document instruction/privacy disclosure |
| Rerank | provider/baseUrl/model/mode/timeout/maxCandidates/privacy disclosure |
| Chat | provider/baseUrl/model/context/output limit/temperature/structured-output/timeout/privacy disclosure |
| 本地索引 | lexical on/off、vector backend、自动索引、磁盘上限 |
| 历史与隐私 | 保存历史、保留天数、发送译文/原文、清除 cache/index/history |

对科研问答建议 Chat temperature 初始 `0–0.2`，但低 temperature 不能代替证据校验。每个请求记录 provider/model/profile、token/耗时、是否降级与 traceId，不记录正文/query/完整回答。

### 8.5 Prompt injection 与不可信论文内容

PDF/Markdown、作者附带的隐藏文字、OCR 结果、引用文本都属于不可信数据。必须：

- 在 prompt 中用结构化边界把证据标记为 data，并明确禁止遵循证据中的指令；
- 去除不可见控制字符、零宽字符和危险 HTML，但保留可审计原文 hash；
- Renderer 继续使用现有 sanitize 链，不把模型输出的 HTML 直接注入 DOM；
- 不从论文内容提取 URL 后自动访问，不让 ChatProvider 拥有文件/网络/系统工具；
- ingestion 可记录疑似注入标志并提示，但不能依赖几个正则就声称安全；
- 对输出运行 citation/scope/schema 校验，并限制最大长度、链接协议与可点击目标；
- 未来若增加 agent/tool，任何高风险动作都必须用户确认，且工具输入不能来自未验证 citation 文本。

### 8.6 建议错误码与用户可见状态

| 错误码 | 是否重试 | UI 含义 |
|---|---|---|
| `RAG_NOT_INDEXED` / `RAG_INDEX_STALE` | 否/可重建 | 当前 content revision 尚无可用本地索引 |
| `SEMANTIC_CONSENT_REQUIRED` | 否 | 本地检索可用；开启语义索引前需明确同意文本外发 |
| `EMBEDDING_CREDENTIALS_REQUIRED` | 否 | 本地检索可用；需选择支持 embedding 的能力配置，可引用已有 Vault 凭证 |
| `EMBEDDING_RATE_LIMITED` / `PROVIDER_UNAVAILABLE` | 是 | 按 checkpoint 后退重试，旧索引仍可用 |
| `EMBEDDING_PROFILE_MISMATCH` | 否 | 模型/维度/instruction 与索引不一致，需重建 |
| `RERANK_DEGRADED` | 自动降级 | 使用 RRF 结果继续，明确标记 |
| `INSUFFICIENT_EVIDENCE` | 否 | 论文中没有足够证据，不是系统故障 |
| `CITATION_STALE` / `CITATION_INVALID` | 否 | 引用 revision/hash 已失效，不展示伪定位 |
| `QUERY_SCOPE_INVALID` | 否 | 请求的文档/版本不属于当前允许范围 |
| `RAG_CANCELLED` | 否 | 用户取消；不得保留伪 complete 消息 |

## 9. 分阶段路线与 DoD

本章只保留架构级路线；供模型逐步执行的精确代码修改、测试和人工验收已经拆分到 [`docs/rag-implementation/README.md`](rag-implementation/README.md)。任何执行者一次只完成一个编号计划，满足退出门禁并留下验证记录后才能进入下一项。

| 阶段 | 对应子计划 | 用户可见结果 | 退出 DoD |
|---|---|---|---|
| 基线恢复 | 00 | 现有导入/翻译行为稳定 | typecheck、lint、unit、coverage 恢复全绿；不得带着已知失败进入 RAG |
| 契约与持久化 | 01–02 | 状态准确，不把阅读与索引混为一谈 | 独立状态机、连续 migration、job 恢复/删除通过 |
| 本地知识库 | 03–05 | 无 AI Key 也能自动索引、搜索并跳转原文 | chunk provenance、FTS、IPC、知识库页面和 Reader 抽屉通过测试/验收 |
| 用户授权的语义检索 | 06–08 | 明确同意后可做 embedding 与混合检索；失败仍能词法搜索 | 零默认外发、profile 隔离、exact vector、RRF 和评测门槛通过 |
| 可选质量增强 | 09 | 用户可选择 rerank，超时自动降级 | 独立 capability、外发提示、fallback 和指标通过 |
| 论文问答 | 10–11 | 整篇/多篇/选区问答有可点击且可验证的引用 | 流取消、拒答、引用校验、快照一致性和注入防护通过 |
| 治理与发布 | 12–13 | 历史、存储、删除、托盘后台和大库性能可控 | 清理/删除语义、基准、packaged smoke 和发布证据齐全 |

### 9.1 推荐实施顺序与依赖

```text
00 恢复现有基线
  -> 01 契约/独立状态
  -> 02 持久化与 durable jobs
  -> 03 chunk + provenance
  -> 04 自动本地 FTS 后端
  -> 05 知识库搜索 UI / Reader 抽屉     （第一个完整用户价值）
  -> 06 AI capability + 明示同意
  -> 07 embedding + exact vector
  -> 08 hybrid + 评测
  -> 09 可选 rerank
  -> 10 chat + citation
  -> 11 selection QA + Reader 集成
  -> 12 历史/存储/删除治理
  -> 13 性能/托盘/发布；达到门槛后才评估 ANN
```

不要把聊天 UI 作为第一阶段。先让用户能看到 chunk、全文搜索结果和真实页码，能最快暴露解析/mapping/中文检索问题；如果这些基础证据不可靠，增加 LLM 只会把问题隐藏在流畅答案后面。

### 9.2 各阶段建议改动位置

| 阶段 | 主要新增/修改位置 | 关键测试 |
|---|---|---|
| 01–02 | `shared/rag*.ts`、`core/types.ts`、`core/jobs.ts`、`v2Database.ts`、Repository ports | migration 1→新版本、checksum、job CHECK、独立状态机、删除/恢复 |
| 03 | `utility/core/compute/structureAwareChunker.ts`、`markdownBlocks.ts` 抽取共享 AST visitor | 金标 Markdown：标题、长段、跨页、表、公式、图片、列表、Unicode offset |
| 04–05 | `utility/core/persistence/ragFtsIndex.ts`、Main/IPC search handler、Renderer Knowledge/Search drawer | FTS5 capability、word/trigram/短词、无 Key、转义注入、scope、删除/重建、跳页 |
| 06–07 | `main/ragEmbeddingJobRunner.ts`、`main/rag/providers/*`、Utility plan/store、Vault/Settings | 明示同意、能力探测、batch/429/401/维度/NaN/迟到响应/cancel/restart/cache/profile |
| 08–09 | `utility/core/retrieval/*`、`main/retrievalOrchestrator.ts` | exact similarity、RRF、canonical 去重、文档配额、rerank 降级、token budget |
| 10–11 | `main/chatOrchestrator.ts`、流 IPC、Renderer ChatPanel/CitationCard、selection validator | event 顺序、取消、结构化输出、citation validator、选区/整篇/多论文/无答案 |
| 12–13 | conversation/storage repo、Settings/Storage、job resource lanes、release scripts | 删除/保留/清理、10k/50k/100k benchmark、ABI/ASAR、离线、升级/回滚、packaged smoke |

### 9.3 最小可用版本（建议）

真正的 MVP 应截止在子计划 08 的“可检索证据”，而不是急着生成答案：

- 自动/手动为当前 parsed artifact 建 chunk；
- 支持纯本地全文搜索与引用跳页；
- 配置一个 embedding profile 后支持语义/混合搜索；
- 展示为什么命中（word/trigram/dense/hybrid、章节、页码）；
- 重新解析会产生新 content revision 并安全重建；译文变化只刷新词法 generation；所有作业可取消/重试/删除；
- 即使没有任何 AI Key，全文搜索仍可工作。

随后子计划 10–11 只是在已经验证的检索服务上增加 ChatProvider、citation 和选区快照校验。这使搜索功能与生成模型解耦，也为未来更换任意 AI API 保留稳定底座。

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

### 10.3 评测集如何建立

建议首版至少包含 30 篇有合法测试许可/团队自有的论文，覆盖中文、英文、双栏、扫描件、公式密集、表格密集、长附录和解析质量较差样本。问题不少于 200 条：

| 类别 | 建议占比 | 标注内容 |
|---|---:|---|
| 精确事实/术语/数字 | 25% | 相关 chunk、最小证据 span、可接受答案 |
| 同义/跨语言 | 20% | 中文 query + 英文证据，术语变体 |
| 表格/公式/图 caption | 15% | 表/式编号、列头/脚注、相邻解释块 |
| 跨段/跨章节综合 | 15% | 多个必要证据 chunk 与章节 |
| 多论文比较 | 10% | 每篇必须覆盖的证据 |
| 无答案 | 10% | 应拒答及缺少的信息 |
| 对抗/注入/超长输入 | 5% | 预期安全状态与不可执行动作 |

每条问题由两人独立标注 evidence，冲突仲裁。数据集保存 parser artifact hash、chunker/retrieval profile 和 split；调参只用 dev，最终 test 不参与阈值选择。可参考 QASPER 的论文问答类型，但本项目必须包含自身解析产物与中文使用方式，不能只报告通用公开榜单。

### 10.4 建议首轮门槛

以下是开始验收时的工程目标，需在第一个金标版本后按难度冻结；未测不得写成已达到：

| 指标 | 初始门槛 |
|---|---:|
| chunk 源文本覆盖率 | ≥ 99%，允许明确排除的 header/footer/discarded |
| chunk 非必要重复率 | ≤ 15% |
| 可映射内容的 page coverage | ≥ 98% |
| 事实/术语问题 Recall@10 | ≥ 0.90 |
| 跨语言问题 Recall@10 | ≥ 0.85 |
| hybrid Recall@10 | 不低于 dense-only/FTS-only 中较好者，且总体至少提升 3 个百分点才声明增益 |
| citation precision | ≥ 0.95 |
| citation recall | ≥ 0.90 |
| unsupported claim rate | ≤ 0.05；科研模式目标应继续压低 |
| 无答案正确拒答率 | ≥ 0.90 |
| 本地 lexical p95（50k chunks） | ≤ 100 ms |
| 本地 dense p95（50k chunks） | ≤ 150 ms（不含远程 query embedding） |
| 用户取消到停止发流 | ≤ 500 ms（Provider 可取消时） |

还必须报告置信区间/样本数和按类别分桶结果，不能用总体平均掩盖“公式问题全失败”。模型升级、维度、chunker、translation、parser 或 reranker 变化都要跑固定回归集，并保存相对基线。

### 10.5 线上可观测性（默认不采正文）

记录：request/job/profile ID、scope 文档数、候选数、每阶段耗时、cache hit、降级原因、最终引用数、用户取消和错误码。默认不记录 query、chunk、embedding、prompt 或回答正文。若用户自愿开启本地质量反馈，只保存点赞/点踩、匿名问题类别和 citationId/hash；导出诊断包前再次预览并脱敏。

## 11. 多 Agent 协作与变更纪律

1. 一个工作项一个 owner；同一工作树同一时刻不允许多个 Agent 修改同一文件。并行实现使用独立 branch/worktree，集成时保留最小 diff。
2. `shared/*` schema、Preload API、Main IPC、Core RPC、v2 migration、JobRepository、Artifact/PathPolicy、release scripts 是高风险边界；修改前先登记 owner、输入/输出、兼容策略、失败恢复和测试。
3. 文档、schema、migration、实现和测试必须同步；新增 RAG 表或 Provider 前先完成子计划 00–02，不能在普通任务中顺手改公共数据结构。
4. Agent 开始/结束都记录 `git status --short --branch`；不得覆盖他人改动、`reset`、stash、清理 release 或修改其他 worktree。
5. 每个工作项标注 `planned`、`implemented`、`verified` 或 `blocked`，并附源码/测试/评测证据。未运行的 package/E2E 不得写成通过。
6. 文档维护 owner 负责 baseline、公共契约、决策记录和总进度；实现 Agent 只修改领取的代码和测试。任何契约变更都要通知集成 Agent。
7. 不以“模型返回了页码/路径/引用”为可信证据；必须由应用端 schema、scope、hash 和 PathPolicy 验证。

## 12. 当前平台与发布限制

在当前 Windows build `26200` + GameViewer 环境，sandboxed Renderer/GPU 原生启动失败；本机没有 GUI E2E 通过证据。不得声称 Desktop GUI E2E 本机通过，也不得建议产品默认或 CI 降低 sandbox。专用 packaged CLI smoke 已通过，且不启动 Renderer；它只能证明打包入口的 CLI 启动 marker，不证明 UI、GPU、Renderer 或 RAG。

RAG 实现若增加 worker、模型或原生 vector backend，必须复用 Desktop 的 verified atomic release：所有内容先在精确 release staging 中构建、审计、解压校验、哈希和 packaged smoke 成功，再原子发布到 `release/`；失败保留 staging/恢复旧 release。不得把 RAG 目录、模型缓存、查询历史或密钥放进 release ZIP。

## 13. 已知后续事项

根仓库许可证文件和 `desktop/package.json` 的许可证元数据目前不一致；这只登记为后续法务/发布事项，本计划不修改许可证文本、package 声明或署名信息。RAG 的模型、FTS tokenizer、向量后端、云端 Provider 和数据保留策略都需在对应阶段单独完成许可与隐私评审。

## 14. 技术决策汇总（建议转 ADR）

| ID | 决策 | 状态 | 重新评估触发条件 |
|---|---|---|---|
| ADR-RAG-001 | canonical corpus 使用原文 parsed Markdown；译文是辅助 variant | proposed | 翻译质量/跨语言评测证明译文应成为主索引 |
| ADR-RAG-002 | AST + mapping 结构感知、叶子/父块层次切块 | proposed | 结构缺失文档比例过高，semantic chunking 有显著稳定增益 |
| ADR-RAG-003 | FTS5 word + trigram BM25 双词法通道 | proposed | packaged FTS5 不可用或中文检索达不到门槛 |
| ADR-RAG-004 | 1024d normalized Float32 为首个向量 profile | proposed | 1536/2048 或量化向量在本项目评测中有显著收益 |
| ADR-RAG-005 | exact scan 是正确性基线，ANN 达规模门槛后启用 | proposed | 50k chunk 的 p95/内存不达标 |
| ADR-RAG-006 | RRF k=60 融合，不直接相加异构分数 | proposed | 学习排序/校准分数在固定 test 上稳定胜出且可解释 |
| ADR-RAG-007 | reranker 可选、可降级，首版候选 qwen3.7-text-rerank | proposed | Provider 不可用、隐私不允许或本地模型更合适 |
| ADR-RAG-008 | citation 由应用签发并按 revision/hash 校验 | proposed | 不应取消；属于科研可信度核心不变量 |
| ADR-RAG-009 | Provider 与模型通过 profile/port 插拔，不引入 LangChain | proposed | 出现多个复杂编排需求且框架收益覆盖包体/抽象/升级成本 |
| ADR-RAG-010 | 默认本地 lexical；云 embedding/rerank/chat 分别授权 | proposed | 不应弱化；仅企业托管模式可另建策略 |

## 15. 主要风险、权衡与缓解

| 风险 | 影响 | 早期信号 | 缓解 |
|---|---|---|---|
| 解析/mapping 错误向下游放大 | 引用跳错页、回答证据错误 | page coverage 下降、mapping none 增加 | 索引前质量报告；低置信引用只到页/章节；保留 artifact hash |
| 中文 trigram 索引膨胀 | 数据库大、构建慢 | index size/chunk 上升 | contentless/external FTS、detail 选项基准、短词专用 exact；必要时换可打包 tokenizer |
| 云模型名称/能力/价格变化 | 无法建索引或维度漂移 | capability probe 失败、response dimension 变化 | profile 固定、版本化 adapter、旧索引继续可用、重建提示 |
| API 限流/断网 | 大论文索引中断 | 429/timeout | 小批次、checkpoint、jitter backoff、cache、本地 FTS 降级 |
| 向量库原生依赖破坏发布 | EXE 启动失败或 ABI 不匹配 | packaged smoke/ASAR 加载失败 | exact 基线；adapter 隔离；延后 sqlite-vec；hash/许可/回滚 |
| 同一证据原文/译文重复 | top-k 多样性差 | canonical duplicate rate 高 | canonical chunkId 去重、variant provenance 合并 |
| 长上下文“看似能替代检索” | 延迟/费用高且中间证据被忽略 | answer 随上下文长度恶化 | 检索 + rerank + 有界 context；长上下文只做受控对照实验 |
| Reranker 过度过滤 | 召回高但最终证据丢失 | Recall@40 高、Recall@10 降 | 保留 RRF fallback、按问题类型阈值、top gap 监控 |
| LLM 伪造引用/遵循论文指令 | 科研误导或安全问题 | citation validator 失败、可疑文本 | structured output、应用签发 ID、scope/hash 校验、无工具权限 |
| 删除不彻底 | 敏感论文仍在 cache/history/ANN | 删除后仍能召回 | tombstone + durable delete job + 完整清单 + 重建/审计测试 |
| 过早使用复杂框架 | 难以符合 IPC/Utility/PathPolicy 边界 | 大量通用 abstraction 绕过现有 port | 先写小型领域 port；以真实复用需求决定是否引框架 |

## 16. 为什么没有首选 LangChain/LlamaIndex/GraphRAG

这些框架能快速搭 demo，但当前项目的难点不是少几行“调用 embedding”的胶水，而是 Electron 隔离、1 MiB RPC、Utility 独占 SQLite、PathPolicy、durable job、artifact revision、Windows 原子发布和可验证 citation。通用框架通常默认单进程 Python/Node、直接持有文本与密钥、自由选择向量库；强行套入会产生第二套生命周期和状态真相。

本计划建议先定义 8–10 个窄领域 port。以后如果确实需要多种 loader、agent graph 或远程服务编排，可以在 Provider/实验层使用框架，但它不得拥有数据库、路径、凭证、citation 或公共 IPC 契约。这不是排斥框架，而是把它放在可替换的位置。

## 17. 进一步算法的升级条件

| 技术 | 什么时候值得做 | 必须证明的增益 |
|---|---|---|
| LLM Contextual Retrieval | 代词/跨章节 chunk 的 Recall 明显低，且用户允许索引时外发全文 | 相同 embedding/rerank 下 Recall@10 或 nDCG 显著提升，成本/隐私可接受 |
| Late Chunking | 有可本地运行、暴露 token embedding 的长上下文模型 | 对长章节检索优于确定性 header，GPU/CPU 延迟和内存可接受 |
| RAPTOR/层次摘要 | 综述、多跳问题长期失败，父块扩展仍不足 | 跨章节问题 evidence recall/answer faithfulness 提升，摘要引用可追溯 |
| ColBERT/多向量 | 精细术语匹配与长 passage 检索仍不足，且存储可接受 | nDCG/Recall 的收益覆盖数倍向量存储和查询成本 |
| SPLADE/learned sparse | BM25 中文/领域同义词不足且本地/云 sparse Provider 可用 | 相对 BM25 的召回增益，模型升级与索引成本可控 |
| GraphRAG | 目标变为跨大量论文的作者/方法/数据集关系发现 | 实体/关系抽取准确率、全局问题收益和 provenance 达标；不能只展示漂亮图谱 |
| 多模态 embedding | 用户必须按图像/图表视觉内容检索，而 caption 不足 | 图表金标 Recall 和答案准确率提升；OCR/VLM 注入、包体和费用通过审查 |

## 18. 外部依据（核对日期：2026-09-13）

以下资料用于解释选择，不替代本项目自己的评测：

1. SQLite 官方 [FTS5 文档](https://www.sqlite.org/fts5.html)：FTS5 的 BM25、列权重、`unicode61`、Porter、trigram、external/contentless 表及 trigram 短于 3 字符的限制。
2. Cormack、Clarke、Buettcher 的 [Reciprocal Rank Fusion 论文](https://research.google/pubs/reciprocal-rank-fusion-outperforms-condorcet-and-individual-rank-learning-methods/)：采用 rank-based 融合而非直接混合异构分数的依据。
3. Anthropic [Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)：contextual embedding/BM25、混合召回与 rerank 的经验；本计划先用确定性标题路径上下文，避免首版 LLM 索引成本。
4. Günther 等 [Late Chunking](https://arxiv.org/abs/2409.04701)：长上下文编码后再池化 chunk 的思路及其适用前提。
5. ICLR 2024 [RAPTOR](https://proceedings.iclr.cc/paper_files/paper/2024/hash/8a2acd174940dbca361a6398a4f9df91-Abstract-Conference.html)：递归聚类/摘要树用于长文多层抽象检索；本计划将其作为后续实验而非 MVP。
6. BGE-M3 [论文](https://arxiv.org/abs/2402.03216)：多语言、dense/sparse/multi-vector 与长输入能力，作为未来本地多模式检索候选。
7. Qwen 官方 [Qwen3 Embedding/Reranker](https://qwenlm.github.io/blog/qwen3-embedding/) 与阿里云 [Embedding 模型文档](https://help.aliyun.com/zh/model-studio/embedding)、[Rerank 文档](https://help.aliyun.com/en/model-studio/rerank)：模型能力、维度、语言、批次和 endpoint 限制的当前依据。
8. Cohere 官方 [Rerank 概览](https://docs.cohere.com/v2/docs/rerank-overview)：多语言 cross-encoder rerank 的国际 Provider 备选。
9. `sqlite-vec` [官方 releases](https://github.com/asg017/sqlite-vec/releases)：目前仍为 0.1.x alpha，因此只作为通过 packaged benchmark 后的 adapter。
10. BEIR [论文](https://arxiv.org/abs/2104.08663)：BM25 是稳健基线，rerank/late interaction 通常质量高但成本也高，支持“先混合基线再逐项评测”的路线。
11. QASPER [论文与数据](https://aclanthology.org/2021.naacl-main.365/)：整篇科研论文问答与证据选择的公开参考任务。
12. OWASP [RAG Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/RAG_Security_Cheat_Sheet.html) 与 [Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)：不可信文档、RAG poisoning、结构化隔离、最小权限和输出验证依据。

## 19. 最终建议

如果现在开始编码，最负责任的第一批工作不是接聊天 API，而是：

1. 完成 RAG migration/profile/revision/job 契约；
2. 基于现有 remark + block mapping 实现可预览、可测试的层次 chunk；
3. parsed artifact 到达后先交付完全本地、无需 Key 的 FTS5 搜索与 Reader 引用跳转；
4. 以单独 capability profile 引用 Vault 凭证，取得明确同意后，按 translation plan 的跨进程模式接入 embedding provider，建立 exact vector 基线；
5. 用本项目金标确定 hybrid/RRF/rerank 参数，rerank 无增益时保持关闭；
6. 最后接 ChatProvider，并把“无证据不回答、引用必须绑定 artifact 快照且可验证”设为上线门槛。

这条顺序能让每个阶段都有独立用户价值，也能避免在底层证据不可靠时用 LLM 的语言流畅性掩盖错误。严格执行入口见 [`docs/rag-implementation/README.md`](rag-implementation/README.md)。
