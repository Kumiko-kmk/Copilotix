---
document_id: copilotix-reader-ai-chat-plan
status: implemented-local-build-awaiting-live-acceptance
owner: shared-agents
branch: codex/reader-ai-chat
updated: 2026-10-07
---

# 單篇文獻 AI 問答：Agent 協作與維護契約

此文件保留為 Agent 交接入口。已合併重複計劃、過時的 API 設定方案、逐輪 CI 排查與舊包體積紀錄；最新行為以本文件和源碼為準，最新驗證必須對應最新提交。根目錄 `AGENTS.md` 的 worktree、CI、發布及資料保護規則繼續適用。

## 1. 工作邊界與目前功能

- 工作分支 `codex/reader-ai-chat` 位於 `Copilotix-master-updated`。開始及交付前核對 HEAD 和未提交狀態；不得改動其他 Agent 的 worktree。
- 單篇文獻問答已實作：限定當前文獻、固定選區、流式回答、停止、Markdown／KaTeX、可信引用定位。2026-10-07 加入 Qwen／DeepSeek 切換及文獻目錄中的本地持久化。
- 不合併 demo `codex/rag-review-20260923` 的 schema 5–7、向量或多文獻聊天；本功能保留現有 schema 4，不新增 migration。未来多文獻／向量／reranker 設計見 `RAG_DEVELOPMENT_PLAN_ZH.md` 和 `rag-implementation/`。
- 不支持聯網搜索、工具調用或模型自行讀取本地文件；問題的依據仍限定為当前文獻的原文 evidence pack。已生成的舊記憶體對話無法在應用關閉後補回。

## 2. 服務商、模型與授权

