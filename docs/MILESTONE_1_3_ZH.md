# 當前交接與未決事項

1.3.0 已發布： [PR #14](https://github.com/Kumiko-kmk/Copilotix/pull/14)、tag `desktop-v1.3.0`。功能模組化已落地；發布內容見 [版本說明](releases/1.3.0.zh-CN.md)，不以發布代表下列事項完成。

- CI 輕量調度目前為本地未提交修改，尚未在新 PR 遠端驗證；保留現有工作流與選擇器變更。契約及本地驗證範圍見 [發布流程](DESKTOP_RELEASE_ZH.md#ci-调度与验收证据)。
- 性能預算尚未進入自動門禁：首屏 ≤1.5s、編輯可見回應 ≤100ms、捲動長任務 ≤50ms；真實 GPU、真實服務完整旅程和文庫走查仍需獨立驗收。
- 待處理：全形標點旁粗體及圖說亂碼、Zotero 導入進度卡、PDF 引用注釋層；重翻譯／拖曳排序保留真人驗收界線。
- 1.3.1 架構（[document](../desktop/src/features/document/README.md)、[platform/models](../desktop/src/platform/models/README.md)、單篇文庫事件、移除 Bing／TranSmart）已提交於 1.3.1；本地 typecheck／lint／deps／單測全量／build 已過，E2E 除下條 minimap 外通過；真實 Codex CLI／登入、付費服務與真實論文旅程未驗收。
- 多 API 密鍵（[settings](../desktop/src/features/settings/README.md#多-api-密鍵)）：本地單測與設定頁 E2E 只用草稿及模擬驗證；以真實 Qwen／DeepSeek 多帳號驗證保存、限流換鍵與 401 換鍵仍需真人驗收。
- Codex 批次譯文錯位已從源頭修正（[translation](../desktop/src/features/translation/README.md#並發與恢復)）；本機文庫掃描僅 `6d215e7c`（Machine learning for computational fracture…）受影響，第 43、45–55 段譯文錯一段，需在閱讀器逐段「重新翻譯此段」。修正後未以真實 Codex 重跑驗收。
- 本機 minimap 跳轉後標題 15.45 px（期望 16±0.5）自 M1 起穩定重現，舊閱讀模型路徑同樣偏移，遠端 CI 曾通過；屬獨立定位修復，不放寬斷言。
- Lite 版（[介面](UI_PREFERENCES_ZH.md#lite-版外殼)、[開發](DESKTOP_DEVELOPMENT_ZH.md#lite-版)）在 `reader/mineru-pdf-linking` 分支開發。已定為[獨立安裝](DESKTOP_RELEASE_ZH.md#lite-版獨立安裝)，本機與已安裝的完整版 1.3.0 並存通過 `desktop:test:installer:lite`（未簽名、靜默安裝）。CI 建構 out-lite（否則 `lite.spec.ts` 跳過）、簽章、tag／Release 未接入；互動向導只驗到歡迎頁。真實解析／翻譯／問答服務與 Zotero 未在 Lite 走查。
- 卸載「同時清除資料」在 1.3.0 及之前會一律報錯、不刪任何資料：清理程序把 userData 指向待刪目錄（Chromium 佔用並改寫），且 WAL 資料庫的只讀打開使 token 不符。兩處都已修（共用代碼，下版完整版生效），Lite 以真實安裝驗證；完整版只有單元與回歸測試，未在完整版真實安裝上確認刪除。已安裝 1.3.0 的使用者仍有此問題。
- `test-uninstaller-wizard.ps1` 已改為依按鈕找確認框、以 UI Automation 讀正文並斷言路徑，仍只點取消（TaskDialog 正文 WM_GETTEXT 讀不到）；互動程序不可隱藏啟動，否則視窗不可見。`-UiOnly` 與 `-InPlace` 已在裝有完整版 1.3.0 的本機對 1.3.0 產物實跑通過。`-InPlace` 把程式複製到暫存資料夾、不安裝不註冊，走勾選清除→NSIS 帶起 helper→取消，驗證退出碼 2，以及程式檔、註冊表、捷徑與資料不變；安裝與註冊流程只有一般分支驗得到，須乾淨 Windows 帳戶，尚未實跑。三種模式都只點取消，完整版確認刪除仍未驗證。1.3.0 只讀預覽在 `-wal`／`-shm` 不存在時會新建空 WAL 與索引，故資料快照忽略 `-shm` 與空 `-wal`，WAL 有內容仍比對。`test-installer-wizard.ps1` 隱藏啟動 setup 實測不受影響，故未改：語言對話框起初不可見、約 30 ms 內自行轉為可見，其後頁面正常。三語言走頁後取消已在同機對 1.3.0 產物實跑通過；`-Install` 分支尚未實跑。
- 大檔例外歸各模組 README；chat 的 rag-content-index 仍在使用，不可當死代碼刪除，亦不可合入舊 demo schema 5–7。

本地只保留 master 和最新 release/setup.exe；隱藏清理備份位於 .git/cleanup-safety，不屬可刪構建物。後續待辦直接更新本文件，不另建審計／流水交接。
