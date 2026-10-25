# ADR-0001：按功能劃分模組，進程層作為模組內的子目錄

- 狀態：已接受（2026-10-25）
- 範圍：`desktop/src`

## 背景

代碼目前按 Electron 進程層分目錄（`main`、`renderer`、`utility`、`shared`、`core`）。進程層邊界已由 ESLint 守住，但功能之間沒有邊界：一個功能散在四個層，`shared/` 成為雜物間，`main/index.ts` 集中所有 IPC。結果是改一個功能要碰很多檔案，多個 agent 並行時頻繁衝突，也無法只測某個功能。

## 決策

改為「**功能優先、進程層其次**」：

```
src/
  app/            組裝根：main、preload、renderer 殼、utility 入口；只組裝，不含業務
  platform/       跨功能基礎設施：IPC 註冊表、原子檔案與 PathPolicy、日誌、
                  Utility RPC、Codex runtime、憑據庫、網路代理
  features/
    library/      導入、文獻列表與投影、分類、文庫 3D 頁、文庫維護
    parsing/      解析客戶端與作業、文字層修復、圖片產物
    translation/  翻譯計劃協定、服務商與回退策略、編排、作業
    reader/       閱讀文件與塊映射、編輯層、標註與筆記、引用、圖片顯示、
                  工作台佈局、滾動同步、PDF 與 Markdown 視圖
    chat/         論文問答、存儲、圖片加入問答、檢索索引
    insight/      檔案卡（paper brief）、圖片解讀
    zotero/       Zotero 導入與導出
    settings/     設定服務、顯示設定、服務連接
```

每個功能內部按需要分 `main/`、`renderer/`、`utility/`、`contract/`：

- `contract/`：zod schema 與型別、IPC 頻道與 Core RPC 定義；純資料、無 node／electron，可被其他功能引用。
- `core/`：Main、Utility、Renderer 都可用的純邏輯（原 `src/core`、`src/shared` 中的演算法），同樣無 node／electron。
- `runtime/`：Main 與 Utility 共用、可用 Node 但不碰 Electron 的代碼（原 `src/runtime`）。
- `index.ts`（每個進程層一個）：該功能對外的唯一入口。

`app/` 按同樣的層名分 `main/`、`preload/`、`renderer/`、`utility/`、`contract/`；`platform/` 按關注點分目錄（`platform/ipc/`、`platform/rpc/`…），關注點內再按層分子目錄，使進程層規則只看路徑即可判定。

## 模組地圖（2026-10-25，M1）

現有檔案的歸屬，遷移時按此表；標「拆」的大檔拆分後再歸屬。表外的新檔按用途放入對應模組。

