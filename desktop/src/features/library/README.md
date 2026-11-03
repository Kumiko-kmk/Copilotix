# library

文獻庫：導入（拖放、選檔、教程論文）、文獻與任務列表及其投影、首頁、文庫 3D 檔案頁、內容分類，以及文庫備份／恢復／遷移。介面契約見 [介面規範](../../../../docs/UI_PREFERENCES_ZH.md#文庫頁與-ai-解讀)，維護與恢復語義見 [文庫管理](../../../../docs/LIBRARY_MANAGEMENT_ZH.md)、[文庫分類](../../../../docs/LIBRARY_CATEGORIES_ZH.md)。

## 公開 API

- `contract/`：`ipc.ts`（`documents:*`、`library:*`、`tutorial:import-paper` 與 `documents:changed`／`documents:open` 事件，`createLibraryApi`）、`rpc.ts`（`libraryOperations`：`tasks:*`、`documents:*`、`artifacts:record-revision`、`compute:hash-file`、`compute:import-pdf`、`compute:library-categories`、`library:check|manage`；`CoreListCursor`）、`taskRepository.ts`（Main 側的 `TaskRepositoryCompat` 埠，設定與閱讀器也經它讀寫任務）、`taskCompute.ts`（`TaskComputePort`）、`documentSchemas.ts`／`documentTypes.ts`（文獻、導入與舊任務投影的 schema 與型別）、`artifacts.ts`（`DocumentId`、`ArtifactKind`）、`pdfLimits.ts`、`librarySchemas`、`libraryCategories`、`pdfImport`、`tutorialSample`。
- `core/index.ts`：`extractPaperProfile`、`displayPaperTitle` 等標題與論文資訊提取（Zotero 與文庫頁共用）。
- `main/index.ts`：`TaskService`（文獻指令的入口：導入、重試、刪除、導出、閱讀文件）、`RpcTaskRepository`、`RpcTaskCompute`、`DocumentFeed`、`LibraryAccessGate`、`registerLibraryIpc`、`registerTaskNotifications`。
- `utility/index.ts`：`V2TaskRepositoryCompat`（SQLite 文獻倉庫）、`createLibraryOperations`、`assertLibraryIdle`／`manageLibrary`。
- `renderer/index.ts`：`NewParsePage`（導入頁，未傳 `decoration` 時只有標題與導入入口，供 Lite 使用）、`DecoratedHomePage`（完整版首頁，加上字陣、字標與問候；裝飾只經此引入，Lite 才不打包）、`PaperSidebar`（Lite 的論文列表）、`TutorialPage`、文獻列表快取與狀態工具；`LibraryPage` 由組裝層懶載入（`App.tsx`），不經 index，以保留 Three.js 分包。

文庫進入時經 insight 的只讀批量 catalog 取得全庫的小型檔案狀態、譯名、關鍵詞與總結，每頁 200 篇；依文檔與來源版本隔離，移除文檔時釋放快取。進入權限只依已保存且當前有效的檔案與已完成工作流，滑鼠任意跨列點選、搜尋、拖動、滾輪、鍵盤共用同一份狀態，不依選中次序、相鄰預讀、圖片或封面是否已渲染。全庫已成熟論文另由 ArchiveCoverService 提前準備完整跨頁封面，不依賴相鄰位置；背景僅一個重任務，當前選擇優先、明確開檔可搶佔無關背景工作。已完成封面以 WebP 存入獨立 IndexedDB，完整卡片查詢仍最多 32 項、閒置 120 秒回收。

生成中的替代版本或其失敗不遮蔽已保存的可讀檔案；事件後只讀重查該文檔，更新譯名與實際可讀狀態，事件及版本標記阻止晚到結果覆蓋。暫時 RPC 錯誤最多三次嘗試，不增加持續輪詢；取消／卸載終止等待且忽略遲到結果。顯示頁主標題沿用文庫中的命名，全文資訊提取與封面重建只隨內容改變，不因進度／摘要時間戳更新重播。原文獻持久化格式不變；封面使用可重建的獨立 renderer 快取。

返回文庫時立即重查先前 missing／stale／failed 的狀態，避免閱讀器中完成生成、文庫未掛載而漏收事件後，被 30 秒快取保留為不可進入；已成熟快取仍保留原就緒畫面。回歸包含卸載期間生成再返回，端到端包含真實 provider mock／持久化與重開，不改資料格式或自動重發生成請求。

完整跨頁封面在開檔動畫前完成 CPU 合成及 GPU 上傳；原有升起、鏡頭、玻璃曲線不等待外部工作。ArchiveDetail 只管理文字，不再清除／重建封面。尚未準備的冷檔先維持原瀏覽姿態，完整後才開始動畫；30 秒截止、失敗保留瀏覽，可重試，Esc／換篇／卸載取消並拒收晚到畫面，不能開到一半再補單頁或雙頁。封面按文檔版本、來源雜湊、整圖清單與已存評分指紋隔離；整圖已有可讀 PNG 時不重掃 PDF，缺圖不能誤存成合法單頁。

封面門檻計入全部圖組提示，不論 complete、ambiguous 或 unsupported：只要論文有任何圖組提示而沒有已保存整圖清單，就不生成單頁，保持瀏覽姿態；裁圖只輸出 complete 圖組，因此全是 ambiguous／unsupported 的論文不會開檔。只有完全沒有圖組提示（或 Markdown 來源）才使用合法單頁。1.3.0 曾以 complete 過濾把這類論文存成可開啟單頁；持久封面記錄帶 `rule`（`ARCHIVE_COVER_RULE`，現為 2），讀到舊規則下的 single 時視為未命中並刪除，重新判定，spread 不受影響、不需重建，資料庫版本不變。回歸：`archiveCover.test.ts`（拒絕開檔、無提示仍單頁）、`archiveCoverStore.test.ts`（舊單頁失效、spread 保留）、E2E `paper-archive.spec.ts`「never cropped」（未裁圖論文提示失敗並留在瀏覽）；需要開檔的文庫 E2E 以 `seedReaderTask({ savedCoverFigure: true })` 種入已保存整圖，走真實跨頁路徑。

首頁快取 copilotix-archive-pages 按 PDF 內容 hash 保存最多160頁 WebP，失敗回退重繪。解碼後完整畫面以 48MiB LRU 限額保存，正在場景使用的畫面 pin 至紋理釋放；持久封面在獨立 `copilotix-archive-spreads` v1 庫，最多 128MiB／160 項，無需升級既有首頁庫。合成後清除首頁／圖頁 scratch canvas，位圖 decode 後釋放；IndexedDB／壓縮錯誤不阻止已準備畫面使用。只讀 `figureInsight.coverSource` 返回輕量指紋／幾何／權重，不讀全文、不觸發模型。文字進度事件不重傳紋理。

## 資料

- SQLite：`documents`、`jobs`、`artifact_revisions` 等（schema 與 migration 在 `platform/database`）。
- 文獻目錄 `documents-v2/<documentId>/`：`original.pdf` 與各模組的產物子目錄；備份 manifest v1 見文庫管理文檔。

## 測試

`tests/features/library/`（`pnpm desktop:test --module library`）；E2E `e2e/library.spec.ts`、`paper-archive.spec.ts`、`archive-layout.spec.ts`、`qa-fixes.spec.ts`。

## 例外（超過 600 行）

- `utility/v2TaskRepositoryCompat.ts`（超過600行）：一個持有預備語句與事務的 SQLite 倉庫類；行型別、限制與投影已拆至 `compatRecords.ts`。按表拆類需重新劃分事務邊界，留待功能分支。
- `renderer/archive/PaperArchiveScene.ts`（超過600行）：Three.js 場景類，渲染迴圈、材質池、相機與詳情動畫共用同一份可變狀態；常量、調色盤與型別已拆至 `archiveSceneConfig.ts`。

## 增量事件

DocumentFeed 的初始 documents:snapshot 與增量事件攜帶 sessionId／revision。Main 合併同文檔變化，只查受影響摘要；progress、metadata、body、translation、edit、delete 分類，正文與譯文版本取 artifact revision/hash，編輯版本取編輯 revision。Renderer 忽略重複，遇缺口／會話重啟重新同步並合併期間事件。單次最多 100 行及約 512 KiB。progress 不失效正文、標註或封面。啟動、恢復與遷移可全量讀取。封面版本使用 contentVersions；全庫預熱範圍、容量、跳轉與完整圖組門檻不變。
