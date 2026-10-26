# reader

閱讀器：四視圖工作台（PDF、原文、中文、問答）、Markdown 與 PDF 視圖、捲動同步、選區工具列（高亮、下劃線、筆記、加入問答）、正文引用、圖片分組與裁圖、閱讀器內編輯／刪除／排序，以及閱讀文件與導出。契約見 [AGENTS.md §7、§10](../../../../AGENTS.md)、[Markdown 格式](../../../../docs/MARKDOWN_FORMAT_ZH.md)、[介面偏好](../../../../docs/UI_PREFERENCES_ZH.md)。

## 公開 API

- `contract/`：`ipc.ts`（`reader-figure-display:*`、`reader-notes:*`、`reader-annotations:*`、`documents:edit-markdown`、`documents:cache-figure`，`createReaderApi`）、`rpc.ts`（`readerOperations`：`notes:*`、`markdown-edits:apply`、`annotations:*`）、`markdownEdits`（編輯層 schema 與解析）、`readerNotes`、`figureDisplay`、`readerSchemas`／`readerTypes`（標註、圖片快取的 schema 與型別）。
- `core/index.ts`：`readerContentMappings`、`buildReaderFigureGeometries`、`paperSelectionText`、標註重定位；翻譯、問答與文庫用它們讀取閱讀內容與圖片幾何。
- `runtime/index.ts`：`readMarkdownEditsFile`（翻譯計劃讀取編輯層）。
- `main/index.ts`：`ArtifactService`（閱讀文件、Markdown／ZIP 導出、裁圖）、`FigureDisplayStore`、`registerReaderIpc`。
- `utility/index.ts`：`createReaderOperations`、`MarkdownEditStore`（問答上下文也讀編輯層）、`ReaderNoteStore`。
- `renderer/index.ts`：`loadReaderPage`／`loadedReaderPage`（`ReaderPage` 只經此懶載入，保留分包）、`loadFigureArtifacts`（同理）、`SafeMarkdown`、`ReaderAnnotationToolbar`、`useReaderNoteLayer`、選區與標註工具。

## 資料（文獻目錄，均無 migration）

- `edits/markdown-edits.v1.json`：使用者編輯層（含可選 `order`）；解析、修復與翻譯不得改寫。
- `notes/notes.v1.json`、`reader/figure-display.v1.json`、`figures.json` 與裁圖 PNG。
- 標註在 SQLite（經 library 的倉庫）；localStorage `copilotix.reader.layout.v1`（工作台佈局）。

## 測試

`tests/features/reader/`（`pnpm desktop:test --module reader`）；E2E `e2e/reader.spec.ts`、`reader-figures.spec.ts`、`qa-fixes.spec.ts`。

## 例外（超過 600 行）

`renderer/components/MarkdownPane.tsx`（701 行）：一個視圖元件，漸進掛載、圖片就緒、捲動同步、選區與編輯共用約二十個 ref 與同一組 layout effect；塊視圖、圖片狀態、重排單元、狀態面板與 DOM 工具已拆至 `MarkdownBlockView.tsx`、`useMarkdownFigures.ts`、`MarkdownPaneParts.tsx`、`markdownPaneDom.ts`。再拆需改變 effect 次序，留待功能分支並配合真實文庫驗收。
