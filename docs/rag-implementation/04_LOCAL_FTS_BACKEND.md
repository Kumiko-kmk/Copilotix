# 04 — 自动本地 FTS 后端

> 状态：`planned`
>
> 前置计划：03

## 用户结果

论文解析完成后无需 API Key、无需翻译、无需开启 AI，就能在本机搜索标题、术语、公式标识和正文。

## 代码修改任务

1. 启动时在 Utility 探测 FTS5、`unicode61` 和 `trigram` 实际能力；探测失败返回稳定错误，不静默假装完成。
2. 增加连续 migration 和 `rag_fts_word`/`rag_fts_trigram`（具体 external-content/contentless 方案以测试证明为准）；`rag_chunks` 是事实来源，FTS 可删除重建。
3. `rag-content-index` 流程调整为 `chunking → source lexical → publishing`：chunk 与两个词法通道完整后事务性激活 content revision。
4. 查询策略：
   - 英文/拉丁长词走 word/BM25；
   - 中文/混合字符串走 trigram；
   - 少于 3 字符的中文、公式、缩写、标识符走 bounded exact fallback；
   - 所有用户 query 经 parser/escaping，不拼接任意 FTS 语法；
   - scope、limit、cursor 在 SQL 前验证。
5. 翻译 artifact 后到达时只幂等替换当前 revision 的 `rag_chunk_variants` 和译文 FTS，递增 lexical generation；不改写 canonical `rag_chunks`，不改变 chunk ID，不触发 embedding 重建。
6. 提供 Utility/Core 的 search 与 status operation，尚不暴露 Renderer IPC。
7. 删除/重建清除 FTS 残留；失败时旧 active revision 仍可搜索。

## 重点文件

- `desktop/src/utility/core/persistence/v2Database.ts`
- `desktop/src/utility/core/persistence/ragFtsIndex.ts`（新增）
- `desktop/src/utility/core/utilityOperations.ts`
- `desktop/src/shared/coreRpcSchemas.ts`
- `desktop/src/main/ragContentIndexJobRunner.ts`
- `desktop/src/main/translationJobRunner.ts`（只添加译文索引触发）

## 自动测试

覆盖 FTS capability、英文词形/标题权重、中文 trigram、1–2 字查询、公式/缩写、引号/运算符/恶意 FTS 输入、scope 隔离、稳定分页、snippet 边界、无翻译、译文后到、重复刷新、删除/重建、崩溃恢复、打包 Electron 所用 SQLite runtime 探测。

```powershell
pnpm --dir desktop test tests/ragFtsIndex.test.ts tests/ragContentIndexJobRunner.test.ts tests/v2Database.test.ts tests/translationJobRunner.test.ts
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:test:coverage
```

## 人工验收

在无 Qwen/DeepSeek 凭证且断网的环境导入/使用已解析的中英文 fixture，确认自动索引后能命中标题、英文术语、两个汉字、公式编号；加入译文后中文查询可命中英文原文，原引用身份不变。

## 退出门禁

- 网络 mock 断言建立/查询本地索引时调用数为 0。
- source FTS ready 不依赖翻译或 semantic 状态。
- translation 刷新不新增 content revision/embedding job。
- FTS 删除后相同 scope 零召回，且普通事实表状态一致。
