# chat

論文問答：閱讀器「問答」視圖、回答串流、選區與圖片加入問答，以及問答用的單篇檢索索引。產品與恢復契約見 [問答入口](../../../../docs/READER_AI_CHAT_PLAN_ZH.md)、[AGENTS.md §7](../../../../AGENTS.md)。

## 公開 API

- `contract/`：問答請求、串流事件（`ragSchemas`）、存儲、圖片與引用 schema；`ipc.ts` 的 `paperChatChannels`／`createPaperChatApi`；`rpc.ts` 的 `chatOperations`。
- `main/index.ts`：`PaperChatService`、`ChatProvider`（OpenAI 相容 HTTP）、`ModelGateway`（Qwen／DeepSeek 與 Codex 的統一串流入口，檔案卡與圖片解讀也經它調用模型）、`registerPaperChatHandlers`、索引作業 `RagContentIndexJobRunner`／`RpcRagContentIndexer`。
- `utility/index.ts`：`createChatOperations`（Utility handler）、`SqliteRagRepository`、`RagContentIndexService` 與其錯誤類（Utility 組裝與錯誤映射用）。
- `renderer/index.ts`：`ReaderChatPanel`、`ReaderChatToolbar`、`usePaperChat`、`usePaperChatRouting`。

## 檢索索引（原 RAG 路線的保留部分）

`paper-chat:ensure-index` → `chat:ensure-index` 建立 `rag-content-index` 作業 → `ragContentIndexService` 用 `structureAwareChunker` 寫入 `rag_*` 表 → `chat:build-context` 由 `paperContextBuilder` 讀出上下文。作業類型、Core RPC 名與 schema 4 的 `rag_*` 表（含不再使用的語義／向量表）保持原名以兼容遷移。

## 資料

- 文獻目錄 `chat/`：分頁歷史、`session.json`（草稿、選區、模型），原子寫入，無 migration。
- SQLite `rag_documents`、`rag_content_revisions`、`rag_chunks`。

## 測試

`tests/features/chat/`（`pnpm desktop:test --module chat`）；E2E `e2e/paper-chat.spec.ts`、`codex.spec.ts`。
