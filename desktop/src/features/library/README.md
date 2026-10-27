# library

文獻庫：導入（拖放、選檔、教程論文）、文獻與任務列表及其投影、首頁、文庫 3D 檔案頁、內容分類，以及文庫備份／恢復／遷移。介面契約見 [介面規範](../../../../docs/UI_PREFERENCES_ZH.md#文庫頁與-ai-解讀)，維護與恢復語義見 [文庫管理](../../../../docs/LIBRARY_MANAGEMENT_ZH.md)、[文庫分類](../../../../docs/LIBRARY_CATEGORIES_ZH.md)。

## 公開 API

- `contract/`：`ipc.ts`（`documents:*`、`library:*`、`tutorial:import-paper` 與 `documents:changed`／`documents:open` 事件，`createLibraryApi`）、`rpc.ts`（`libraryOperations`：`tasks:*`、`documents:*`、`artifacts:record-revision`、`compute:hash-file`、`compute:import-pdf`、`compute:library-categories`、`library:check|manage`；`CoreListCursor`）、`taskRepository.ts`（Main 側的 `TaskRepositoryCompat` 埠，設定與閱讀器也經它讀寫任務）、`taskCompute.ts`（`TaskComputePort`）、`documentSchemas.ts`／`documentTypes.ts`（文獻、導入與舊任務投影的 schema 與型別）、`artifacts.ts`（`DocumentId`、`ArtifactKind`）、`pdfLimits.ts`、`librarySchemas`、`libraryCategories`、`pdfImport`、`tutorialSample`。
- `core/index.ts`：`extractPaperProfile`、`displayPaperTitle` 等標題與論文資訊提取（Zotero 與文庫頁共用）。
- `main/index.ts`：`TaskService`（文獻指令的入口：導入、重試、刪除、導出、閱讀文件）、`RpcTaskRepository`、`RpcTaskCompute`、`DocumentFeed`、`LibraryAccessGate`、`registerLibraryIpc`、`registerTaskNotifications`。
- `utility/index.ts`：`V2TaskRepositoryCompat`（SQLite 文獻倉庫）、`createLibraryOperations`、`assertLibraryIdle`／`manageLibrary`。
- `renderer/index.ts`：`NewParsePage`（首頁與導入）、`TutorialPage`、文獻列表快取與狀態工具；`LibraryPage` 由組裝層懶載入（`App.tsx`），不經 index，以保留 Three.js 分包。

文庫進入時經 insight 的只讀批量 catalog 取得全庫的小型檔案狀態、譯名、關鍵詞與總結，每頁 200 篇；依文檔與來源版本隔離，移除文檔時釋放快取。進入權限只依已保存且當前有效的檔案與已完成工作流，滑鼠任意跨列點選、搜尋、拖動、滾輪、鍵盤共用同一份狀態，不依選中次序、相鄰預讀、圖片或封面是否已渲染。全庫已成熟論文另由 ArchiveCoverService 提前準備完整跨頁封面，不依賴相鄰位置；背景僅一個重任務，當前選擇優先、明確開檔可搶佔無關背景工作。已完成封面以 WebP 存入獨立 IndexedDB，完整卡片查詢仍最多 32 項、閒置 120 秒回收。

生成中的替代版本或其失敗不遮蔽已保存的可讀檔案；事件後只讀重查該文檔，更新譯名與實際可讀狀態，事件及版本標記阻止晚到結果覆蓋。暫時 RPC 錯誤最多三次嘗試，不增加持續輪詢；取消／卸載終止等待且忽略遲到結果。顯示頁主標題沿用文庫中的命名，全文資訊提取與封面重建只隨內容改變，不因進度／摘要時間戳更新重播。原文獻持久化格式不變；封面使用可重建的獨立 renderer 快取。

返回文庫時立即重查先前 missing／stale／failed 的狀態，避免閱讀器中完成生成、文庫未掛載而漏收事件後，被 30 秒快取保留為不可進入；已成熟快取仍保留原就緒畫面。回歸包含卸載期間生成再返回，端到端包含真實 provider mock／持久化與重開，不改資料格式或自動重發生成請求。

展開前的右欄內容寬度是唯一基準：展開後標題、作者、主分隔線、分頁底線與四欄正文均維持相同寬度；外包絡額外容納 32px 筆記槽，不從正文扣減。作者格與欄位遵循既有截斷並限制在欄內，遮擋條先擴邊、再與內容欄及逐層 overflow 可視區相交，既不越過右邊界，也不覆蓋捲動區外的文字。正文僅首行縮排 `2em`，後續行回到整欄左邊界；段末行自然左對齊。背景、結論、討論各點統一使用 1、2、3 編號，數字列與間距共 32px，標題首字與正文首行兩字對齊；不顯示結論頁籤總數。

完整跨頁封面在開檔動畫前完成 CPU 合成及 GPU 上傳；原有升起、鏡頭、玻璃曲線不等待外部工作。ArchiveDetail 只管理文字，不再清除／重建封面。尚未準備的冷檔先維持原瀏覽姿態，完整後才開始動畫；30 秒截止、失敗保留瀏覽，可重試，Esc／換篇／卸載取消並拒收晚到畫面，不能開到一半再補單頁或雙頁。封面按文檔版本、來源雜湊、整圖清單與已存評分指紋隔離；整圖已有可讀 PNG 時不重掃 PDF，缺圖不能誤存成合法單頁。

只有 complete 圖組屬於可生成整圖清單的來源；僅有 ambiguous／unsupported 提示且無已保存整圖時使用合法單頁，不等待永遠不會生成的清單。已有有效圖組但裁圖或讀圖失敗仍拒絕半成品，不能退成單頁掩蓋缺圖。無可靠圖組的單頁由檔案 HTTP／持久化與版面 E2E 覆蓋。

解碼後完整畫面以 48MiB LRU 限額保存，正在場景使用的畫面 pin 至紋理釋放；持久封面在獨立 `copilotix-archive-spreads` v1 庫，最多 128MiB／160 項，無需升級既有首頁庫。合成後清除首頁／圖頁 scratch canvas，位圖 decode 後釋放；IndexedDB／壓縮錯誤不阻止已準備畫面使用。只讀 `figureInsight.coverSource` 返回輕量指紋／幾何／權重，不讀全文、不觸發模型。文字進度事件不重傳紋理。

## 資料

- SQLite：`documents`、`jobs`、`artifact_revisions` 等（schema 與 migration 在 `platform/database`）。
- 文獻目錄 `documents-v2/<documentId>/`：`original.pdf` 與各模組的產物子目錄；備份 manifest v1 見文庫管理文檔。

## 測試

`tests/features/library/`（`pnpm desktop:test --module library`）；E2E `e2e/library.spec.ts`、`paper-archive.spec.ts`、`archive-layout.spec.ts`、`qa-fixes.spec.ts`。

2026-10-27 本地驗收：Windows／Electron 44.1.1／RTX3060、同一 production bundle、隔離三篇成熟論文副本；實際截圖並逐幀檢查冷首開、跨列首開、搜尋首開、熱重開及同 renderer 儲存重啟。opening 起封面均已是完整 spread，直到 open 的 key／尺寸／上傳次數不變；重啟持久命中沒有重新讀 PDF。四欄正文與展開前後主線／分頁線均為 560 CSS px，作者及遮擋邊界一致；結論編號與短公式斷行亦用實際 DOM／截圖檢查。Scene／封面服務用例包含取消、逾時、版本競態、pin／LRU 與持久命中。這是本地審閱構建驗證，不代表線上發布或安裝向導全流程驗收。

## 例外（超過 600 行）

- `utility/v2TaskRepositoryCompat.ts`（1064 行）：一個持有預備語句與事務的 SQLite 倉庫類；行型別、限制與投影已拆至 `compatRecords.ts`。按表拆類需重新劃分事務邊界，留待功能分支。
- `renderer/archive/PaperArchiveScene.ts`（1520 行）：Three.js 場景類，渲染迴圈、材質池、相機與詳情動畫共用同一份可變狀態；常量、調色盤與型別已拆至 `archiveSceneConfig.ts`。

## 契約（2026-10-26 自 AGENTS.md 遷入）

### 2. 文檔格式接口（PDF / Markdown）

- 現階段導入、解析、閱讀正式支持 PDF。列表僅按 `originalName` 顯示 `.md`／`.markdown` 為 Markdown，其餘舊記錄兼容顯示 PDF。
- 正式接入 Markdown 時，在 IPC、Core RPC、資料庫及 migration 加入 `sourceFormat: 'pdf' | 'markdown'` 並回填舊資料，不得長期依賴副檔名推斷。
- Markdown 導入接受 UTF-8 `.md`／`.markdown`（`text/markdown`），經 PathPolicy 原子落盤及摘要校驗，不走 PDF 上傳／解析器；在標準化邊界產生 canonical Markdown artifact。
- 保持 PDF／舊資料可讀，維護重複判定、狀態投影、刪除／重試、artifact revision 及恢復測試。

### 4. 文檔庫維護契約

- 維護經 Main 原生選目錄與確認、IPC 維護鎖、Utility 持久化隊列；活動任務期間不可切庫。
- manifest v1、schema_migrations 與 SQLite 結構共同約束兼容。恢復先校驗並保留舊庫；遷移複製完成後才事務切換路徑，不自動刪除舊文檔目錄。
- API Key 不進備份。實現、恢復語義與回歸項見 `docs/LIBRARY_MANAGEMENT_ZH.md`。

### 13. 文庫頁與 AI 解讀

文庫資訊、互動、動畫與渲染契約統一見 [介面規範](docs/UI_PREFERENCES_ZH.md#文庫頁與-ai-解讀)。生成、存儲、兼容與恢復仍以各專項文檔為準；修改時先讀相關契約，不在本入口重複參數與歷史驗收紀錄。

### 首頁背景（原 AGENTS §12）

- 首頁背景使用 `homeCipher.ts`／`homeWave.ts`；已選定方案與文庫渲染契約見 [介面規範](docs/UI_PREFERENCES_ZH.md)。舊原型與候選方案由 Git 歷史保留。
