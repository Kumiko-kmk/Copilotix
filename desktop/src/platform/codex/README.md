# codex

`runtime/codexRuntime.ts` 管理本機 app-server、一次性只讀生成會話與帳戶範圍限流；Main／Renderer 設定與狀態經 `contract/`、`main/` 入口銜接。隔離與資料契約見 [架構](../../../../docs/ARCHITECTURE_ZH.md#codex-provider本机-app-server)。

## 並發與恢復

交互 FIFO 與后台最多 8 槽分開；429 自適應減半、成功逐槽恢復、最多 6 次有限重試保持不變。`CodexBackoff` 對舊 epoch 的在途失敗只在冷卻仍有效時合併；舊冷卻已過期時重新退避，避免長請求用舊 epoch 繞過冷卻。冷卻期間的其他成功回應不增加槽位；不提高 Codex 進程數上限。

無 IPC／RPC／schema／快照格式變更，連接與部分輸出取消語義不變。本次按使用者要求未執行測試；既有入口為 `tests/platform/codexRuntime.test.ts` 的 `CodexBackoff`、取消與有限重試用例。
