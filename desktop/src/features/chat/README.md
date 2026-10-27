# chat

論文問答：閱讀器「問答」視圖、回答串流、選區與圖片加入問答，以及問答用的單篇檢索索引。產品與恢復契約見 [問答入口](../../../../docs/READER_AI_CHAT_PLAN_ZH.md)、下方「契約」。

## 公開 API

- `contract/`：問答請求、串流事件（`ragSchemas`）、存儲、圖片與引用 schema，檢索索引的切塊型別（`ragChunk.ts`）；`ipc.ts` 的 `paperChatChannels`／`createPaperChatApi`；`rpc.ts` 的 `chatOperations`。
- `main/index.ts`：`PaperChatService`、`ChatProvider`（OpenAI 相容 HTTP）、`ModelGateway`（Qwen／DeepSeek 與 Codex 的統一串流入口，檔案卡與圖片解讀也經它調用模型）、`registerPaperChatHandlers`、索引作業 `RagContentIndexJobRunner`／`RpcRagContentIndexer`。
- `utility/index.ts`：`createChatOperations`（Utility handler）、`SqliteRagRepository`、`RagContentIndexService` 與其錯誤類（Utility 組裝與錯誤映射用）。
- `renderer/index.ts`：`ReaderChatPanel`、`ReaderChatToolbar`、`usePaperChat`、`usePaperChatRouting`。

## 檢索索引（原 RAG 路線的保留部分）

`paper-chat:ensure-index` → `chat:ensure-index` 建立 `rag-content-index` 作業 → `ragContentIndexService` 用 `structureAwareChunker` 寫入 `rag_*` 表 → `chat:build-context` 由 `paperContextBuilder` 讀出上下文。作業類型、Core RPC 名與 schema 4 的 `rag_*` 表（含不再使用的語義／向量表）保持原名以兼容遷移。

## 資料

- 文獻目錄 `chat/`：分頁歷史、`session.json`（草稿、選區、模型），原子寫入，無 migration。
- SQLite `rag_documents`、`rag_content_revisions`、`rag_chunks`。

## 模型請求隊列

`ChatProvider.stream` 可選 `lane` 只屬 Main 內部參數，未提供時沿用交互 FIFO；`background` 為每服務商最多 8 個在途串流，檔案卡與圖片解讀共用此預算。交互請求擁有獨立槽位，不排在后台長文生成之後；服務商冷卻及憑據失效仍共用，排隊取消可中斷，首字節期限從真正開始請求時計算。現有 IPC／Core RPC／歷史檔格式與問答順序不變。本次按使用者要求未執行測試；既有隊列／取消／期限入口為 `tests/features/chat/chatProvider.test.ts`。

## 測試

`tests/features/chat/`（`pnpm desktop:test --module chat`）；E2E `e2e/paper-chat.spec.ts`、`codex.spec.ts`。

## 契約（2026-10-26 自 AGENTS.md 遷入）

### 問答契約（原 AGENTS §7）

- 問答共享入口：`docs/READER_AI_CHAT_PLAN_ZH.md`（含圖片加入問答，§5a）。文獻目錄 `chat/` 原子保存歷史、草稿、選區與模型，歷史分頁；問答文件本身無獨立 migration；Codex provider 使用資料庫 migration 5，不合併 demo schema 5–7。清空、刪文獻、文庫維護及退出前，須等待相關問答取消與落盤，避免晚到寫入。
- 問答沿用「服務連接」憑據，默認翻譯服務商，可獨立選已啟用 Qwen／DeepSeek 的共享預設模型或 Codex 動態目錄模型，不改翻譯模型；IPC／Main 校驗 provider、Key、valid；Codex 改驗本機登入／模型能力，不讀 API Key。舊 request 可省略 provider；舊 chatProvider 不參與路由，自訂模型回退預設而不損壞歷史，Key 不進聊天文件。首次打開問答才掛載／建索引；添加選區不切頁籤，恢復引用重新核對 revision。

Codex 的進程隔離、交互 FIFO／后台 8 槽位、新臨時會話、取消／超時、migration 5 恢復與測試入口統一見 [架構文檔](docs/ARCHITECTURE_ZH.md#codex-provider本机-app-server)，使用步驟見 [服務配置](docs/wiki/Service-Setup.md)。
