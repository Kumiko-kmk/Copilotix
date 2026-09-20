# 01 — RAG 契约与独立状态

> 状态：`completed`
>
> 前置计划：00 已完成并全绿

## 用户结果

应用能准确表达“文档已经可阅读，但本地索引尚在建立”“本地搜索可用，但语义搜索未授权”等真实状态，不再用一个模糊进度阻塞用户。

## 代码修改任务

1. 新增共享 `ragTypes.ts` 与 `ragSchemas.ts`（或遵循当前 shared 命名），定义并用 Zod 双向校验：
   - `LocalIndexState`: `unindexed | queued | indexing | ready | stale | failed`；
   - `SemanticIndexState`: `disabled | requires-consent | requires-credential | queued | indexing | ready | stale | failed`；
   - `ChatAvailability`: `disabled | requires-credential | ready`；
   - `KnowledgeStatus`，分别带进度、可重试错误和 active content/vector identity；
   - `RagScope`：当前文档、显式 documentIds、多文档集合，必须有数量/长度上限；
   - lexical/dense/hybrid search request/result、score provenance、citation locator；
   - 带 `artifactId`/content revision snapshot 的 selection request；
   - bounded stream event 与稳定错误码。
2. 在 `core/types.ts`/`ports.ts` 中声明最小端口，暂不提供假实现：`ChunkerPort`、`LexicalIndexPort`、`VectorStorePort`、`RetrieverPort`、`CitationResolverPort`。
3. 明确 `DocumentWorkflowStatus` 不增加 indexing/chat 状态；不得修改既有任务完成判断。
4. 所有 list/string/result 设置上限，使 IPC/RPC envelope 仍低于 1 MiB；result 用 cursor 分页，禁止返回全文或 JSON 浮点向量。
5. 契约注释说明 Renderer 不得传 provider URL、SQL、路径或密钥。

## 允许改动范围

- `desktop/src/shared/ragTypes.ts`、`ragSchemas.ts`（新增）
- `desktop/src/core/types.ts`、`ports.ts`
- `desktop/tests/ragContracts.test.ts`、`ports.test.ts`
- 必要的 barrel/export 文件

此阶段不改数据库、IPC handler、UI、job kind 或 provider。

## 自动测试

新增测试至少覆盖：每个状态的合法/非法转换样例；空 scope/超量 documentIds/超长 query 被拒绝；未知字段和超大 result 被拒绝；citation 缺 revision/hash 被拒绝；选区缺 artifact snapshot 被拒绝；现有文档契约完全未变。

```powershell
pnpm --dir desktop test tests/ragContracts.test.ts tests/ports.test.ts tests/documentContracts.test.ts
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:test:coverage
```

## 人工验收

用契约样例检查三个场景可被不同状态准确表达：无 Key 但本地 ready；已保存 Key 但未同意上传；embedding 失败但 lexical 仍 ready。此阶段 UI 不应出现任何“RAG 已可用”的入口。

## 退出门禁

- 所有 DTO 有 schema 和类型来源，不维护两套漂移定义。
- `DocumentWorkflowStatus`、现有完成条件和翻译状态未改变。
- 1 MiB 边界和 scope 上限有测试。
- 全量门禁通过后才能进入 02。

## 实施记录（2026-09-16）

- 状态：`completed`
- 实际修改文件：
  - `desktop/src/shared/ragTypes.ts`
  - `desktop/src/shared/ragSchemas.ts`
  - `desktop/src/core/types.ts`
  - `desktop/src/core/ports.ts`
  - `desktop/tests/ragContracts.test.ts`
  - `desktop/tests/ports.test.ts`
- 设计决策：`ragTypes.ts` 仅 type-only re-export `ragSchemas.ts` 的 inferred types；`RagScope` 收敛为 `current-document`、`documents`、`collection` 三个 discriminator；`SelectionRequest` 仅接受嵌套 artifact/content-revision/hash snapshot；`VectorStorePort` 保持 Utility 内部边界，使用带 `vectorIndexId`、`contentRevisionId`、`profileId`、`Float32Array` query vector 和 limit 字段的输入，并返回仅含 `chunkId`/`rank`/`score` 的候选；`RetrieverPort` 才接收 wire `RagSearchRequest`。未增加实现或修改 `JobKind`/`DocumentWorkflowStatus`。
- 自动测试：
  - `pnpm --dir desktop test tests/ragContracts.test.ts tests/ports.test.ts tests/documentContracts.test.ts` — exit code 0；3 files passed，24 tests passed。
  - `pnpm desktop:typecheck` — exit code 0。
  - `pnpm desktop:lint` — exit code 0；既有 47 条 warning，无 error。
  - `pnpm desktop:test` — exit code 0；61 files passed，288 tests passed，3 skipped（291 total）。
  - `pnpm desktop:test:coverage` — exit code 0；61 files passed，288 tests passed，3 skipped；整体 statements 86.77%、branches 76.64%、functions 86.22%、lines 86.77%，超过 80%/75%/80%/80% 门槛。
- 人工验收：使用 `knowledgeStatusSchema.parse` 与 `safeParse` 明确核验三场景，均成功：无 Key 时 `local=ready`、`semantic=requires-credential`；已保存 Key 但未同意时 `local=ready`、`semantic=requires-consent`；embedding 失败时 `local=ready`、`semantic=failed` 且保留可重试错误。检查 `desktop/src/renderer` 与 `desktop/src/preload` 未发现新增 RAG/Knowledge/semantic/citation/indexing 入口；既有 Reader 选区扩展点不属于本阶段新增功能。
- 统筹代理独立复核：重新运行专项、typecheck、lint、全量 test 和 coverage，均为 exit code 0；专项 24/24，通过 61 个 test files、288 passed、3 skipped；独立 coverage 为 statements `86.77%`、branches `76.63%`、functions `86.22%`、lines `86.77%`，仍满足门禁。另行审查并移除了重复 scope discriminator、双 selection wire shape，以及 VectorStore 接收文本 query 的错误分层。
- 已知限制：端口尚无实现，VectorStore 输入的数值上限由后续 Utility 实现/运行时校验落实；lint 仅保留既有 warnings。
- 下一计划是否可开始：是；01 契约、状态、端口和全量门禁均完成，且未改数据库、IPC、UI、jobs 或 provider。
