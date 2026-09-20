# 03 — 结构感知切块与来源谱系

> 状态：`completed`（2026-09-17）
>
> 前置计划：02

## 用户结果

搜索结果不再是失去标题、表头或公式上下文的碎片；每个片段都能稳定回到当前论文的章节和 PDF 页面。

## 代码修改任务

1. 抽取/复用 `shared/markdownBlocks.ts` 的 remark/GFM/math AST 遍历，不另写正则 Markdown 解析器。
2. 新增 `structureAwareChunker.ts`：
   - 标题形成 `sectionPath`，标题本身与后续正文建立 parent/child 关系；
   - 段落、列表、代码、公式、表格、caption 分类型；
   - 表格重复最小必要表头，caption/footnote 不与表主体失联；
   - 只有超长叶子块才按句子/安全边界拆分，overlap 有固定上限；
   - token 数使用版本化、确定性的估算器；provider tokenizer 变化不得改变 chunk identity；
   - source offset 明确为 UTF-16。
3. 将 chunk 与 `blockMapping` 对齐：保留 mappingIds、pageStart/end、bbox/置信度引用；低置信或无 mapping 允许检索，但 UI 必须能标记“定位可能不精确”。
4. `chunk_id` 由 document/content revision/ordinal/内容身份稳定生成；同输入重跑字节一致。
5. 实现 `rag-content-index` runner 的 `chunking` 阶段：从已登记 parsed artifact 读取，写入 building revision；失败只标该 revision failed，旧 active revision 保持可用。
6. 只在所有 chunk 与 provenance 校验通过后进入下一阶段；禁止从未登记任意路径读取。

## 重点文件

- `desktop/src/shared/markdownBlocks.ts`
- `desktop/src/core/blockMapping.ts`
- `desktop/src/utility/core/compute/structureAwareChunker.ts`（新增）
- `desktop/src/utility/core/utilityOperations.ts`
- `desktop/src/main/ragContentIndexJobRunner.ts`（新增）
- `desktop/tests/structureAwareChunker.test.ts` 与 fixtures

## 自动测试

fixtures 必须覆盖：中英文标题、超长段、emoji/代理对 offset、嵌套列表、代码 fence、行内/块公式、宽表格、caption/footnote、双栏跨页、重复文本、空 Markdown、恶意 HTML、缺失 mapping。断言稳定 ID/顺序、全文覆盖、overlap 上限、表头保留、offset 可回切原文、page/mapping 正确、取消/重试幂等。

```powershell
pnpm --dir desktop test tests/markdownBlocks.test.ts tests/blockMapping.test.ts tests/structureAwareChunker.test.ts tests/ragContentIndexJobRunner.test.ts
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:test:coverage
```

## 人工验收

选取至少一篇公式密集和一篇表格密集的现有解析 fixture，导出只读 chunk 调试报告：章节、类型、字符/token 数、页码、mapping confidence。逐一检查随机 20 个 chunk 可读且能定位。调试报告不得成为面向用户的“功能完成”入口。

## 退出门禁

- 同一 artifact 连跑两次 chunk ID、顺序和 hash 一致。
- 内容无非预期丢失，强制切分之外不产生大面积重复。
- building 失败不替换 active revision。
- 切块过程零网络调用。

## 实施与验收记录

### 已完成的实现

1. 在 Utility 进程新增结构感知切块器，直接复用项目现有的 remark/GFM/math AST 解析与 block alignment；没有增加第二套正则 Markdown 解析器。
2. chunk 按 `heading`、`paragraph`、`list`、`code`、`formula`、`table`、`caption`、`other` 分类。标题 chunk 作为稳定章节锚点，标题及其后叶子共享完整 `sectionPath`，以兼容现有 v4 数据结构的方式表达父子关系。
3. 普通叶子优先保留 AST 原始 UTF-16 source span；只有超过 700 个估算 token 的叶子才拆分。句子边界优先使用 `Intl.Segmenter`，无可用安全边界时才按 Unicode code point 拆分，因此不会截断 emoji 代理对。
4. token 估算器与 chunker 都有独立版本，并写入 `structure-aware-v1:tokens-v1:utf16` fingerprint。chunk identity 不依赖任何模型供应商 tokenizer，避免更换模型后无意义地重建全部 chunk。
5. 表格拆分同时处理长行、宽列和超长单元格。每个合成片段都重复最小必要表头；普通文本优先在附近空白处分段，无法分词的连续内容才按 code point 截断。表格合成片段引用整张表的 source span，并将定位置信度降为 `range`，不会伪装成精确字符定位。
6. 每个 chunk 保存稳定 ID/hash、连续 ordinal、章节路径、mapping IDs、页码范围、UTF-16 offset、token 数、内容类型和定位置信度。缺失 mapping 时仍可切块，页码为空且置信度为 `none`，供后续 UI 明确提示“定位可能不精确”。bbox 不在 chunk 中复制；通过 `mappingIds -> BlockMapping.boxes` 保留单一来源，避免两份坐标漂移。
7. 新增严格的 `compute:rag-content-index` Core RPC、Main facade 和 `rag-content-index` job runner。跨进程只传 `documentId/contentRevisionId`，Markdown、mapping、chunk 正文和 SQLite 写入全部留在 Utility。
8. 索引器只读取数据库已登记且属于当前文档的 `parsed_markdown`/`block_mappings` artifact，并执行根目录约束、普通文件检查和 SHA-256 校验；未登记路径、越界路径、内容 hash 或 schema 不一致均为不可重试错误，临时文件 I/O 才标记为可重试。
9. chunk 全量校验后，通过单个 SQLite 事务替换目标 revision 的 chunk 并切换 active revision。新 revision 构建失败或取消时，旧 active revision、`ready` 状态和 100% 进度继续可用；首次构建取消则回到 `queued`，可以安全重试。
10. 完整回归暴露了 Windows 上同一翻译计划并发原子替换 `plan.json` 的偶发 `EPERM`。本阶段为同一 `taskId/jobId` 增加了有界串行写队列，并在队列完成后删除 tail，既消除测试与实际并发风险，也避免常驻 Map 随任务数增长。

