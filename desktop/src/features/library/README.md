# library

文獻庫：導入（拖放、選檔、教程論文）、文獻與任務列表及其投影、首頁、文庫 3D 檔案頁、內容分類，以及文庫備份／恢復／遷移。介面契約見 [介面規範](../../../../docs/UI_PREFERENCES_ZH.md#文庫頁與-ai-解讀)，維護與恢復語義見 [文庫管理](../../../../docs/LIBRARY_MANAGEMENT_ZH.md)、[文庫分類](../../../../docs/LIBRARY_CATEGORIES_ZH.md)。

## 公開 API

- `contract/`：`ipc.ts`（`documents:*`、`library:*`、`tutorial:import-paper` 與 `documents:changed`／`documents:open` 事件，`createLibraryApi`）、`rpc.ts`（`libraryOperations`：`tasks:*`、`documents:*`、`artifacts:record-revision`、`compute:hash-file`、`compute:import-pdf`、`compute:library-categories`、`library:check|manage`；`CoreListCursor`）、`taskRepository.ts`（Main 側的 `TaskRepositoryCompat` 埠，設定與閱讀器也經它讀寫任務）、`taskCompute.ts`（`TaskComputePort`）、`documentSchemas.ts`／`documentTypes.ts`（文獻、導入與舊任務投影的 schema 與型別）、`artifacts.ts`（`DocumentId`、`ArtifactKind`）、`pdfLimits.ts`、`librarySchemas`、`libraryCategories`、`pdfImport`、`tutorialSample`。
- `core/index.ts`：`extractPaperProfile`、`displayPaperTitle` 等標題與論文資訊提取（Zotero 與文庫頁共用）。
- `main/index.ts`：`TaskService`（文獻指令的入口：導入、重試、刪除、導出、閱讀文件）、`RpcTaskRepository`、`RpcTaskCompute`、`DocumentFeed`、`LibraryAccessGate`、`registerLibraryIpc`、`registerTaskNotifications`。
- `utility/index.ts`：`V2TaskRepositoryCompat`（SQLite 文獻倉庫）、`createLibraryOperations`、`assertLibraryIdle`／`manageLibrary`。
- `renderer/index.ts`：`NewParsePage`（首頁與導入）、`TutorialPage`、文獻列表快取與狀態工具；`LibraryPage` 由組裝層懶載入（`App.tsx`），不經 index，以保留 Three.js 分包。

## 資料

- SQLite：`documents`、`jobs`、`artifact_revisions` 等（schema 與 migration 在 `platform/database`）。
- 文獻目錄 `documents-v2/<documentId>/`：`original.pdf` 與各模組的產物子目錄；備份 manifest v1 見文庫管理文檔。

## 測試

`tests/features/library/`（`pnpm desktop:test --module library`）；E2E `e2e/library.spec.ts`、`paper-archive.spec.ts`、`archive-layout.spec.ts`、`qa-fixes.spec.ts`。

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
