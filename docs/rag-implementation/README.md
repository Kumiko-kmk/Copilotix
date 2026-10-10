# RAG 分步實施入口

00–03 已完成，04–13 仍為計劃；單篇文獻問答另見 [維護契約](../READER_AI_CHAT_PLAN_ZH.md)，不代表混合 RAG 已實作。

開始先讀根 [AGENTS.md](../../AGENTS.md)、[架構](../ARCHITECTURE_ZH.md)、[RAG 設計](../RAG_DEVELOPMENT_PLAN_ZH.md)及本步文件，再核對源碼／測試／migration。一次只執行一個獲授權步驟；本地驗證及遠端操作按 AGENTS 與當次使用者指示，不套用舊交付提示詞。

| 編號 | 計劃 | 依賴 | 狀態 |
| --- | --- | --- | --- |
| 00 | [基線](00_BASELINE_STABILIZATION.md) | 無 | 已完成 |
| 01 | [契約與狀態](01_RAG_CONTRACTS_AND_STATES.md) | 00 | 已完成 |
| 02 | [持久化與作業](02_RAG_PERSISTENCE_AND_JOBS.md) | 01 | 已完成 |
| 03 | [結構切塊](03_STRUCTURE_AWARE_CHUNKING.md) | 02 | 已完成 |
| 04 | [本地 FTS](04_LOCAL_FTS_BACKEND.md) | 03 | 待實作 |
| 05 | [搜索 UI](05_LOCAL_SEARCH_UX.md) | 04 | 待實作 |
| 06 | [能力配置與同意](06_AI_CONNECTIONS_AND_CONSENT.md) | 05 | 待實作 |
| 07 | [Embedding／精確向量](07_EMBEDDING_AND_EXACT_VECTOR.md) | 06 | 待實作 |
| 08 | [混合檢索與評測](08_HYBRID_RETRIEVAL_AND_EVAL.md) | 07 | 待實作 |
| 09 | [可選 Reranker](09_OPTIONAL_RERANKER.md) | 08 | 可選 |
| 10 | [RAG 問答流與引用](10_CHAT_STREAMING_AND_CITATIONS.md) | 08；09 可選 | 待實作 |
| 11 | [RAG 選區與 Reader](11_SELECTION_QA_AND_READER_INTEGRATION.md) | 10 | 待實作 |
| 12 | [RAG 歷史與刪除治理](12_HISTORY_STORAGE_AND_DELETION.md) | 11 | 待實作 |
| 13 | [性能與發布](13_PERFORMANCE_RELEASE_AND_OPTIONAL_ANN.md) | 12 | 待實作 |

## 跨步不變量

- 文檔 workflow 與本地／語義索引狀態獨立。parsed artifact 可建立本地原文索引，不等待翻譯；embedding 失敗不能破壞本地 ready。
- 本地內容處理離線；外發須獨立同意與有效能力配置，保存 Key 不代表同意。
- citation 綁定 artifact／content revision／chunk／hash，不能採信模型自造頁碼。scope 在 IPC、Main、Utility、SQL 每層校驗。
- SQLite／重計算留在 Utility，網絡／憑據留在 Main；migration 只追加且校驗 checksum。
- 刪文檔必清应用索引；`deleteFiles` 僅控制磁盤產物。后台作業可見、可取消／重試。
- 不降 coverage／斷言／門禁，不把未執行的 E2E、打包或模型評測寫成通過。09 未採用時，10 用 RRF 且不宣稱已啟用 rerank。

交接只更新本步當前契約、實際偏差、剩餘事項與證據入口；不追加全量文件清單、重複測試流水或固定提示詞。完成聲明须有对应證據。
