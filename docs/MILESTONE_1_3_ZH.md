# 當前交接與未決事項

1.3.0 已發布： [PR #14](https://github.com/Kumiko-kmk/Copilotix/pull/14)、tag `desktop-v1.3.0`。功能模組化已落地；發布內容見 [版本說明](releases/1.3.0.zh-CN.md)，不以發布代表下列事項完成。

- **封面門檻回歸待修**：`archiveCover.ts` 只保留 complete 圖組，令「全是 ambiguous／unsupported 且無已保存整圖」降為單頁並可開檔，違反使用者要求。必須保持完整圖組與 CPU 合成／GPU 上傳全部就緒才開檔，否則留在瀏覽姿態；修復須處理已錯存的單頁快取失效並加回拒絕開檔回歸。不要把放寬門檻當作 CI 修復。
- CI 輕量調度目前為本地未提交修改，尚未在新 PR 遠端驗證；保留現有工作流與選擇器變更。契約及本地驗證範圍見 [發布流程](DESKTOP_RELEASE_ZH.md#ci-调度与验收证据)。
- 性能預算尚未進入自動門禁：首屏 ≤1.5s、編輯可見回應 ≤100ms、捲動長任務 ≤50ms；真實 GPU、真實服務完整旅程和文庫走查仍需獨立驗收。
- 待處理：全形標點旁粗體及圖說亂碼、Zotero 導入進度卡、PDF 引用注釋層；重翻譯／拖曳排序保留真人驗收界線。
- 1.3.1 架構（[document](../desktop/src/features/document/README.md)、[platform/models](../desktop/src/platform/models/README.md)、單篇文庫事件、移除 Bing／TranSmart）未提交：本地 typecheck／lint／deps／單測全量（單次 891 通過）／build 已過，E2E 除下條 minimap 外通過；真實 Codex CLI／登入、付費服務與真實論文旅程未驗收。
- 本機 minimap 跳轉後標題 15.45 px（期望 16±0.5）自 M1 起穩定重現，舊閱讀模型路徑同樣偏移，遠端 CI 曾通過；屬獨立定位修復，不放寬斷言。
- 大檔例外歸各模組 README；chat 的 rag-content-index 仍在使用，不可當死代碼刪除，亦不可合入舊 demo schema 5–7。

本地只保留 master 和最新 release/setup.exe；隱藏清理備份位於 .git/cleanup-safety，不屬可刪構建物。後續待辦直接更新本文件，不另建審計／流水交接。
