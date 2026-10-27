# insight

AI 檔案卡（paper brief，文庫詳情頁）與圖片解讀（閱讀器圖組）。生成、存儲、授權與恢復語義見 [AI 檔案卡](../../../../docs/PAPER_INSIGHT_ZH.md)、[檔案卡格式](../../../../docs/PAPER_BRIEF_ZH.md)、[圖片解讀](../../../../docs/FIGURE_INSIGHT_ZH.md)。

## 公開 API

- `contract/paperInsight.ts`、`contract/figureInsight.ts`：請求、狀態與事件 schema。
- `contract/ipc.ts`：`paperInsightChannels`、`figureInsightChannels` 與 preload 工廠；`contract/rpc.ts`：`insightOperations`（`insight:*`、`figureInsight:*`、`compute:figure-insight-descriptor`）。
- `core/index.ts`：渲染檔案卡所需的 `PaperBrief`、`BriefAnchor`、`CONTRIBUTION_KIND_LABELS`、`backgroundPoints`。`core/paperBrief/` 是檔案卡的 schema、上下文、提示詞、字數與 grounding，`core/figureInsightPrompt.ts` 是圖片解讀提示詞。
- `main/index.ts`：`PaperInsightService`、`FigureInsightService`、`loadFullBriefContext`、IPC 註冊函式。模型經問答模組的 `ModelGateway` 由組裝層注入。
- `utility/index.ts`：`createInsightOperations`（Utility handler）、`PaperInsightStore`、`FigureInsightStore`（文庫分類與問答圖片取用）。
- `renderer/index.ts`：`usePaperInsight`、`PaperInsightActions`。

## 文庫小型目錄

`PaperInsightSource.list?`／preload `paperInsight.list?({documentIds})` 經 `paperInsight:list` IPC、`insight:list` Core RPC 一次讀取最多 200 篇本地快照，直接回傳陣列。`ArchiveInsightSnapshot` 包含文檔 ID、與文庫 summary 同投影的 `updatedAt`／`workflowStatus`、`savedStatus`（ready／missing／stale／failed）、`ready`、譯名、關鍵詞與一句話總結；不傳路徑、全文、摘錄或圖片。方法為可選以兼容既有呼叫與測試替身，Main／Utility／Preload 隨同一應用版本更新，無 migration 或持久化格式變更。

進入成熟檔案後，`PaperInsightSource.readSaved?` 經原 `paperInsight:get` 的可選 `savedOnly: true` 讀完整已保存內容，不由正在生成的 run 覆蓋成 generating，保持與 catalog 的成熟判斷一致。不帶該欄位的 get、生成／取消及閱讀器狀態語義不變；get 請求單獨使用 read schema，generate／cancel 仍只接受原文檔 ID schema。無新頻道、Core RPC、磁碟或資料庫格式變更；讀取失敗只回傳通用本地錯誤，不外洩路徑或上游內容。本次按使用者要求未執行測試。

Utility 每頁最多 4 篇並行，只讀並校驗已有 brief／legacy 檔案的 schema、document ID 與 artifact revision；成熟標記還要求 workflow completed、結果非 stale、對應全文 artifact 安全且非空。使用已保存結果，不被正在重新生成的 run 蓋成 generating。任何一篇缺失、損壞、檔案不安全或讀取中 revision 改變，只將該篇標記 unavailable（failed／stale），其他篇照常回傳。譯名僅從已存在、非 symlink、位於文獻根目錄內的 translated artifact 安全讀取最多 16 KiB 頭部，按共用 `archiveTranslatedTitle` 規則提取；不讀原文全文、不裁圖、不渲染封面，不發送模型請求。請求取消停止後續處理；維護仍受既有 IPC 與 Utility 生命週期門禁保護。本次依使用者要求未執行測試。

## 資料檔（文獻目錄，無 migration）

- `insight/brief.v2.json`：檔案卡；舊 `insight/insight.v1.json` 只讀兼容。
- `insight/figures/<hash>.v1.json`：每張圖的解讀。

## 封面來源快照

可選 preload `figureInsight.coverSource({documentId})` 經 `figureInsight:cover-source` IPC／Core RPC 回傳 `ArchiveCoverSource`（fingerprint、hasManifest、figureId／imagePath／尺寸／頁碼／cropBox／可選 displayWeight），與原圖片解讀 get／descriptor／生成完全分開。只讀安全文獻目錄中的 `figures.json`（最多 2 MiB）與每圖既有評分檔（最多 64 KiB），評分須通過 schema、文檔 ID、圖 ID、PNG hash、整圖來源 revision 及位置一致性校驗；壞評分只忽略權重，壞清單回傳通用錯誤，缺少清單才回 hasManifest=false。PNG 只檢查路徑與檔案 stat，不讀圖片或全文、layout、mapping 內容、不調用 descriptor、不發模型請求。

指紋包含封面來源算法版本、PDF sourceHash、最新 source_pdf／parsed_markdown／layout／block_mappings artifact 的版本與 hash、清單 bytes hash、評分 bytes hash、PNG 的 manifest hash 與 size／mtime。整圖缺失仍保留清單候選並將 missing 納入指紋，避免誤存為無圖單頁；讀取期間清單或 artifact 版本變化則失敗重試。每次最多 4 圖並行，僅保留小型投影，供 Renderer 的持久化雙頁快取失效，不改 catalog row 或文庫 schema。Main／Utility／Preload 隨同版本更新；舊呼叫與測試替身可省略新 API。此只讀接口不改磁碟／DB 格式，無 migration。

## 生成與恢復

檔案生成最多 8 篇同時準備／請求，同文檔仍只允許一個任務。雲端明確使用 chat 的后台隊列，與交互問答 FIFO 分離；Codex 沿用共享的 8 槽自適應后台預算。雲端首字節期限為實際開始 HTTP 後 120 秒，暫時錯誤最多 3 次嘗試，與一次格式修復分開，仍共用整次生成 600 秒取消期限；過長的 Retry-After 不盲目等待，Codex 不疊加重試。

啟動／文庫維護恢復後，只補回本地檔案為 missing 且有全文產物的文檔，發送前仍檢查已啟用服務商與有效憑據；ready（含 stale）保持原資料，不自動重生成。`autoGeneratePaperInsight` 沿用既有兼容語義：設定頁沒有開關，舊 false 不影響自動生成。待處理任務滿 200 時只保留文檔 ID 並等待槽位，不提前載入全文，也不丟棄後續文檔。維護、設定取消、退出會中止掃描與排隊，排隊取消立即移除並結束其等待，已開始的原子保存仍等待落盤。無 IPC／Core RPC／schema／存儲格式變更；本次依使用者要求未執行測試，相關既有入口為 `paperInsight`、`figureInsight`、`chatProvider` 用例。

## 測試

`tests/features/insight/`（`pnpm desktop:test --module insight`）；E2E `e2e/paper-insight.spec.ts`、`archive-math.spec.ts`。
