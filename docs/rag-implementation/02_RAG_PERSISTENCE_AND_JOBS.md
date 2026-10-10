# 02 — RAG 持久化與 durable jobs（已完成）

## 維護契約

- v4 migration 保留連續編號與 checksum，重建 jobs kind CHECK，新增 content revision、chunk／variant、profile、vector／embedding／cache、同意狀態及刪除 tombstone；不修改舊 migration。
- `rag-content-index`、`rag-embed`、`rag-delete` 為獨立 kind，不混入文檔 workflow；content／embedding 使用低優先級獨立 lane。尚無 runner 的作業保持 queued，不偽報 success。
- content revision 由 documentId＋contentHash＋mappingFingerprint＋chunkerFingerprint 決定，不由 artifact／job ID 決定；同內容不重排隊，新內容使舊 revision stale。
- 作業建立、舊 active 作業 supersede、終態 requeue、revision 切換在同一事務中；先 supersede 再 requeue，保持部分唯一索引約束。
- `rag-embed` 只由 domain service 在 content ready、semantic consent、有效 profile／credential reference 下冪等建立；執行前還须驗證憑據。embedding 失敗不改本地 ready。
- 刪文檔在 Utility 同一事務內清 SQLite RAG 資料並保留無外鍵 tombstone；`deleteFiles` 只控制磁盤文檔。當前沒有外部向量索引，不建立無消費者的刪除作業；後續外部資源清理須由 tombstone 驅動。
- Core RPC 只傳 ID／狀態／hash 等小元數據。未接入入口的 Main `rpcRagRepository.ts` 已刪除，實際知識狀態 operation／Utility 持久化保留。

實作入口：`utility/core/persistence/{v2Database,sqliteJobRepository,sqliteRagRepository,v2TaskRepositoryCompat}.ts`、`ragDomainService.ts`、`utilityOperations.ts`、`main/jobScheduler.ts`。

回歸入口：`v2Database.test.ts`、`sqliteJobRepository.test.ts`、`ragPersistence.test.ts`、`utilityOperations.test.ts`、`jobScheduler.test.ts`。覆蓋舊庫升級／外鍵完整性／重啟冪等、回滾、同內容去重、semantic 前置條件、失敗保本地狀態與刪除。切塊發布見 [03](03_STRUCTURE_AWARE_CHUNKING.md)。
