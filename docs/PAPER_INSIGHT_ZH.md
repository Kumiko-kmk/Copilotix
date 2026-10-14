# 文庫 AI 檔案卡

文庫「查看档案」使用 Paper Brief v2；顯示內容見 [Paper Brief v2](PAPER_BRIEF_ZH.md)。沒有 v2 時保留規則提取欄位與舊版 AI 解讀。生成／重新生成／取消及狀態位於閱讀器「AI 问答」頁籤工具列的「档案卡」點擊選單，不佔用檔案摘要區；缺少服務設定時提供設定入口。已有結果可離線閱讀，重新生成期間仍保留已保存內容。

## 生成與生命週期

- 解析完成即可手動生成。沿用首選且已啟用的 Qwen／DeepSeek、閱讀器共用預設模型、已驗證 Key 與版本 2 論文片段發送授權；缺任何一項都不發送正文。
- 翻譯成功後一律自動排隊生成 AI 解讀（2026-10-13 使用者決定，設定頁不提供開關）；`autoGeneratePaperInsight` 只為設定 schema 兼容保留，讀取時恆為 true、舊值 false 被忽略。已有未過期結果就跳過，解析完成不觸發，不追溯批量生成。發送前仍檢查問答同意與已驗證的 Key／Codex 登入；未滿足時不發送。生成使用模型服務，產生額外費用。
- 每篇 single-flight、全域最多 2 條管線、300 秒時限，共用 provider FIFO／限流。格式校驗失敗修復一次；網路、授權與限流錯誤不盲目重試。
- 刪除論文、文庫維護與退出均先阻止新生成、取消並等待落盤；取消不能中斷已開始的原子提交。失敗不覆蓋已保存結果。

## 接口與兼容

- IPC 仍為 `paperInsight:get/generate/cancel` 與 `paperInsight:changed`；ready 狀態為舊 `insight` 或新 `brief + anchors + promptOutdated`，兩者均 strict 校驗。Main／Preload／Renderer 隨同一應用版本更新。
- Core RPC 為 `insight:get`、`insight:brief-context`、`insight:save-brief`；取代不再由 Main 使用的 v1 context/save operation。Utility data 通道負責讀寫，取消與維護語義不變。
- v2 保存於 `insight/brief.v2.json`，上限 256 KiB；包含 brief、程式 checks／provenance，以及被引用的原始摘錄與章節名。先讀 v2，缺少時回退 `insight.v1.json`（128 KiB）；損壞檔案報錯，不悄悄當成缺少。v1 不刪除，不改 SQLite migration／備份 manifest v1。
- sourceRevision 由原文與譯文 artifact ID、revision、hash 決定；變更才標 stale。promptVersion 不同只提示可重新生成，不觸發全庫過期或自動升級。
- PathPolicy 限定文獻目錄並拒絕鏈接。寫入使用獨佔 `.pending-*`、fsync、atomic rename；Windows EPERM／EACCES／EBUSY 最多約 6.3 秒重試，永久失敗保留舊檔並清理臨時檔。備份／恢復／遷移包含完整文獻樹；明確授權的卸載清理包含 v1、v2 與臨時檔。

摘錄、提示詞、檢查限制與真實 API 驗證見 [Paper Brief v2](PAPER_BRIEF_ZH.md)。測試入口：`paperBrief.test.ts`、`paperInsight.test.ts`、`ipcContracts.test.ts`、`chatProvider.test.ts`、備份與卸載清理測試，以及 `e2e/paper-insight.spec.ts`／`paper-archive.spec.ts`。Mock 測試驗證流程，不代表模型品質。

Codex 可作為已啟用的首選服務：沿用版本 2 發送授權，使用服務連接中選定的 Codex 問答模型；不讀取 API Key。圖片還需模型支持 image，否則明確失敗。結果仍經既有 schema／grounding 校驗與原子保存。運行時與資料庫 provider 擴展見 [架構](ARCHITECTURE_ZH.md#codex-provider本机-app-server)，設定步驟見 [服務配置](wiki/Service-Setup.md)。
