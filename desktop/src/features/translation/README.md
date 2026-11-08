# translation

Markdown 翻譯：可恢復的翻譯計劃（Utility）、服務商與回退策略（Main）、翻譯作業與閱讀器「重新翻譯」。格式、計劃版本與兼容見 [Markdown 格式](../../../../docs/MARKDOWN_FORMAT_ZH.md)。

## 公開 API

- `contract/translationPlanProtocol.ts`：計劃描述、請求／回應 envelope、表格翻譯協定與版本常量（`TRANSLATION_PIPELINE_VERSION` 等）；`providerPolicy.ts`：服務商順序與啟用規則；`translationSchemas.ts`／`translationTypes.ts`：服務商 ID 與譯文塊的 schema、型別；`translationBatch.ts`：Utility 寫入的批次提交型別。
- `contract/ipc.ts`：`documents:retranslate-edited`；`contract/rpc.ts`：`translationOperations`（`compute:translation-plan-*`）。
- `main/index.ts`：`TranslationJobRunner`（`translate` 作業）、`probeOpenAiCompatibleCredential`（設定頁連接測試）、`registerTranslationIpc`。
- `utility/index.ts`：`MarkdownTranslationPlanManager`、`createTranslationOperations`。

## 資料（文獻目錄）

`full.zh-CN.md`、`translation.manifest.json`（計劃 v6，兼容 v4／v5）、`.translation/<jobId>/` 計劃與單元回應；翻譯快取與塊記錄在 SQLite。

## 並發與恢復

文檔調度上限 4、每篇 64 個在途計劃單元不變。傳輸與健康狀態由 [platform/models](../../platform/models/README.md) 共用：Qwen／DeepSeek 每額度組 15 背景＋1 互動；Codex 8 背景＋1 互動。Qwen MT 表格最多 4 個單元格共用背景預算。相同候選只發送一次，所有候選不可用立即結束本輪，保留已完成結果與 pending 檢查點；部分輸出不回退。輸入校驗失敗仍由功能處理。

Codex 把同一作業的多個段落合為一次請求（≤16 段、8000 字），協定 `copilotix-translation-segments-v2`：每項須回 `source`（該段開頭數詞）。`segmentsAligned` 逐段核對回顯是否為本段開頭，並拒絕不含本段數字／縮寫卻含相鄰段兩個以上的譯文；任一段不符則整批作廢、逐段單獨重發，單段仍不符即失敗且不寫快取。v1 未做此核對，曾出現整批錯位一段（標題標記按位置重套，正文顯示成標題）；Codex 快取鍵帶 `CODEX_SEGMENT_ALIGNMENT_VERSION`，舊 Codex 快取不再命中，Qwen／DeepSeek 快取不變。已錯位的既有譯文不自動改寫，需對受影響段落「重新翻譯此段」（加鹽快取，略過沿用）。

finalize 成功寫入並校驗產物後釋放該計劃的全文／表格 AST 記憶體，重試仍從原有磁碟計劃與 SQLite 塊記錄恢復，保留已完成塊；manifest 額外記錄 sourceVersion；歷史 v4/v5/v6 仍由 document 相容層讀取。恢復入口為 `markdownTranslationPlan`、`translationPlanOrchestrator`、`translationProviders` 用例；錯位回歸在 `codexTranslationProvider` 用例。

## 測試

`tests/features/translation/`（`pnpm desktop:test --module translation`）；跨模組的作業憑據門禁在 `tests/app/credentialGate.test.ts`。

## 例外

`utility/markdownTranslationPlan.ts`（975 行）超過 600 行：它是單一的可恢復狀態機（計劃、單元、元資料與原子提交共用同一份記憶體狀態與寫入序列），純函式與型別已拆至 `planModel.ts`；再拆需重新劃分狀態擁有權，屬行為風險，留待功能分支。

僅 Qwen、DeepSeek、Codex 可執行；Bing／TranSmart 的 ID 僅供歷史譯文、快取及統計。舊任務再次執行依當前啟用列表選擇，不恢復已移除來源。翻譯計劃使用 document 基礎塊，寫入前核對來源與編輯版本。
