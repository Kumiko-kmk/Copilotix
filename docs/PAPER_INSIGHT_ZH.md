# 文庫 AI 結構化解讀

文庫「查看档案 → 03 AI 解读」可生成、取消與重新生成研究問題、方法、貢獻、發現及局限。使用服務連接中首選且已啟用的 Qwen／DeepSeek，與閱讀器問答共用預設模型、已驗證密鑰和版本 2 的論文片段發送授權。缺密鑰、未驗證或未授權會顯示原因；已保存的解讀仍可離線閱讀。這是模型根據有限摘錄生成的內容。

設定 → 模型設定的「翻译完成后自动生成 AI 解读」預設關閉。開啟並保存後，翻譯成功才排隊，已有未過期解讀不重複生成。每篇會產生額外模型 API 費用；關閉會取消正在排隊／生成的解讀。不追溯批量處理過去已完成的文獻。

## 資料與邊界

- shared/paperInsight.ts 定義 strict zod schema；IPC `paperInsight:get/generate/cancel` 與 `paperInsight:changed` 事件經 preload request／response／envelope 校驗。Core RPC 僅 `insight:get/context/save`，存儲由 Utility data 通道負責。
- Main 復用 ChatProvider。每篇 single-flight，全域最多 2 條管線，180 秒生成時限；provider 共用 FIFO 與限流。翻譯正文優先，僅提取標題、摘要、結論及章節開頭，排除參考文獻和圖片路徑；Qwen／DeepSeek 摘錄預算 6144／8192 UTF-8 bytes，整體初始 prompt ≤16384 bytes，保守約束 token，並保留輸出餘量。正文被視為不可信資料。嚴格 JSON 格式失敗最多重試一次；網路／授權錯誤不盲目重試。
- 文獻內 `insight/insight.v1.json` 保存版本 1、文獻 ID、解讀與模型／生成時間／sourceRevision。原文與譯文 artifact ID、revision、hash 共同決定 sourceRevision；任一改變時返回 ready + stale，不自動刪除舊解讀。
- 文件上限 128 KiB；PathPolicy 限定文獻範圍，拒絕解讀目錄／文件符號鏈接。以獨佔臨時文件、fsync、atomic rename 提交；Windows EPERM／EACCES／EBUSY 有界重試最多 6.3 秒，永久錯誤保留舊文件、清理臨時文件。崩潰殘留 `.pending-*` 不被當成正式解讀。
- 舊庫缺文件為 missing；autoGeneratePaperInsight 缺值為 false，不新增 SQLite migration。損壞／越界文件報失敗，不靜默當成有效結果。密鑰和導入路徑不進 prompt／解讀文件，服務商原始錯誤不發往 UI。
- 刪文獻阻止該篇新生成、取消並等待已開始寫入，再刪記錄／文件。文庫維護與退出阻止新生成、取消並 drain，再做備份／遷移／關 Utility，避免晚到寫入復活文獻。維護失敗恢復可用状态。
- 備份 manifest v1 原本遍歷完整文獻樹，故自動包含解讀及雜湊；恢復／遷移仍先驗證再切換，無需新增 manifest 格式。卸載預設保留；明確清理時既有唯讀清單包含解讀與中斷臨時文件，仍拒絕鏈接及確認後變更。

## 驗證入口

`tests/paperInsight.test.ts` 覆蓋長度／provider／schema、prompt 預算、授權、重試、single-flight／併發、取消等待、預設關閉／自動跳過、原子存儲、失敗保留、stale 與路徑限制；`paperInsightIpc.test.ts` 驗證 sender、ID、未知欄位及事件 envelope。備份恢復與卸載清理已加入相應檔案回歸。

`e2e/paper-insight.spec.ts` 使用隔離文庫、真實設定／native vault／Main／Utility，僅 mock provider HTTP，不使用真人 Key 或付費 API；驗證缺 Key、生成後研究問題／方法／貢獻、解密遮罩退開、保存重開、自動開關保存。文庫導航仍由 `e2e/paper-archive.spec.ts` 驗證正常與 WebGL 降級。
