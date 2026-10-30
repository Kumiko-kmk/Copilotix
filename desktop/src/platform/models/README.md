# models

Main 進程共用的模型連接、傳輸、資源預算、取消、健康狀態與用量入口；不依賴 features。提示詞與結果校驗屬於各功能。

contract/models.ts 定義 ModelConnection、ModelRequest、ModelResult、ConnectionHealth。連接集合只存憑據引用；Key 保留系統憑據庫。現有設定對應供應商 default 連接，介面仍每供應商一個 Key。配置或憑據變化僅重置該連接。

runtime/modelRuntime.ts 在入隊及發送前檢查。首次及冷卻結束只放行一個真實請求，等待者可取消；沒有背景探測。網路／暫時服務錯誤冷卻 30 秒起、倍增至 5 分鐘，尊重有效 Retry-After；憑據失效保持 invalid 直至修改／手動驗證。輸入錯誤及取消不使連接失效，已在途的遲到成功不能清除冷卻。

Qwen／DeepSeek 每額度組最多 15 個背景與 1 個互動請求。Codex 保留 8 個背景與 1 個互動進程槽位。每邏輯請求同一候選只試一次；部分串流輸出禁止重放或回退。跨供應商授權由功能設定決定，平台不擅自添加候選。

main/cloudProvider.ts 與 completionTransport.ts 擁有線上傳輸；modelGateway.ts 接入既有 Codex runtime。execute 回傳實際連接／供應商／模型／用量，onUsage 在應用組裝處接入既有統計。日誌與統計不含 Key、正文或供應商原始錯誤內容。健康狀態只存本次運行；持久憑據驗證仍由 settings 擁有。

tests/platform/modelRuntime.test.ts 覆蓋單次驗證、同時失敗、冷卻試探、取消、配置重置、額度與部分輸出。Codex 與傳輸測試驗證無疊加重試。
