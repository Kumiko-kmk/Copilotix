# models

Main 進程共用的模型連接、傳輸、資源預算、取消、健康狀態與用量入口；不依賴 features。提示詞與結果校驗屬於各功能。

contract/models.ts 定義 ModelConnection、ProviderKey、ModelRequest、ModelResult、ConnectionHealth。每個 Qwen／DeepSeek 密鍵是一個連接（`<provider>:default` 或 `<provider>:<uuid>`，每供應商最多 5 個），credentialRef 由 id 推導、Key 只在系統憑據庫；同供應商的密鍵共用 quotaGroup，增加密鍵不增加併發。`keyConnection` 把密鍵雜湊入 configVersion，配置或憑據變化僅重置該連接。

runtime/modelRuntime.ts 在入隊及發送前檢查。首次及冷卻結束只放行一個真實請求，等待者可取消；沒有背景探測。網路／暫時服務錯誤冷卻 30 秒起、倍增至 5 分鐘，尊重有效 Retry-After；憑據失效保持 invalid 直至修改／手動驗證。輸入錯誤及取消不使連接失效，已在途的遲到成功不能清除冷卻。

候選依序嘗試：冷卻或被拒的密鍵直接跳過，暫時錯誤或 401/403 換下一個；`onCredentialRejected` 在連接首次被拒時通知一次，供 settings 持久化該鍵狀態。Qwen／DeepSeek 每額度組最多 15 個背景與 1 個互動請求。Codex 保留 8 個背景與 1 個互動進程槽位。每邏輯請求同一候選只試一次；部分串流輸出禁止重放或回退。跨供應商授權由功能設定決定，平台不擅自添加候選。

main/cloudProvider.ts 與 completionTransport.ts 擁有線上傳輸；modelGateway.ts 接入既有 Codex runtime。execute 回傳實際連接／供應商／模型／用量，onUsage 在應用組裝處接入既有統計。日誌與統計不含 Key、正文或供應商原始錯誤內容。健康狀態只存本次運行；持久憑據驗證仍由 settings 擁有。

tests/platform/modelRuntime.test.ts 覆蓋單次驗證、同時失敗、冷卻試探、取消、配置重置、額度與部分輸出。Codex 與傳輸測試驗證無疊加重試。
