# 07 — Embedding 与精确向量检索

> 状态：`planned`
>
> 前置计划：06

## 用户结果

用户明确授权后可按语义检索论文；断网、限流或更换模型不会破坏已可用的本地全文搜索。

## 代码修改任务

1. 沿现有 translation plan 模式实现：Utility 生成受控 embedding work descriptor；Main 从 Vault 取 credential 并调用网络；Utility 校验 response 后批量写入。RPC 不传全文集合或 JSON 浮点向量。
2. 实现 `EmbeddingProviderPort` 与 OpenAI-compatible adapter；模型名、维度、instruction、归一化、metric 进入 immutable profile fingerprint，不硬编码某个模型为数据库常量。
3. `rag-embed` runner 支持批次上限、checkpoint、lease heartbeat、指数退避+jitter、429/5xx `Retry-After`、401/403 fail-fast、取消和重启续跑。
4. 严格校验 response 数量、顺序/索引、维度、有限数、非零范数；转为规范 Float32 并 L2 normalize 后写入。
5. embedding cache key 为完整 profile fingerprint + canonical content hash；设置容量/LRU；cache 命中仍校验维度。
6. 建立 building vector index，全部 chunk 完成后原子标为 ready；失败/取消保留 local ready 和旧 ready vector index。
7. query embedding 使用同一 profile/query instruction；禁止跨 profile 比较。
8. 在 Utility worker 中实现 exact dot-product scan、top-k bounded heap 与取消；不得在 Main/Renderer 事件循环扫描。

## 重点文件

- 新增 `desktop/src/main/rag/providers/embedding*.ts`
- 新增 `desktop/src/main/ragEmbeddingJobRunner.ts`
- 新增 `desktop/src/utility/core/compute/embeddingWorkPlan.ts`
- 新增 `desktop/src/utility/core/retrieval/exactVectorStore.ts`
- `coreRpcSchemas.ts`、`utilityOperations.ts`、scheduler 注册

## 自动测试

覆盖 batch 切分/顺序；work descriptor PathPolicy；401/429/5xx/timeout/迟到响应；取消点与重启 checkpoint；数量/维度/NaN/Infinity/零向量拒绝；Float32/L2/dot top-k 数学；profile/cache 隔离；旧 index 保留；未同意调用数 0；scope 隔离；大结果不越过 1 MiB。

```powershell
pnpm --dir desktop test tests/embeddingProvider.test.ts tests/ragEmbeddingJobRunner.test.ts tests/embeddingWorkPlan.test.ts tests/exactVectorStore.test.ts
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:test:coverage
```

## 人工验收

只使用 fake/local HTTP provider：启用同意后索引一篇 fixture；中途返回 429 再恢复；重启应用后从 checkpoint 继续且不重复已完成批次；关闭 provider 后 lexical 搜索仍正常。真实付费 API 测试需用户另行授权。

## 退出门禁

- 所有失败路径不改变 active content revision/local ready。
- vector index 只有全量校验成功才 ready。
- exact scan 有时间/内存基准记录，不在 Main/Renderer 执行。
- 没有引入 ANN/native extension。
