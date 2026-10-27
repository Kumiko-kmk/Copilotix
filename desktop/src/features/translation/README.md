# translation

Markdown 翻譯：可恢復的翻譯計劃（Utility）、服務商與回退策略（Main）、翻譯作業與閱讀器「重新翻譯」。格式、計劃版本與兼容見 [Markdown 格式](../../../../docs/MARKDOWN_FORMAT_ZH.md)、下方「契約」。

## 公開 API

- `contract/translationPlanProtocol.ts`：計劃描述、請求／回應 envelope、表格翻譯協定與版本常量（`TRANSLATION_PIPELINE_VERSION` 等）；`providerPolicy.ts`：服務商順序與啟用規則；`translationSchemas.ts`／`translationTypes.ts`：服務商 ID 與譯文塊的 schema、型別；`translationBatch.ts`：Utility 寫入的批次提交型別。
- `contract/ipc.ts`：`documents:retranslate-edited`；`contract/rpc.ts`：`translationOperations`（`compute:translation-plan-*`）。
- `main/index.ts`：`TranslationJobRunner`（`translate` 作業）、`probeOpenAiCompatibleCredential`（設定頁連接測試）、`registerTranslationIpc`。
- `utility/index.ts`：`MarkdownTranslationPlanManager`、`createTranslationOperations`。

## 資料（文獻目錄）

`full.zh-CN.md`、`translation.manifest.json`（計劃 v6，兼容 v4／v5）、`.translation/<jobId>/` 計劃與單元回應；翻譯快取與塊記錄在 SQLite。

## 並發與恢復

文檔翻譯調度上限為 4；單篇仍保留 64 個在途計劃單元，Qwen／DeepSeek 各共用最多 16 個 HTTP 請求，免費源各 1 個。Qwen MT 表格最多 4 個單元格並行，與普通文字共用同一 HTTP 預算，保持原單元格順序與表格校驗；任一請求失敗後停止發送該表新請求，等待已發送請求結束再回退。429 共用冷卻及既有有限重試不變。Codex 繼續由 runtime 的 8 槽自適應預算控制。

finalize 成功寫入並校驗產物後釋放該計劃的全文／表格 AST 記憶體，重試仍從原有磁碟計劃與 SQLite 塊記錄恢復，保留已完成塊；無 IPC、schema、快取鍵或產物格式變更。已執行翻譯計劃恢復及跨文檔共享併發上限回歸；恢復入口為 `markdownTranslationPlan`、`translationPlanOrchestrator`、`translationProviders` 用例。

## 測試

`tests/features/translation/`（`pnpm desktop:test --module translation`）；跨模組的作業憑據門禁在 `tests/app/credentialGate.test.ts`。

## 例外

`utility/markdownTranslationPlan.ts`（975 行）超過 600 行：它是單一的可恢復狀態機（計劃、單元、元資料與原子提交共用同一份記憶體狀態與寫入序列），純函式與型別已拆至 `planModel.ts`；再拆需重新劃分狀態擁有權，屬行為風險，留待功能分支。

## 契約（2026-10-26 自 AGENTS.md 遷入）

### 11. 豐富閱讀與標準導出分離

- 解析、翻譯與閱讀保留 HTML／LaTeX 豐富結構，不展平合併表格。`prepareReaderMarkdown` 僅非結構性準備／圖片路徑修正；`normalizeMarkdown` 僅導出投影，不回寫源資料。
- 新翻譯計劃 v6，兼容合法 v4/v5/v6 manifest；v5 平面表格不可自動恢復，不自動重解析／重翻譯。映射、標註、資源及原子發布契約不變，詳見上述格式文檔。
