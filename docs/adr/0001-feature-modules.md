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
- `index.ts`（每個進程層一個）：該功能對外的唯一入口。

## 依賴規則（以 dependency-cruiser 強制）

1. 功能 A 只能引用功能 B 的 `contract/` 或 B 對應進程層的 `index.ts`，不得引用 B 的內部檔案。
2. `platform/` 不得引用任何 `features/`。
3. `app/` 可引用一切，但不含業務邏輯。
4. 既有進程層規則不變：renderer 不碰 main、electron、node；contract／shared 不碰 node、electron；main 不碰 renderer。
5. 禁止循環依賴。

## 後果

- 好處：每個功能的改動集中在一個目錄；可按模組跑測試；並行開發衝突大幅減少；新人或 agent 讀一個模組 README 即可上手。
- 代價：一次性大規模搬檔，期間不宜並行開發功能；路徑別名與測試匯入需同步更新；git blame 需用 `--follow`。
- 風險控制：只搬代碼、不改行為；按模組逐個遷移，每步全量測試；規則先 warn 再 error。

## 重新評估時機

若某功能長期需要繞過規則（例如頻繁引用另一功能內部），應重新劃分該功能邊界，而不是放寬規則。
