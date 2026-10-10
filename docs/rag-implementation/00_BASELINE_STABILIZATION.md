# 00 — 基線維護（已完成）

原 `taskService.test.ts` 的斷點恢復失敗未能持續復現，未猜測性修改產品。01–03 已在此基礎上完成；不將當時的瞬態失敗當成目前阻塞。

若再次出現 `succeeded`／`partial` 差異，沿 `SettingsService` 憑據驗證 → provider order → `TranslationPlanOrchestrator` → Utility finalize 核對；保存 provider 選擇、unit mutation 與 finalize counts，不記密鑰或正文。

回歸須同時證明：恢復 checkpoint 不重傳 PDF，只建一個依賴翻譯作業、只發布一份翻譯產物；所有 provider 失敗仍返回 `partial`。入口為 `taskService.test.ts`、`translationPlanOrchestrator.test.ts`。最新整體验证入口見 [AGENTS.md](../../AGENTS.md)。
