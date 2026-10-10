# 01 — RAG 契約與狀態（已完成）

## 維護契約

- `shared/ragSchemas.ts` 為 wire 契約來源；`ragTypes.ts` 僅 re-export inferred types。DocumentWorkflowStatus 不混入 RAG 狀態；本地、語義、問答可用性獨立。
- Scope 只有 `current-document`、`documents`、`collection` 三個 discriminator。限制、strict 未知欄位拒絕與 1 MiB wire 邊界以 schema 為準。
- 選區要求 artifact／content revision／hash 快照；citation 須完整來源身份。不能從模型返回的路徑或頁碼建立可信引用。
- Utility 內部 `VectorStorePort` 接收 vectorIndexId、contentRevisionId、profileId、Float32Array query vector 與 limit，返回 chunkId／rank／score；`RetrieverPort` 才接收 wire 文本搜索請求。向量不跨 Renderer RPC。
- 端口聲明不代表檢索／向量後端已實作；运行时数值校驗由後續實作維護。

回歸入口：`ragContracts.test.ts`、`ports.test.ts`、`documentContracts.test.ts`。重點場景：無 Key 仍可本地 ready；未同意時需 consent；embedding 失敗不改本地 ready。後續持久化見 [02](02_RAG_PERSISTENCE_AND_JOBS.md)。
