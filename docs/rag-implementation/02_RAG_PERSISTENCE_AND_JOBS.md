# 02 — 持久化与 durable jobs

> 状态：`completed`
>
> 前置计划：01

## 用户结果

索引可在应用重启、托盘后台、网络失败和重新解析后安全恢复；本地索引与语义索引互不拖累。

## 数据模型

新增连续 migration（按执行时实际 schema 版本编号），至少包含：

- `rag_documents`：active content revision、本地状态/错误；
- `rag_content_revisions`：artifact/mapping/chunker 指纹、lexical generation、building/ready/stale/failed；
- `rag_chunks`：canonical 原文事实表，内容在 03 写入；
- `rag_chunk_variants`：按 translation artifact/generation 保存可替换译文，不改写 canonical chunk；
- `rag_profiles`：capability/profile 指纹，不存明文密钥；
- `rag_vector_indexes` 与 `rag_embeddings`；
- `rag_embedding_cache` 及总字节/LRU 所需字段；
- 重建现有 `jobs.kind` CHECK，增加 `rag-content-index | rag-embed | rag-delete`。

不要创建独立重复 lease 逻辑的 `rag_jobs`。本计划不创建聊天历史表，留给 12。

## 代码修改任务

1. 增加 repository operations 与 Core RPC schema，只传 ID、状态、hash、checkpoint 等小数据。
2. 将 job kind 扩展贯穿 shared/core/Main/Utility，但不投影进 `DocumentWorkflowStatus`。
3. scheduler 增加低优先级资源 lane：`rag-content` 和 `rag-embed` 各有独立并发上限；解析/翻译仍优先。
4. 实现幂等状态转换、lease 过期恢复、checkpoint、cancel/retry 和删除 tombstone 基础。
5. 新 parsed artifact 发布时，只排队一个 `rag-content-index`；尚无 runner 时保持 queued，不得声称索引完成。
6. `rag-embed` 创建条件集中在 domain service：content ready、semantic consent=true、capability profile 有效，缺一不可。
7. 删除 document 时无条件排队/执行 app-index 清理；`deleteFiles` 仅控制文档产物。

## 重点文件

- `desktop/src/utility/core/persistence/v2Database.ts`
- `desktop/src/utility/core/persistence/sqliteJobRepository.ts`
- `desktop/src/core/jobs.ts`、`types.ts`、`ports.ts`
- `desktop/src/shared/coreRpcSchemas.ts`
- `desktop/src/main/jobScheduler.ts`、`rpcJobRepository.ts`、`documentCommandService.ts`
- 新增 RAG repository/status service 与对应 tests

## 自动测试

必须覆盖：空库迁移；每个已有版本升级；migration checksum mismatch；事务中途失败回滚；重复启动幂等；旧 jobs 数据复制不丢失；新 CHECK 拒绝未知 kind；同 artifact 去重排队；lease 过期恢复；semantic 前置条件；级联/显式删除；embedding 失败不修改 local ready。

```powershell
pnpm --dir desktop test tests/v2Database.test.ts tests/sqliteJobRepository.test.ts tests/jobScheduler.test.ts tests/ragPersistence.test.ts
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:test:coverage
```

## 人工验收

用临时数据库模拟：已有文档升级后仍能阅读；新解析只出现 content job；未同意时没有 embed job；重启后 queued/leased job 正确恢复；删除文档后 RAG 普通表无残留。

## 退出门禁

- migration 连续且 checksum 固定，未改旧 migration。
- parse/translate 调度和任务状态回归测试全绿。
- 两类索引状态独立，删除语义已由数据库测试证明。
- 未实现的 runner 不得把 job 标为 success。

## 实施记录（2026-09-17）

- 状态：`completed`
- 实际修改文件：
  - 持久化与领域层：`desktop/src/utility/core/persistence/v2Database.ts`、`sqliteJobRepository.ts`、`sqliteRagRepository.ts`、`v2TaskRepositoryCompat.ts`、`database.ts`、`desktop/src/utility/core/ragDomainService.ts`、`utilityOperations.ts`；
  - 契约与 Main：`desktop/src/core/types.ts`、`ports.ts`、`desktop/src/shared/coreRpcSchemas.ts`、`desktop/src/main/rpcJobRepository.ts`、`rpcRagRepository.ts`、`jobScheduler.ts`、`taskService.ts`；
  - 测试：`desktop/tests/v2Database.test.ts`、`sqliteJobRepository.test.ts`、`jobScheduler.test.ts`、`ragPersistence.test.ts`、`v2TaskRepositoryCompat.test.ts`、`utilityOperations.test.ts`、`coreRpc.test.ts`、`taskService.test.ts`、`mainQualityGates.test.ts`。
