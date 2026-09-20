# 08 — 混合检索与离线评测

> 状态：`planned`
>
> 前置计划：07

## 用户结果

精确术语、公式与自然语言语义能共同召回；用户看到为何命中，并在语义服务不可用时自动退回本地结果。

## 代码修改任务

1. 实现确定性检索管线：lexical top 40 + dense top 40 → canonical chunk 去重 → RRF `k=60` → 文档配额/多样性 → parent/neighbor expansion → token budget → 最终证据。
2. RRF 只融合 rank，不直接相加 BM25/余弦异构分数；保留每路 rank/score/profile/content revision provenance。
3. 查询计划默认规则化：短标识符/公式提高 lexical；自然语言开启 dense；semantic disabled/failed 时只跑 lexical 并返回显式 degradation，不报整个搜索失败。
4. 强制 document scope、active content revision、ready vector profile；旧/stale index 不混入当前查询。
5. 搜索 UI 增加“本地/混合”选择与明确状态；只有 vector ready 才允许混合。结果说明命中通道，不显示虚假置信百分比。
6. 建立版本化、无版权风险/团队自有的小型 golden fixture 与评测脚本，先覆盖术语、中英跨语言、表格、公式、多文档、无答案。
7. 输出 Recall@5/10、MRR/nDCG、延迟、scope 泄漏计数，并保留 FTS-only baseline；参数固定在版本化 profile，不按测试集偷偷调参。

## 重点文件

- 新增 `desktop/src/utility/core/retrieval/hybridRetriever.ts`、`rrf.ts`、`evidenceExpansion.ts`
- 新增 `desktop/src/main/retrievalOrchestrator.ts`
- 搜索 IPC/result schema 与 Knowledge/Reader UI
- `desktop/evaluation/rag/*`（fixture、gold、runner、README）

## 自动测试与评测

覆盖 RRF 手算样例、重复 chunk、每文档配额、parent/neighbor token budget、stale profile、dense 失败降级、scope 泄漏为零、稳定排序、并发取消。评测脚本必须固定 seed/profile 并输出机器可读 JSON。

```powershell
pnpm --dir desktop test tests/rrf.test.ts tests/hybridRetriever.test.ts tests/retrievalOrchestrator.test.ts tests/KnowledgePage.test.tsx
pnpm desktop:rag-eval
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:test:coverage
```

若 `desktop:rag-eval` 尚不存在，本计划负责加入 package script，但不能依赖真实付费 API；使用固定 fake embeddings 或已许可的小型向量 fixture保证可复现。

## 人工验收

对同一组问题切换本地/混合模式，检查术语仍由 lexical 命中、跨语言问题能受益于 dense、断开 provider/禁用 semantic 后 UI 明确显示降级且仍返回本地结果；点击结果仍定位当前 content revision。

## 退出门禁

- scope 泄漏计数为 0；所有结果可解释来源。
- 混合 Recall@10 不低于 FTS-only；若无显著增益，记录原因并保持 semantic 非默认，而不是宣称提升。
- 评测数据/profile/version/输出可复现。
- 运行时 dense 失败不会清空 lexical 结果。
