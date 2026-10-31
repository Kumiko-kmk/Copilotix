# 當前交接與未決事項

1.3.0 已發布： [PR #14](https://github.com/Kumiko-kmk/Copilotix/pull/14)、tag `desktop-v1.3.0`。功能模組化已落地；發布內容見 [版本說明](releases/1.3.0.zh-CN.md)，不以發布代表下列事項完成。

- CI 輕量調度目前為本地未提交修改，尚未在新 PR 遠端驗證；保留現有工作流與選擇器變更。契約及本地驗證範圍見 [發布流程](DESKTOP_RELEASE_ZH.md#ci-调度与验收证据)。
- 性能預算尚未進入自動門禁：首屏 ≤1.5s、編輯可見回應 ≤100ms、捲動長任務 ≤50ms；真實 GPU、真實服務完整旅程和文庫走查仍需獨立驗收。
- 待處理：全形標點旁粗體及圖說亂碼、Zotero 導入進度卡、PDF 引用注釋層；重翻譯／拖曳排序保留真人驗收界線。
- 1.3.1 架構（[document](../desktop/src/features/document/README.md)、[platform/models](../desktop/src/platform/models/README.md)、單篇文庫事件、移除 Bing／TranSmart）已提交於 1.3.1；本地 typecheck／lint／deps／單測全量／build 已過，E2E 除下條 minimap 外通過；真實 Codex CLI／登入、付費服務與真實論文旅程未驗收。
- 多 API 密鍵（[settings](../desktop/src/features/settings/README.md#多-api-密鍵)）：本地單測與設定頁 E2E 只用草稿及模擬驗證；以真實 Qwen／DeepSeek 多帳號驗證保存、限流換鍵與 401 換鍵仍需真人驗收。
- Codex 批次譯文錯位已從源頭修正（[translation](../desktop/src/features/translation/README.md#並發與恢復)）；本機文庫掃描僅 `6d215e7c`（Machine learning for computational fracture…）受影響，第 43、45–55 段譯文錯一段，需在閱讀器逐段「重新翻譯此段」。修正後未以真實 Codex 重跑驗收。
- 本機 minimap 跳轉後標題 15.45 px（期望 16±0.5）自 M1 起穩定重現，舊閱讀模型路徑同樣偏移，遠端 CI 曾通過；屬獨立定位修復，不放寬斷言。
- 大檔例外歸各模組 README；chat 的 rag-content-index 仍在使用，不可當死代碼刪除，亦不可合入舊 demo schema 5–7。

本地只保留 master 和最新 release/setup.exe；隱藏清理備份位於 .git/cleanup-safety，不屬可刪構建物。後續待辦直接更新本文件，不另建審計／流水交接。
