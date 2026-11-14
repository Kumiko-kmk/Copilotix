# 文庫 AI 檔案卡

文庫「檢視檔案」使用 Paper Brief v2；顯示內容見 [Paper Brief v2](PAPER_BRIEF_ZH.md)。沒有 v2 時保留規則提取欄位與舊版 AI 解讀。生成／重新生成／取消及狀態位於閱讀器「AI 問答」頁籤工具列的「檔案卡」點選選單，不佔用檔案摘要區；缺少服務設定時提供設定入口。已有結果可離線閱讀，重新生成期間仍保留已儲存內容。

## 首頁事實提取

作者／單位由共享 `features/library/core/paperProfile.ts` 在本地從標題後的首頁區域提取；Main 與介面共用同一份演算法。支援未標 Abstract 的期刊摘要、長作者名單、姓名附註及中英文姓名；日期、DOI、郵件及正文不作作者。無標題摘要只在可信作者後的首個長段落中推定。

本地缺失的標題、作者、發表年份、期刊／會議及 DOI，隨既有全文分析請求的 `missingMetadata` 詢問，不額外序列請求；本地已知者不重填。模型回傳 `metadata` 每項為 null 或 `{value,evidence,anchors}`；證據須在首頁區域與所引全文分塊均存在，值須可從原文引用直接讀到，年份／DOI 再檢查格式。不得從參考文獻、檔名或模型記憶推測；無證據就丟棄該欄，不讓資料兜底失敗拖垮四部分分析。本地值優先，介面僅在 source 非 stale 時使用模型補全值。這是證據約束，不能替代人工作者／出版資訊核對。

## 生成與生命週期

- 解析完成即可手動生成。沿用首選且已啟用的 Qwen／DeepSeek、閱讀器共用預設模型、已驗證 Key；使用程式即同意向已選服務傳送內容；缺任何一項都不傳送正文。
- 解析成功後自動生成，與翻譯並行；翻譯成功事件補足恢復流程，已有未過期結果則跳過。啟動／文庫維護恢復後只補回 missing 且有全文產物的檔案，ready（含 stale）不重算；滿 200 個待處理任務時等待槽位，維護／退出中止掃描。設定頁不提供開關；`autoGeneratePaperInsight` 只為 schema 相容保留，舊值 false 被忽略。傳送前仍檢查已驗證的 Key／Codex 登入；未滿足時不傳送。
- 每篇 single-flight、全域最多 8 條分析管線、600 秒時限。雲端使用每服務商最多 8 路的背景佇列，互動問答槽位獨立；首位元組期限從實際傳送時計算為 120 秒，暫時網路／限流錯誤最多 3 次嘗試，全部共用 600 秒時限，授權錯誤不重試、過長冷卻不盲等。Codex 翻譯使用 low、檔案分析使用 medium（2026-10-16 使用者選定速度優先），維持原 8 槽自適應退避與既有有限重試；互動問答仍使用服務連線的檔位。格式校驗失敗仍只修復一次。
- 刪除論文、文庫維護與退出均先阻止新生成、取消並等待落盤；取消不能中斷已開始的原子提交。失敗不覆蓋已儲存結果。

## 介面與相容

- IPC 仍為 `paperInsight:get/generate/cancel` 與 `paperInsight:changed`；ready 狀態為舊 `insight` 或新 `brief + anchors + promptOutdated`，兩者均 strict 校驗。Main／Preload／Renderer 隨同一應用版本更新。
- Core RPC 為 `insight:get`、`insight:brief-source`、相容分類用的 `insight:brief-context` 及 `insight:save-brief`；取代不再由 Main 使用的 v1 context/save operation。Utility data 通道負責讀寫，取消與維護語義不變。
- v2 儲存於 `insight/brief.v2.json`，上限 256 KiB；包含 brief、程式 checks／provenance，以及分析與 metadata 引用的原始摘錄及章節名。儲存 schema 的 metadata 為可選以讀取舊 v2，新生成要求完整 metadata 物件；提示詞版本已更新，舊結果不強制重生，需手動重新生成才取得兜底。先讀 v2，缺少時回退 `insight.v1.json`（128 KiB）；損壞檔案報錯，不悄悄當成缺少。v1 不刪除，不改 SQLite migration／備份 manifest v1；IPC／Core RPC 隨同一應用版本更新。
- sourceRevision 記錄原文與譯文 artifact ID、revision、hash；以原文生成的 v2 僅在原文變更時標 stale，發布譯文不重複生成。譯文回退與舊 v1 仍按完整 revision 檢查。promptVersion 不同只提示可重新生成。
- PathPolicy 限定文獻目錄並拒絕連結。寫入使用獨佔 `.pending-*`、fsync、atomic rename；Windows EPERM／EACCES／EBUSY 最多約 6.3 秒重試，永久失敗保留舊檔並清理臨時檔。備份／恢復／遷移包含完整文獻樹；明確授權的解除安裝清理包含 v1、v2 與臨時檔。

全文來源、四部分分析、提示詞、檢查限制與真實 API 驗證見 [Paper Brief v2](PAPER_BRIEF_ZH.md)。測試入口：`paperBrief.test.ts`、`paperInsight.test.ts`、`ipcContracts.test.ts`、`chatProvider.test.ts`、備份與解除安裝清理測試，以及 `e2e/paper-insight.spec.ts`／`paper-archive.spec.ts`。Mock 測試驗證流程，不代表模型品質。

## 文庫就緒與進度

選中論文後，在進入詳情前準備整圖；翻譯成功、已儲存檔案非 stale、所需可靠整圖與排版封面均已準備後才開放「檢視檔案」。按鈕、Enter 與場景卡片入口共用門禁；「開啟閱讀」仍可使用。未完成或失敗不顯示 100%／成功對號。

標題分隔線右端只顯示細圓環，不放數字或說明；完成後綠色對號停留約 1 秒，再淡出。`localStorage` 按 document ID 儲存一次性完成標記；重新整理、重啟、換篇返回及後續重新生成均不重播，門禁仍按當前內容就緒狀態檢查。測試入口：`useArchivePreparation.test.tsx`、`ArchiveProgressRing.test.tsx`、`LibraryPage.test.tsx`、`PaperArchiveScene.test.tsx`。

Codex 可作為已啟用的首選服務：使用服務連線中選定的 Codex 問答模型；不讀取 API Key。圖片還需模型支援 image，否則明確失敗。結果仍經既有 schema／grounding 校驗與原子儲存。執行時與資料庫 provider 擴充套件見 [架構](ARCHITECTURE_ZH.md#codex-provider本機-app-server)，設定步驟見 [服務配置](wiki/Service-Setup.md)。


## 驗證邊界

歷史實測在工作區 investigation/efficiency-20261016；不能保證一分鐘完成、模型品質或當前構建驗收。測試須覆蓋生成／取消／落盤／恢復與所有入口門檻。封面單頁回歸見 [未決事項](MILESTONE_1_3_ZH.md)。
