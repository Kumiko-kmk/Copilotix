# 09 — 可选 Reranker 与可靠降级

> 状态：`planned / optional`
>
> 前置计划：08

## 用户结果

质量模式可对最相关证据二次排序，但超时、配额或未授权时仍立即使用稳定的 RRF 结果。

## 代码修改任务

1. 增加独立 `RerankerPort`/capability profile 和同意记录；不得沿用 embedding 同意。
2. 只发送 RRF top 30 的最小必要 query/passage/metadata；记录外发条数而非正文。
3. provider response 校验文档数量、索引范围、有限分数、重复/缺项；异常视为 degraded。
4. 设置硬 timeout 和 cancel；任何失败返回原 RRF 顺序，并在 response/UI 标记 `rerankDegraded=true`，不阻断搜索。
5. 提供 `off | fast | quality`：off 不调用；fast 使用 RRF；quality 仅在 profile ready+consent 时 rerank。
6. 用 08 的 dev split 选择 topN/timeout，test split 只做最终报告；只有 nDCG/MRR 增益达到冻结阈值才建议默认 quality。

## 重点文件

- `desktop/src/main/rag/providers/rerank*.ts`
- `desktop/src/main/retrievalOrchestrator.ts`
- Settings capability UI、search mode UI、schemas
- provider/orchestrator/eval tests

## 自动测试

覆盖 off 零调用；未同意零调用；top 30 上限；乱序/重复/缺失/NaN response；timeout/cancel/429；RRF fallback 字节级顺序；日志无正文；profile 改变不污染缓存。

```powershell
pnpm --dir desktop test tests/rerankProvider.test.ts tests/retrievalOrchestrator.test.ts tests/ragConsent.test.ts
pnpm desktop:rag-eval -- --mode rerank
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:test:coverage
```

## 人工验收

在 fake reranker 正常、超时、返回非法索引三种情况下搜索同一 query；正常时显示 quality，后两者显示“已使用混合结果”且结果仍可点击。确认关闭 rerank 后网络调用为 0。

## 退出门禁

- fallback 与 RRF 基线完全一致。
- 质量增益、延迟和发送 passage 数有实测报告。
- 未达到增益阈值时保持 optional/off，仍可进入 10。
