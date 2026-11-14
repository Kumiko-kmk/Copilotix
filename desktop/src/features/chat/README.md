# chat

論文問答：閱讀器「問答」檢視、回答串流、選區與圖片加入問答，以及問答用的單篇檢索索引。產品與恢復契約見 [問答入口](../../../../docs/READER_AI_CHAT_PLAN_ZH.md)。

## 公開 API

- `contract/`：問答請求、串流事件（`ragSchemas`）、儲存、圖片與引用 schema，檢索索引的切塊型別（`ragChunk.ts`）；`ipc.ts` 的 `paperChatChannels`／`createPaperChatApi`；`rpc.ts` 的 `chatOperations`。
- `main/index.ts`：`PaperChatService`、`ChatProvider`（OpenAI 相容 HTTP）、`ModelGateway`（Qwen／DeepSeek 與 Codex 的統一串流入口，檔案卡與圖片解讀也經它呼叫模型）、`registerPaperChatHandlers`、索引作業 `RagContentIndexJobRunner`／`RpcRagContentIndexer`。
- `utility/index.ts`：`createChatOperations`（Utility handler）、`SqliteRagRepository`、`RagContentIndexService` 與其錯誤類（Utility 組裝與錯誤對映用）。
- `renderer/index.ts`：`ReaderChatPanel`、`ReaderChatToolbar`、`usePaperChat`、`usePaperChatRouting`。

## 檢索索引（原 RAG 路線的保留部分）

`paper-chat:ensure-index` → `chat:ensure-index` 建立 `rag-content-index` 作業 → `ragContentIndexService` 用 `structureAwareChunker` 寫入 `rag_*` 表 → `chat:build-context` 由 `paperContextBuilder` 讀出上下文。作業型別、Core RPC 名與 schema 4 的 `rag_*` 表（含不再使用的語義／向量表）保持原名以相容遷移。

## 資料

- 文獻目錄 `chat/`：分頁歷史、`session.json`（草稿、選區、模型），原子寫入，無 migration。
- SQLite `rag_documents`、`rag_content_revisions`、`rag_chunks`。

## 模型請求佇列

`ChatProvider.stream` 可選 `lane` 只屬 Main 內部引數，未提供時沿用互動 FIFO；`background` 為每服務商最多 8 個在途串流，檔案卡與圖片解讀共用此預算。互動請求擁有獨立槽位，不排在背景長文生成之後；服務商冷卻及憑據失效仍共用，排隊取消可中斷，首位元組期限從真正開始請求時計算。現有 IPC／Core RPC／歷史檔格式與問答順序不變。既有佇列／取消／期限入口為 `tests/features/chat/chatProvider.test.ts`。

## 測試

`tests/features/chat/`（`pnpm desktop:test --module chat`）；E2E `e2e/paper-chat.spec.ts`、`codex.spec.ts`。

問答正文從 document snapshot 產生（套用有效編輯、刪除與順序），長塊再依既有 chunk 上限拆分；檢索索引來源版本不符即要求重新索引。傳輸、取消、健康狀態與用量由 platform/models 共用，問答不自動切換供應商。
