# 12 — 历史、存储与删除治理

> 状态：`planned`
>
> 前置计划：11

## 用户结果

用户知道索引和聊天占用多少空间，能按类别清理；删除论文后不会继续被搜索或问答，聊天历史只在主动开启时保存。

## 代码修改任务

1. 新增连续 migration：`rag_conversations`、`rag_messages`、`rag_citations`。历史默认关闭；开启时记录本地保存与系统账户可读风险，不把大量正文塞 Credential Manager。
2. citation 持久化为不可变快照：content revision/chunk/hash/excerpt/mapping/page/score provenance。源删除后标 `source_unavailable`，不得假装仍可跳转。
3. 明确删除矩阵：
   - 删除任务始终删除/tombstone RAG content、FTS、vectors、cache references；
   - `deleteFiles=false` 仅保留磁盘原始/解析文件，不保留应用索引；
   - 对话默认随文档删除或去标识化保留，必须由设置明示；
   - active/queued job 先取消，迟到 response 不得复活数据。
4. 扩展现有 Storage 页面/服务，同时统计 outputRoot 与 userData 中数据库、FTS/向量估算、embedding cache、聊天历史、临时 work descriptor；不得把数据库文件算进 outputRoot。
5. 提供分类清理：embedding cache、失败/旧 revision、聊天历史、全部知识库索引；显示将影响的能力和可否重建，执行前二次确认。
6. 清理使用事务/tombstone/受控路径；应用内记录删完但外部 API 数据无法代删时给出真实说明。
7. 增加 retention/容量上限和启动时孤儿清理；清理不能删除当前 active artifact 或用户 PDF。

## 重点文件

- `desktop/src/main/storageService.ts`、`settingsService.ts`、`documentCommandService.ts`
- `desktop/src/renderer/pages/SettingsPage.tsx`（Storage 区）
- `desktop/src/utility/core/persistence/v2Database.ts` 与 RAG repositories
- conversation/history IPC 与 tests

## 自动测试

覆盖历史默认不写；显式开启/关闭；删除矩阵所有组合；active job/迟到 response；FTS 零召回；vector/cache reference；多对话 citation；source unavailable；分类大小不重复计算；PathPolicy；清理幂等/取消/事务失败；日志不泄漏正文。

```powershell
pnpm --dir desktop test tests/storageService.test.ts tests/ragDeletion.test.ts tests/conversationHistory.test.ts tests/v2Database.test.ts tests/SettingsPage.test.tsx
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:test:coverage
```

## 人工验收

建立含本地/向量索引和聊天的文档：比较清理前后分类大小；清 embedding cache 后仍能 lexical/已发布 vector 搜索；删除任务但保留文件后，应用搜索零结果且磁盘文件仍在；打开旧聊天显示来源不可用而非错误跳转。

## 退出门禁

- 删除后所有应用查询路径都无法召回该文档。
- Storage 数字覆盖 userData 与 outputRoot，分类定义写入 UI/help。
- 历史默认关闭且可彻底清理。
- 无越界文件删除；所有 destructive target 有明确测试。