- 关键实现与设计决定：
  - 新增连续的 v4 migration，重建 `jobs` kind CHECK 并保持完整外键图，增加内容 revision、chunk/variant、profile、vector index、embedding/cache、同意状态与删除 tombstone 表；未修改旧 migration。
  - parsed artifact 的内容 revision 身份由 `documentId + contentHash + mappingFingerprint + chunkerFingerprint` 决定，artifact/job ID 不参与身份；重复发布不重复排队，新内容会令旧内容/vector revision 进入 `stale`。
  - 内容 job 创建、旧 active job supersede、终态同一 job requeue 与 revision 切换位于同一事务；先 supersede 旧 active job 再 requeue 目标 job，避免部分唯一索引冲突。
  - `rag-embed` 只能由领域服务在 content ready、用户已明确同意、profile/credential reference 有效时幂等创建；embedding 失败不改变本地索引 `ready`。
  - scheduler 为 content 与 embedding 提供独立低优先级 lane；当前没有 runner 时 job 保持 `queued`，不会被领取或伪报成功。
  - 删除文档在 Utility 单一事务中写入无外键 tombstone、清理 RAG 数据并删除文档；`deleteFiles` 仍只控制文档产物。当前没有外部向量索引，因此不创建无实际消费者的伪 `rag-delete` job。
  - Core RPC 仅传递 ID、状态、hash 等小元数据；Renderer 未新增数据库或 RAG IPC 权限。
- 设计偏差及理由：
  - 原计划“无条件排队/执行 app-index 清理”落地为同事务同步清理 SQLite RAG 表并保留 tombstone，而不是排队 `rag-delete`。当前索引全部位于同一 SQLite，文档删除会级联删除 job；此时排队的删除 job无法可靠存活，也没有外部资源可清理。待后续引入外部/文件型索引时，再由 tombstone 驱动对应清理 runner。
- 自动测试（均为 exit code 0）：
  - 专项：`pnpm --dir desktop test tests/v2Database.test.ts tests/sqliteJobRepository.test.ts tests/jobScheduler.test.ts tests/ragPersistence.test.ts tests/v2TaskRepositoryCompat.test.ts tests/utilityOperations.test.ts tests/coreRpc.test.ts tests/taskService.test.ts`，8 个文件、62 个测试全部通过；
  - Main RPC 门面补充验证：`pnpm --dir desktop test tests/mainQualityGates.test.ts`，10/10 通过；
  - `pnpm desktop:typecheck`：通过；
  - `pnpm desktop:lint`：0 error、47 warning（既有 `no-explicit-any` 警告，未新增门禁错误）；
  - `pnpm desktop:test`：62 个测试文件通过，310 passed、3 skipped；
  - `pnpm desktop:test:coverage`：行/语句 87.02%、函数 86.36%、分支 77.37%，满足现有 coverage 门禁；新增 `rpcRagRepository.ts` 行/语句/函数覆盖率 100%。
- 人工验收（以临时 SQLite 数据库和可复核断言模拟运行时场景）：
  - v1/v2/v3 既有数据库均可升级到 v4，既有文档/job 保留，`foreign_key_check` 无错误，重复启动不重复迁移；
  - 同一 parsed artifact 重复发布只保留一个确定性内容 job；内容变化时旧 job 被 supersede，目标终态 job 可安全 requeue；translation artifact 不触发 canonical RAG；
  - 没有 content runner 时 job 保持 queued；缺少 content ready、同意或有效 profile/credential reference 时不会创建 embed job；
  - embedding 失败只更新语义状态，不破坏本地 ready；删除文档后普通 RAG 表无残留且 tombstone 为 succeeded，`deleteFiles=false` 不删除磁盘产物。
- 已知限制：本步骤只建立持久化、生命周期和调度骨架；结构感知切块、FTS、embedding API/runner、profile 凭证实测和 UI 分别留给后续编号计划。当前仅校验 profile 中的 `credentialRef` 非空，实际凭证可用性必须由后续网络 runner 在执行前再次校验。
- 下一计划是否可开始：是；02 的专项测试、类型检查、lint、全量测试和覆盖率门禁均已通过。需由用户确认后才进入 03，本次未提前实现 03。
