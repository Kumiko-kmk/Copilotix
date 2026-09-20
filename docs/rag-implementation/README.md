# RAG 分步实施计划索引

> 状态：`planned`
>
> 适用基线：`RAG_DEVELOPMENT_PLAN_ZH.md` v6（2026-09-16）
>
> 目标执行者：Luna Max 或其他代码代理

## 1. 使用规则

这些计划按依赖顺序设计。**一次只执行一个编号计划**，不得把多个计划合并成一次大改。每次开始前必须读取：

1. `docs/ARCHITECTURE_ZH.md`；
2. `docs/RAG_DEVELOPMENT_PLAN_ZH.md`；
3. 本索引；
4. 当前编号计划；
5. 当前源码、测试和 migration，不能只按文档猜测实现。

每个计划都包含代码、自动测试和人工验收。执行纪律：

- 先运行该计划列出的前置命令，确认上一步确实全绿；失败时停止并报告，不把失败带入下一步。
- 只修改“允许改动范围”内与目标直接相关的文件；若实际源码需要额外文件，先在交付记录中说明原因。
- 先补/改契约测试，再实现最小代码；不得通过删除测试、放宽断言、扩大 coverage exclude 或静默 fallback 取得绿色结果。
- 数据库变更只能增加连续、有 checksum 的 migration；禁止直接改旧 migration。
- Renderer 不接触数据库、文件系统、密钥或任意 URL；Main 持有网络和凭证；Utility 持有 SQLite 与重计算。
- 任何云端能力默认不上传论文；用户保存过 Key 也不代表同意 embedding、rerank 或 chat 外发。
- 每步结束运行该计划的全量门禁，并按“交付记录模板”更新对应计划末尾。没有证据不得把状态改成 `completed`。
- 不提交、不推送、不清理用户现有改动，除非用户另行明确要求。

## 2. 编号与依赖

| 编号 | 计划 | 依赖 | 完成后的独立价值 |
|---:|---|---|---|
| 00 | [恢复现有基线](00_BASELINE_STABILIZATION.md) | 无 | 现有解析/翻译测试重新全绿 |
| 01 | [RAG 契约与独立状态](01_RAG_CONTRACTS_AND_STATES.md) | 00 | 所有后续模块共享可验证协议 |
| 02 | [持久化与 durable jobs](02_RAG_PERSISTENCE_AND_JOBS.md) | 01 | 可恢复的内容/语义索引状态 |
| 03 | [结构感知切块](03_STRUCTURE_AWARE_CHUNKING.md) | 02 | 可追溯、稳定的论文检索单元 |
| 04 | [本地 FTS 后端](04_LOCAL_FTS_BACKEND.md) | 03 | 无 Key 的自动本地检索服务 |
| 05 | [本地搜索 UI](05_LOCAL_SEARCH_UX.md) | 04 | 用户可搜索并跳转论文来源 |
| 06 | [AI 能力配置与隐私同意](06_AI_CONNECTIONS_AND_CONSENT.md) | 05 | 可控、零默认外发的 AI 开关 |
| 07 | [Embedding 与精确向量检索](07_EMBEDDING_AND_EXACT_VECTOR.md) | 06 | 可恢复的语义检索基线 |
| 08 | [混合检索与评测](08_HYBRID_RETRIEVAL_AND_EVAL.md) | 07 | BM25+dense 的可量化质量增益 |
| 09 | [可选 Reranker](09_OPTIONAL_RERANKER.md) | 08 | 高质量模式与可靠降级 |
| 10 | [问答流与可信引用](10_CHAT_STREAMING_AND_CITATIONS.md) | 08；09 可选 | 整篇/多篇论文的有据问答 |
| 11 | [选区问答与 Reader 集成](11_SELECTION_QA_AND_READER_INTEGRATION.md) | 10 | 针对当前段落的稳定问答 |
| 12 | [历史、存储与删除治理](12_HISTORY_STORAGE_AND_DELETION.md) | 11 | 用户可理解的数据生命周期 |
| 13 | [性能、托盘与发布验收](13_PERFORMANCE_RELEASE_AND_OPTIONAL_ANN.md) | 12 | 可发布、可扩展的大库版本 |

必须顺序执行 00–08。09 是可选质量层；若暂不实现，10 必须显式使用 RRF 结果且 UI 不显示 rerank 已开启。10–13 继续顺序执行。

## 3. 跨计划不变量

以下规则任何阶段都不能破坏：

- `DocumentWorkflowStatus` 只描述导入/解析/翻译；RAG 用独立 `KnowledgeStatus`。
- parsed artifact 发布后即可建立本地原文索引；翻译不是本地搜索前置条件。
- `rag-content-index` 离线运行；`rag-embed` 只有在明确同意且能力有效时运行。
- content revision、lexical generation、vector index 是不同生命周期；embedding 失败不得使 FTS 失效。
- citation 身份绑定 document、artifact/content revision、chunk、content hash；模型不能自造页码。
- 文档 scope 必须在 IPC、Main、Utility 和 SQL 每层校验；任何结果不得跨越请求 scope。
- 删除任务必删应用内索引；`deleteFiles` 只控制磁盘文档产物。
- 主窗口关闭后后台任务若继续，用户必须能在托盘/重新打开后看到、暂停、取消或重试。

## 4. 每步统一验证门禁

除子计划的专项命令外，完成代码后至少运行：

```powershell
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:test:coverage
```

涉及 Renderer 用户流程时增加相关 Playwright 用例；涉及打包、原生扩展或发布时增加 build/packaged smoke。若当前机器不具备 GUI 或签名条件，不能伪造通过，应记录“未运行、原因、在何环境运行”的可复现命令。

## 5. 交付记录模板

每个计划完成后，在该文件末尾追加，不覆盖计划正文：

```markdown
## 实施记录（YYYY-MM-DD）

- 状态：completed / blocked
- 实际修改文件：...
- 设计偏差及理由：无 / ...
- 自动测试：命令 + exit code + 关键计数
- 人工验收：场景 + 结果 + 证据
- 已知限制：无 / ...
- 下一计划是否可开始：是 / 否；理由
```

`blocked` 不是失败：遇到不明确的数据迁移、云端协议或用户授权问题时应停止，而不是扩大范围自行决定。

## 6. 给执行模型的固定提示词

每次只替换 `<编号文件>`，不要一次发送多个计划：

```text
请严格执行 docs/rag-implementation/<编号文件>。

开始前完整阅读 docs/ARCHITECTURE_ZH.md、docs/RAG_DEVELOPMENT_PLAN_ZH.md、
docs/rag-implementation/README.md 和该编号计划，并检查当前源码与工作树。
仅完成本编号的代码修改、测试和人工验收，不提前实现下一编号，不覆盖无关现有改动。
先运行前置门禁；若失败，定位并只在本计划允许范围内处理，无法安全处理则标记 blocked 并停止。
不得删除/放宽测试、降低 coverage、扩大 exclude、跳过 migration 或把未运行的 E2E/打包写成通过。
完成后运行全部专项与统一门禁，在计划末尾追加实施记录，列出实际文件、命令、exit code、
关键测试计数、人工验收证据、偏差与剩余风险。只有所有退出门禁满足时才将状态改为 completed。
不要提交、推送、reset、stash 或清理用户文件；完成后等待我确认是否进入下一编号。
```