| 目標 | 現有來源 |
|---|---|
| `app/main` | `main/index.ts`（拆為啟動、視窗、托盤、生命週期、packaged smoke）、`singleInstance` |
| `app/preload` | `preload/index.ts`（改由各功能契約組合） |
| `app/renderer` | `renderer/main.tsx`、`App.tsx`、`styles.css`、`EdgeDock`、`WindowControls` |
| `app/utility` | `utility/index.ts`、`uninstallCleanupEntry.ts`、`utilityOperations.ts`（拆：只留組合，handler 歸各功能） |
| `app/contract` | `shared/types.ts` 的 `CopilotixDesktopApi`、`coreRpcSchemas.ts` 的操作註冊表、`packagedSmoke` |
| `platform/ipc` | `main/ipc.ts`、`shared/ipc.ts`、`preload/ipcClient.ts`、`ipcSchemas.ts` 的信封與空請求 schema |
| `platform/rpc` | `core/coreClient.ts`、`coreRpcSchemas.ts` 的協定部分、`utilitySupervisor`、`electronUtilityFork`、`utilityEntryPath`、`utility/coreUtilityRuntime` |
| `platform/jobs` | `core/jobs.ts`、`core/types.ts` 的作業型別、`jobScheduler`、`progressReporter`、`rpcJobRepository`、`coalescedRefresh`、`sqliteJobRepository` |
| `platform/database` | `v2Database.ts`（schema 與 migration，含保留的 rag_* 表） |
| `platform/files` | `runtime/pathPolicy.ts`、`core/ports.ts` 的 `PathPolicyPort` |
| `platform/{log,network,assets,credentials,uninstall}` | `logger`、`networkProxy`、`assetProtocol`、`credentialVault`、main／utility 的 `uninstallCleanup` |
| `platform/codex` | `runtime/codexRuntime.ts`、`codexConnection.ts`、`shared/codex.ts`、`chatMessages.ts` |
| `platform/markdown` | `standardMarkdown`、`mathDelimiters`、`rehypeTableMath` |
| `platform/pdf` | `renderer/pdfDocumentCache.ts` |
| `features/library` | `taskService`、`documentCommandService`、`documentProjection`、`documentSummary`、`rpcTaskRepository`、`rpcTaskCompute`、`taskRepositoryCompat`（main／utility）、`v2TaskRepositoryCompat`（拆）、`libraryAccessGate`、`libraryMaintenance`、`libraryCategories`（三處）、`librarySchemas`、`pdfImport`、`pdfPageRemoval`、`pdfInspection`、`titleNaming`、`paperProfile`、`tutorialSample`（三處）、`storageService`、`ipcSchemas.ts` 的文獻／任務 schema；renderer `LibraryPage`、`NewParsePage`、`TutorialPage`、`paperArchive/*`（`PaperArchiveScene` 拆）、`documentCache`、`documentStatus`、`readerPageLoader`、首頁元件與 `homeCipher`／`homeWave`、`ImportProgress`、`WorkflowSteps`、`DocumentLifecycleActions` |
| `features/parsing` | `parserClient`、`fileUploader`、`parseJobRunner`、`core/blockMapping`、`markdownBlocks`（依賴塊映射型別）、`textLayerRepair`、`pdfTextLayer`、`useTextLayerRepair`、`figureArtifacts`、`figureArtifactStore`、`types.ts` 的塊映射型別 |
| `features/translation` | `main/translation/*`、`translationJobRunner`、`translationPlanProtocol`、`providerPolicy`、`markdownTranslationPlan`（拆）、`tableTranslation`、`core/ports.ts` 的 `TaskComputePort` |
| `features/reader` | `readerDocument`、`markdownEdits`、`runtime/markdownEditsFile`、`markdownEditStore`、`readerAnnotations`（shared／renderer）、`annotationMutations`、`readerNotes`、`readerNoteStore`、`useReaderNotes`、`figureDisplay`、`figureDisplayStore`、`readerFigureDisplay`、`readerFigureGroups`、`readerFigureLayout`、`readerFigureMosaic`、`paperSelectionText`、`artifactService`、`readerLayout`、`readerScrollSync`、`readerCitations`、`readerReferenceSections`、`readerPerformance`、`pdfRenderScheduler`、`useFigureArtifacts`、`ReaderPage`、`MarkdownPane`（拆）、`PdfPane`（拆）、`ReaderWorkbench`（拆）、`ReaderViews`、`MarkdownMinimap`（拆）、`SafeMarkdown`、`Reader*` 元件、`BlockContextMenu` |
| `features/chat` | `main/chat/{chatProvider,modelGateway,paperChatService,paperChatIpc}`、`paperChatSchemas`、`paperChatStorageSchemas`、`paperChatFigures`、`chatResultMetadata`、`figureMentions`、`ragSchemas`、`paperChatStore`、`paperChatFigureStore`、`paperContextBuilder`、問答索引（`ragContentIndexService`、`structureAwareChunker`、`sqliteRagRepository`、`ragContentIndexJobRunner`、`rpcRagContentIndexer`）、`ReaderChatPanel`、`usePaperChat*`、`paperChat.css` |
| `features/insight` | `main/chat/{paperInsight*,figureInsight*}`、`paperInsight`、`paperBrief/*`、`figureInsight`、`figureInsightPrompt`、`paperInsightStore`、`figureInsightStore`、`usePaperInsight`、`PaperInsightActions` |
| `features/zotero` | `main/zotero/*`、`shared/zotero.ts`、`ZoteroImportDialog`、`ZoteroExportButton`、`zoteroImport.css` |
| `features/settings` | `settingsService`、`usageAnalyticsService`（含其 schema；依賴任務與服務商型別，故不入平台）、`constants.ts` 的預設設定、`ipcSchemas.ts`／`types.ts` 的設定與憑據型別、`SettingsPage`（拆）、`ThemeSettings`、`CodexSettingsCard`、`ServiceCard`、`PageBrand`、`theme.ts`、`settingsNavigation`、`storageInfoClient`、`codexStatusClient` |

問答檢索索引（`rag-content-index` 作業、`sqliteRagRepository`）經 `chat:ensure-index` → 作業 → `paperContextBuilder` 仍是問答上下文的來源，歸入 chat；作業類型名、Core RPC 名與 rag_* 表保持原名。

## 依賴規則（以 dependency-cruiser 強制：`pnpm desktop:deps`，配置 `desktop/.dependency-cruiser.cjs`）

1. 功能 A 只能引用功能 B 的 `contract/` 或 B 某一層的 `index.ts`（`core`、`runtime`、`main`、`renderer`、`utility`），不得引用 B 的內部檔案。
2. `platform/` 不得引用任何 `features/`。
3. `app/` 可引用一切，但不含業務邏輯。
4. 既有進程層規則不變：renderer 不碰 main、electron、node；contract／shared 不碰 node、electron；main 不碰 renderer。dependency-cruiser 按路徑補上相對 import：core 同 contract；preload 只碰契約；main 不碰 utility；runtime、utility 不碰 electron 與其他進程層。
5. 禁止循環依賴。

## 後果

- 好處：每個功能的改動集中在一個目錄；可按模組跑測試；並行開發衝突大幅減少；新人或 agent 讀一個模組 README 即可上手。
- 代價：一次性大規模搬檔，期間不宜並行開發功能；路徑別名與測試匯入需同步更新；git blame 需用 `--follow`。
- 風險控制：只搬代碼、不改行為；按模組逐個遷移，每步全量測試；規則先 warn 再 error。

## 重新評估時機

若某功能長期需要繞過規則（例如頻繁引用另一功能內部），應重新劃分該功能邊界，而不是放寬規則。
