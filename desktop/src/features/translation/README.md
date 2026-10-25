# translation

Markdown 翻譯：可恢復的翻譯計劃（Utility）、服務商與回退策略（Main）、翻譯作業與閱讀器「重新翻譯」。格式、計劃版本與兼容見 [Markdown 格式](../../../../docs/MARKDOWN_FORMAT_ZH.md)、[AGENTS.md §11](../../../../AGENTS.md)。

## 公開 API

- `contract/translationPlanProtocol.ts`：計劃描述、請求／回應 envelope、表格翻譯協定與版本常量（`TRANSLATION_PIPELINE_VERSION` 等）；`providerPolicy.ts`：服務商順序與啟用規則。
- `contract/ipc.ts`：`documents:retranslate-edited`；`contract/rpc.ts`：`translationOperations`（`compute:translation-plan-*`）。
- `main/index.ts`：`TranslationJobRunner`（`translate` 作業）、`probeOpenAiCompatibleCredential`（設定頁連接測試）、`registerTranslationIpc`。
- `utility/index.ts`：`MarkdownTranslationPlanManager`、`createTranslationOperations`。

## 資料（文獻目錄）

`full.zh-CN.md`、`translation.manifest.json`（計劃 v6，兼容 v4／v5）、`.translation/<jobId>/` 計劃與單元回應；翻譯快取與塊記錄在 SQLite。

## 測試

`tests/features/translation/`（`pnpm desktop:test --module translation`）；跨模組的作業憑據門禁在 `tests/credentialGate.test.ts`。

## 例外

`utility/markdownTranslationPlan.ts`（975 行）超過 600 行：它是單一的可恢復狀態機（計劃、單元、元資料與原子提交共用同一份記憶體狀態與寫入序列），純函式與型別已拆至 `planModel.ts`；再拆需重新劃分狀態擁有權，屬行為風險，留待功能分支。
