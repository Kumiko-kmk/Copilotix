# jobs

Utility 擁有 SQLite 作業倉庫；Main 的 `JobScheduler` 按 lease、依賴及種類調度，`ProgressReporter` 合併進度寫入。

## 公開入口

- `core/jobs.ts`：作業狀態、Repository／Runner 端口、受限狀態轉移。
- `contract/rpc.ts`：作業 Core RPC 契約；`main/rpcJobRepository.ts` 與 `utility/sqliteJobRepository.ts` 分別為代理與持久化實作。
- `main/jobScheduler.ts`：調度、heartbeat、取消、恢復與有限退避；預設翻譯文檔並發 4，解析與本地索引預算不變。

## 兼容與恢復

啟動先恢復已過期租約；每次 heartbeat 先延長本調度器的活躍租約，再經 `recoverExpired` 回收孤兒租約並喚醒調度，修復快速重啟時舊租約尚未到期、此後一直停在 running 的情況。有尚未結束的 runner 時，周期恢復帶上 `excludeLeaseOwner` 排除當前 owner，避免取消／續租失敗但未結束的 runner 被再次 claim；全部結束後恢復全部過期租約。保持既有 attempts、maxAttempts、檢查點、owner 條件與恢復狀態轉移；已到上限的 failed 與 partial 仍需使用者手動重試，不繞過上限。停止時不新增恢復輪詢，舊 runner 收尾僅移除自身 active entry。

Core RPC `jobs:recover-expired` 新增可省略的 `excludeLeaseOwner`，舊請求保持原語義；Main／Utility 經同一應用版本配套更新，無資料庫 migration、作業狀態或磁碟格式變更。本次按使用者要求未執行測試；既有入口為 `tests/platform/jobScheduler.test.ts`、`sqliteJobRepository` 與作業恢復用例。