- 默認沿用當前啟用的翻譯服務商；問答面板可另選已啟用的 Qwen 或 DeepSeek，獨立切換問答模型，不改翻譯模型。API 地址和 Key 共用「服務連接」，不新增第二套 API 設定。
- 舊 `chatProvider` 設定欄位僅兼容讀取，不參與路由。舊客戶端省略 request.provider 時仍沿用翻譯服務商；新客戶端可明確指定 Qwen／DeepSeek。停用服務商、失效 Key、未驗證 Key 均不得發送。
- 問答只支持預設模型：Qwen `qwen-plus`（日常）、`qwen3.8-flash`（快速）、`qwen3.8-max`（高階）；DeepSeek `deepseek-flash`、`deepseek-v4-pro`。不支持自訂名稱，IPC／Main 按服務商驗證預設清單；舊設定與 session 中的自訂型號回退到服務商預設值，既有 turn 保留歷史型號、回答與引用。翻譯專用 `qwen-mt-plus` 留在翻譯設定。
- DeepSeek 官方接口：Flash 顯式關閉 thinking；Pro 啟用 thinking，預留 32768 output tokens。SSE 僅把 content 當作回答，reasoning_content 不混入回答或歷史。本功能不使用 tools，後續輪次無須回傳 reasoning_content。
- 模型清單核對來源：[DeepSeek 模型](https://api-docs.deepseek.com/quick_start/pricing/)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)、[Qwen 官方清單](https://www.alibabacloud.com/help/en/model-studio/models)。區域可用性與真實 Key 需人工驗收。
- Key 保存在系統 Credential Vault；Renderer 不接觸 Key、base URL 或任意文件路徑。首次發送須展示接收服務商、模型與將發送的問題／近期對話／選區／論文片段；現有 consent version 2 向後兼容；舊授權只覆蓋當時翻譯服務商，新授權記錄 chatConsentProvider，切換接收方需重新同意。撤銷授權只停止後續發送，不刪服務商已收到的資料。
- Main 在讀完上下文後再次檢查授權、啟用狀態與憑據；401／403 使憑據失效，429 遵守 Retry-After。日志只記 provider、model、requestId、耗時、错误碼、token 数，不記問題、回答、片段或 Key。

## 3. 本地記錄、兼容與恢復

```text
<文獻 storage_path>/
├─ original.pdf 與既有解析／翻譯產物
└─ chat/
   ├─ session.json
   └─ <毫秒時間戳>-<requestId>.json  # 每輪一份，version 1
```

- session.json 保存草稿、固定選區與服務商／模型選擇；turn JSON 保存問題、回答、已驗證引用、服務商、模型、時間及狀態。文件不含 API Key，也不把整份檢索 evidence pack 重複備份進聊天記錄。
- Utility 按資料庫已登記的 storage_path 解析路徑，使用 PathPolicy，拒絕逃逸、符號鏈接或異常文件；Renderer 只傳 documentId。每輪 JSON 有界，寫入使用臨時文件、fsync、原子 rename；失敗不先刪舊文件。
- 開始前先保存問題，成功回答在保存完成後才發 completed。串流約每秒寫入檢查點；取消／失敗保存已收到的回答。正常退出等待取消與落盤，再停 Utility。異常退出後 pending 恢復為 cancelled，不嘗試自動重發付費請求；尚未落盤的最後增量不能保證恢復。
- 讀取不存在的 chat 目錄返回空記錄，不建索引；損壞／不支持的文件報錯并保留，不默默覆蓋。草稿僅在成功恢復後自動保存；切換文獻時忽略上一篇的晚到結果。
- 歷史逐頁載入，最多 20 輪／256 KiB，keyset cursor 指向更早文件。新回答不再刪除第 12 輪之前的記錄；發給模型的近期上下文仍最多 6 組／24000 字元，歷史不作為論文 evidence。
- 「清空對話」先取消該文獻的在途回答並等待保存，再刪除已識別的 turn JSON；保留草稿、選區、其他文獻和全部源文件。刪除文獻前同樣等待該文獻問答結束。
- 現有文庫備份／恢復／遷移會遍歷完整文獻目錄，因此 chat 文件隨文獻一併複製並校驗；維護前等待問答停止，避免背景寫入破壞快照。卸載默認保留文庫，明確清除資料時沿用已登記 documents-v2/<id> 的邊界，无新增外部清理目錄。
- 恢復的引用仍需核對當前 contentRevisionId；過期引用提示重新提問，不以舊引用位置導覽新文獻。

## 4. 證據、串流與 UI 契約

- `PaperContextBuilder` 只讀當前激活版本的 chunks。短文按原文順序提供全文；長文依次選固定選區及相鄰 chunk、摘要／引言、輕量詞法排名與大綱，去重並披露 truncated。默認 budget 48000 字元、wire 256 KiB。中文問題配長英文文獻的詞法檢索仍有限，優先使用固定選區；英語 query rewriting 為可選後續。
- 原文 quote／mapping／revision 必須匹配；譯文選區以 mapping 回到原文，只把譯文當未驗證參考。fragment offset 使用 UTF-16，保存引用 locator 與 provenance。
- 系統提示將 evidence、選區、歷史標為不可信資料；JSON escape < 和 >，不讓文本關閉 evidence delimiter。僅允許當前 evidence pack 中簽發的 E1… 引用；未知引用移除，最多 50 個。
- 每篇同時一個請求，替代請求取消前一個；最多 8 篇在途。服務商各有獨立 FIFO，不排在翻譯後面。首字節約 30 秒、stream idle 約 60 秒；回答 32768 字元上限，IPC delta 有界且按 50 ms 合併。
- 事件遵守 accepted → retrieving → evidence-ready → delta/citation → completed/failed/cancelled，帶 requestId、sequence。Renderer 校驗合法轉移、忽略重複／晚到事件、緩衝 ask 返回前的事件、停止後抑制晚到完成。
- 閱讀器只顯示原文 Markdown、中文 Markdown、AI 問答三個頁籤；不再展示 JSON 頁籤，底層 layout JSON 和 ZIP 資料仍保留。問答首次開啟才掛載面板及觸發 ensure-index；只打開論文不得建索引。「添加到對話」加入選區，不自動切換頁籤，保留最多 8 個固定選區。
- Enter 發送，Shift+Enter 換行，IME 不誤發；輸入框／模型選擇留在面板底部。停止後保留部分回答；失敗／取消可重試。引用按首次出現順序編號，hover 顯示來源、點擊核對版本後定位。
- SafeMarkdown 禁止回答中的外部圖片／可執行鏈接／script 網路副作用；只顯示經驗證引用和 KaTeX 公式。長回答僅在用戶接近底部時自動跟隨，尊重 reduced-motion。

## 5. 代碼與測試入口

| 邊界 | 入口 |
| --- | --- |
| 共享契約 | shared/paperChatSchemas.ts、paperChatStorageSchemas.ts、ragSchemas.ts、types.ts、coreRpcSchemas.ts |
| Main／Preload | main/chat/paperChatService.ts、paperChatIpc.ts、chatProvider.ts、main/index.ts、preload/index.ts |
| Utility | utility/core/paperContextBuilder.ts、persistence/paperChatStore.ts、utilityOperations.ts |
| UI | renderer/usePaperChat.ts、components/ReaderChatPanel.tsx、paperChat.css、ReaderTextPane.tsx、pages/ReaderPage.tsx |
| 回歸 | paperChatContracts、paperChatService、paperChatUtility、paperChatStore、chatProvider、ReaderChatPanel、paperContextBuilder、ReaderTextPane；e2e/paper-chat.spec.ts |

新增持久化回歸覆蓋：真實本地文件重新讀取、文獻隔離、45 輪分頁、完整引用／草稿／模型、取消和清空次序、損壞文件保留、目錄 junction 拒絕、Core RPC 全鏈路和 Renderer reload。E2E 用隔離 vault 與假 Key，只模擬 provider HTTP，不讀寫真人憑據或調用付費 API。

## 6. 驗證與真人验收

日常不預設跑本地 lint／typecheck／單元／coverage／E2E。依使用者 2026-10-07 指示，修改只在本地 commit／build／打包，未獲明確允許不得 push 或上傳遠端；最新本地包須完成內建校驗，但不能稱為已通過完整 CI。若後續獲授權執行 Actions，必須驗證最新 SHA，歷史成功不得替代新提交。

CI 必須保留既有 coverage、packaged smoke、19 項核心 Electron E2E及安裝／升級／卸載／下載驗證。CI 失敗應修復產品或夾具的原因，不關門禁、減斷言或加無限重試。

人工驗收使用隔離資料目錄：兩篇文獻分別提問；退出應用並重開；驗證問題、回答、引用、草稿和模型保留；停止回答／清空後重開；備份或遷移後再讀取；更新解析版本後點舊引用。真實 Qwen／DeepSeek 的效果、延遲、模型區域可用性與 Windows 視覺／安裝體驗仍由真人驗收，假 HTTP 與 CI 綠燈不能替代。
