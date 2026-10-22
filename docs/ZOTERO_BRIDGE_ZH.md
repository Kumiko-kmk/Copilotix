# Zotero 橋接

只在本機運行：不聯網查元資料，不寫 `zotero.sqlite`。

## Zotero → Copilotix 導入（已實作）

- 入口：首頁「从 Zotero 导入」→ `ZoteroImportDialog`。左欄是分類樹，另有「全部條目」和「未分類條目」；右欄只列出帶 PDF 附件的條目，可篩選、勾選，每頁最多 200 條。
- 讀取順序（`main/zotero/zoteroCatalog.ts`）：
  1. 先用 Zotero 本機 API `http://127.0.0.1:<port>/api/users/0/{collections,items}`。只讀，預設不含回收站；需在 Zotero 勾選「設定 → 進階 → 允許此電腦上的其他應用程式與 Zotero 通訊」（pref `httpServer.localAPI.enabled`）。
  2. 若 Zotero 沒有回應、返回 403 或其他非 2xx，就把 `zotero.sqlite`（含 `-wal`）複製到應用 temp 目錄，以唯讀方式讀這份副本，讀完刪除副本。介面會顯示退回的原因。
  - 資料夾位置取自預設 profile 的 `prefs.js`（`extensions.zotero.dataDir`／`useDataDir`、`baseAttachmentPath`、`httpServer.port`），找不到就用 `~/Zotero`。
  - 只讀「我的文庫」（user library）。群組文庫未接入，但鏈接檔已預留 `groupID` 欄位。
  - 回收站語義與 Zotero 一致：已刪除的條目、分類，以及父條目已刪除的附件都不列出。
- 導入（`zoteroImportService.ts`）：renderer 只傳 `snapshotId` 和條目 key，不傳路徑；附件路徑由 Main 從快照解析，必要時改問 Zotero 的 `items/<key>/file/view/url`。每個條目取第一個存在的 `.pdf` 附件，先在 Main 串流計算 SHA-256，再走既有的 `TaskService.importPaths`（`createDuplicates: false`），所以去重、解析排隊、PathPolicy 落盤都與一般導入相同。
- 條目關聯：無論是新建的論文，還是雜湊已存在的論文，都把關聯原子寫入 `<文獻目錄>/zotero/link.v1.json`：`{ version: 1, links: [{ libraryID, groupID, itemKey, attachmentKey, linkedAt }] }`，最多 64 條；同一條目重複導入時覆蓋舊記錄。
  - 兼容：不新增 migration，不改 IPC 既有通道、Core RPC 或資料庫。舊版本會忽略這個目錄。
  - 備份／恢復／遷移：隨完整文獻目錄一起複製；卸載清理按文獻目錄處理，沒有逐檔清單需要同步。
  - 恢復語義：檔案損壞或不合 schema 時視為「沒有關聯」，不阻塞導入；再次從 Zotero 導入同一條目就會重建。
- IPC：`zotero:catalog`、`zotero:items`、`zotero:import`（schema 在 `shared/zotero.ts`），經 `registerValidatedHandler` 校驗來源，並受文庫維護鎖約束。
- 測試：`desktop/tests/zoteroBridge.test.ts` 覆蓋以下行為：用最小 Zotero schema 的 sqlite 副本驗證回收站／路徑解析；mock 本機 API 的成功、403 與連不上；`prefs.js` 定位；導入時新建與既有論文的關聯、缺檔報錯、已導入標記、過期快照拒絕。2026-10-21 用使用者真實文庫的唯讀副本試讀：該文庫 3 個分類和 103 個父條目都在回收站，所以只列出 2 條活條目（其中 1 個 PDF 不在本機）。

## Copilotix → Zotero 導出（已實作）

- 入口：閱讀器頂欄「导出到 Zotero」→ IPC `zotero:export`（`{ documentIds ≤50, repeat? }`）。走本機連接器（`zoteroConnector.ts`）；連接器在 Zotero 運行時恆開，與「允許其他應用通訊」無關。先 `ping`，連不上時提示先打開 Zotero。請求帶 `Zotero-Allowed-Request: 1`，否則類瀏覽器請求會被 Zotero 拒絕。
- 內容（`zoteroExportService.ts` 的 `buildZoteroNoteHtml`）：標題、譯名、AI 總結（v2 `tldr`／v1 `summary`）、原文與譯文的高亮／下劃線（最多 500 條，每條 ≤2000 字）、筆記（錨定原文＋正文），全部 HTML 轉義。
- 已從 Zotero 導入的論文（有 `link.v1.json`）：`saveItems` 一條 `itemType: 'note'` 的獨立筆記，內含 `zotero://select/library/items/<itemKey>` 連回原條目。連接器無法給既有條目加子項，2026-10-22 使用者選擇此方案。
- 其他論文：`saveItems` 建立 `document` 條目（只用解析得到的標題與摘要，`extra` 註明來源），帶子筆記，再用 `saveAttachment` 附上 `original.pdf`。若條目已建立但 PDF 上傳失敗，仍記錄已導出並明確報錯，避免重試時再建一份。
- 落點：Zotero 當前選中的分類；連接器 201 不回傳新條目 key，所以無法回寫關聯。
- 導出記錄：`<文獻目錄>/zotero/export.v1.json`（`{ version: 1, exports: [{ kind, exportedAt }] }`），用於「再次導出」前的確認。兼容、備份與損壞語義同 `link.v1.json`。
- 真實驗證（2026-10-22，經使用者同意，只建一條）：Zotero 9.0.6，`saveItems`、`saveAttachment` 均回 201；唯讀副本確認建出條目 `DKX43E9P`「Copilotix 连接器测试（可删除）」，含子筆記、PDF 附件 `M25DX55D`，位於「我的文獻庫」根目錄。該測試條目須由使用者在 Zotero 手動刪除。
- 本機 API 只讀（GET）；`/connector/import` 接受 RIS／BibTeX，連接器可用，故未做 RIS 退路。
- 測試：`zoteroBridge.test.ts` 的 export 段覆蓋連回原條目的筆記與 HTML 轉義、跳過已導出／`repeat`、新條目＋PDF、PDF 失敗半完成的記錄、連接器請求頭與 Zotero 未開的報錯。