### 技术选择及其运行时优势

- **AST-first 而非递归字符切割**：标题、代码 fence、数学公式和表格先成为语义叶子，再按需切长叶子。相比固定字符窗口，搜索结果拥有可读章节上下文；相比额外 Markdown 正则，行为与阅读/翻译链路一致，边界不会形成两套事实来源。
- **确定性轻量 token 估算而非 provider tokenizer**：中文、日韩文字和 emoji 按单个 token 保守计数，连续拉丁字母数字按四字符估算。它不追求某个模型的计费精度，而优先保证离线、快速、可复现和模型可替换；第四步向具体 embedding API 发请求时仍应按该模型真实上限做最后一道批次校验。
- **结构化表格文本而非原 Markdown 横切**：`Table columns + Row` 让每个片段独立可检索并保留列语义；列分组可以覆盖远宽于上下文窗口的表格，长单元格续片仍带表头。代价是表格片段为派生文本，所以定位故意使用整表范围和较低置信度。
- **零 overlap 默认值**：当前每个 AST 叶子已经携带 `sectionPath`，重复窗口带来的索引体积和召回噪声大于收益，因此实际 overlap 为 0（满足不超过 64 的上限）。后续如真实检索评测证明跨叶子问题召回不足，应以可版本化策略引入，而不是静默改变 chunk identity。
- **事务发布而非逐条可见写入**：读者始终看到上一份完整索引或下一份完整索引，不会看到半张表、半个 revision；这比“先删旧数据再分批插入”更符合桌面端断电、取消和重试场景。

### 自动测试结果

- 结构切块与索引专项：覆盖中英文标题、超长中英文段落、emoji/代理对、嵌套列表、代码 fence、行内/块公式、caption/footnote、宽表/长表/超长单元格、重复文本、空 Markdown、HTML、缺失 mapping、双页 bbox、稳定重跑、取消、失败保旧和重试。
- 并发元数据回归：`taskService.test.ts` 连续执行 10 轮，40/40 个断言通过。
- 全量 Vitest：64/64 个测试文件通过，325 个测试通过，3 个跳过。
- 覆盖率：statements/lines 87.30%，branches 77.18%，functions 86.65%；新增 `rpcRagContentIndexer.ts` 达到 100% statements/branches/functions/lines。
- TypeScript typecheck：通过。
- ESLint：0 error，50 warning；warning 规则未作为本阶段阻断项，未发现新增可执行错误。
- `git diff --check`：通过；仅报告仓库现有的 LF/CRLF 转换提示。
- Utility 生产构建及 bundle smoke：通过；bundle 638.68 kB，gzip 178.96 kB。

### 人工验收结果

使用公式密集与表格密集的合成现有格式 fixture 生成只读调试报告，并逐项检查 20 个样本 chunk。最终结果满足：

- 20/20 均能解析到预期章节、mapping 与页码；
- 最大 token 估算为 697，未突破 700 硬上限；
- 公式与普通 AST 叶子可按 UTF-16 offset 回切原文；
- 表格续片均保留完整表头，包含空格的长单元格优先从完整词边界继续；
- 相同输入两次运行的 chunk ID、顺序和 hash 一致；
- 调试报告测试文件已删除，没有留下伪装成用户功能的入口或构建产物。

### 本阶段边界

- 本阶段只完成本地结构化切块、来源谱系和 revision 发布；没有实现 embedding、向量索引、混合检索、rerank 或问答 API，这些属于后续计划。
- 当前父子关系由 heading anchor 与相同 `sectionPath` 表达，没有新增显式 `parentChunkId` 列；bbox 通过 mapping 引用解析。若后续检索实验需要独立父块召回，可通过新 schema migration 增加显式边，而不破坏当前稳定 ID。
- 03 的退出门禁已经满足；未开始 04。
