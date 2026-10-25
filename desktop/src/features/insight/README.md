# insight

AI 檔案卡（paper brief，文庫詳情頁）與圖片解讀（閱讀器圖組）。生成、存儲、授權與恢復語義見 [AI 檔案卡](../../../../docs/PAPER_INSIGHT_ZH.md)、[檔案卡格式](../../../../docs/PAPER_BRIEF_ZH.md)、[圖片解讀](../../../../docs/FIGURE_INSIGHT_ZH.md)。

## 公開 API

- `contract/paperInsight.ts`、`contract/figureInsight.ts`：請求、狀態與事件 schema。
- `contract/ipc.ts`：`paperInsightChannels`、`figureInsightChannels` 與 preload 工廠；`contract/rpc.ts`：`insightOperations`（`insight:*`、`figureInsight:*`、`compute:figure-insight-descriptor`）。
- `core/index.ts`：渲染檔案卡所需的 `PaperBrief`、`BriefAnchor`、`CONTRIBUTION_KIND_LABELS`、`backgroundPoints`。`core/paperBrief/` 是檔案卡的 schema、上下文、提示詞、字數與 grounding，`core/figureInsightPrompt.ts` 是圖片解讀提示詞。
- `main/index.ts`：`PaperInsightService`、`FigureInsightService`、`loadFullBriefContext`、IPC 註冊函式。模型經問答模組的 `ModelGateway` 由組裝層注入。
- `utility/index.ts`：`createInsightOperations`（Utility handler）、`PaperInsightStore`、`FigureInsightStore`（文庫分類與問答圖片取用）。
- `renderer/index.ts`：`usePaperInsight`、`PaperInsightActions`。

## 資料檔（文獻目錄，無 migration）

- `insight/brief.v2.json`：檔案卡；舊 `insight/insight.v1.json` 只讀兼容。
- `insight/figures/<hash>.v1.json`：每張圖的解讀。

## 測試

`tests/features/insight/`（`pnpm desktop:test --module insight`）；E2E `e2e/paper-insight.spec.ts`、`archive-math.spec.ts`。
