# zotero

本機 Zotero 橋接：首頁「从 Zotero 导入」與閱讀器「导出到 Zotero」。契約與驗證細節見 [Zotero 橋接](../../../../docs/ZOTERO_BRIDGE_ZH.md)。

## 公開 API

- `contract/zotero.ts`：條目、分類、導入／導出請求與結果 schema，`ZoteroDesktopApi`。
- `contract/ipc.ts`：`zoteroChannels`（`zotero:catalog`、`zotero:items`、`zotero:import`、`zotero:export`）與 preload 工廠 `createZoteroApi`。
- `main/index.ts`：`createZoteroImportService`、`createZoteroExportService`、`registerZoteroHandlers`、`registerZoteroExportHandler`（由 `app/main/bootstrap.ts` 組裝）。
- `renderer/index.ts`：`ZoteroImportDialog`（首頁）、`ZoteroExportButton`（閱讀器頂欄）。

## 依賴

讀 Zotero 只用本機唯讀 API，失敗時讀 `zotero.sqlite` 唯讀副本；導入經文庫的 `importPaths` 按 PDF 雜湊去重；導出經本機連接器（埠來自 Zotero profile）。導出內容取自文庫任務、問答檔案卡、標註與筆記，均由組裝層以函式注入。

## 資料檔（文獻目錄，無 migration）

- `zotero/link.v1.json`：論文來自哪些 Zotero 條目。
- `zotero/export.v1.json`：每次導出的記錄（最新在後）。

## 測試

`tests/features/zotero/`（`pnpm desktop:test --module zotero`）。

## 契約（2026-10-26 自 AGENTS.md 遷入）

### 橋接摘要（原 AGENTS §12）

- Zotero 橋接（只在本機）：首頁「从 Zotero 导入」先讀本機只讀 API，失敗則讀 `zotero.sqlite` 唯讀副本；renderer 只傳條目 key，PDF 走既有 importPaths 按雜湊去重；條目關聯存文獻目錄 `zotero/link.v1.json`（無 migration）。閱讀器「导出到 Zotero」經本機連接器：Zotero 來源的論文建帶 `zotero://select` 連結的獨立筆記（連接器不能寫既有條目），其他論文建條目＋PDF＋子筆記，記錄存 `zotero/export.v1.json`。契約與驗證見 [Zotero 橋接](docs/ZOTERO_BRIDGE_ZH.md)。
