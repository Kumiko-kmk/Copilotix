# document

統一文件身份、Markdown 塊、來源對映、圖組及編輯投影。解析、閱讀、翻譯、問答與檔案使用本模組；本模組不依賴其消費者。

## 契約與恢復

- contract 定義 DocumentBase、DocumentBlock、DocumentSnapshot、DocumentAnchor；原始 Markdown、PDF 與歷史編輯檔保留。
- utility 的 DocumentModelStore.ensureBase 按需產生 model/base.v1.json，來源版本由 Markdown、對映、layout 內容及演算法版本的 SHA-256 決定。stat 僅作程序內快取命中提示，沒有用 updatedAt 當來源版本。模型快取最多 8 篇；這不改變文庫預熱快取。
- 快取帶內容摘要；先寫唯一 partial、fsync，再原子 rename。來源變動拒絕提交，損壞快取從來源重建，舊文庫首次使用才生成。
- core 的 getSnapshot 統一編輯、刪除、排序與譯文投影；翻譯內容摘要和編輯 revision 獨立於基礎模型。runtime 沿用 edits/markdown-edits.v1.json，不改寫使用者歷史內容。
- `markdownEditRequestSchema` 已移除 `box`／`unbox` 與專用 `block` 目標；儲存層 `boxMarks` 仍用於歷史讀取，其他編輯保留該欄位，不做資料遷移。段落／圖組拖曳及 `reset-order` 契約保留。
- 同版本塊 ID 穩定。跨版本只接受唯一內容摘要對應；無版本且缺少來源摘要的歷史譯文保留獨立顯示／匯出，不猜測其段落定位；歧義編輯、譯文與錨點保留為未匹配，不按相同段落數猜測。legacyEdits、legacyManifest、legacyTranslations、legacyAnchors 是集中相容層；舊模組路徑只有轉出。
- compute:document-model 只回傳路徑、來源版本及摘要；Main 受控讀檔，Renderer 經既有 copilotix-asset 協定讀取大模型並核對摘要。Core RPC 限額不變。
- getDocumentSnapshot／snapshotTextFile 供全文件案輸入；model/snapshot-<hash>.md 為可重建的內容定址投影，描述讀取後再檢查來源版本。

## 測試與例外

測試位於 tests/features/document，另由 reader、translation、chat、insight 的相容與投影回歸覆蓋。core/markdownBlocks.ts、readerDocument.ts、readerFigureGroups.ts、readerFigureLayout.ts 保留原有成熟演算法，均未超過 600 行，無大檔例外；本次移動所有權而不拆改公式、表格與跨頁圖組的判斷次序。
