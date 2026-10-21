---
document_id: copilotix-reader-ai-chat-plan
status: implemented-local-build-awaiting-live-acceptance
owner: shared-agents
branch: master
updated: 2026-10-21
---

# 單篇文獻 AI 問答：Agent 協作與維護契約

此文件維護當前功能契約與待驗收邊界，驗證必須對應最新提交。Worktree、CI、發布及資料保護規則見根目錄 `AGENTS.md`。

## 1. 工作邊界與目前功能

- 維護入口為 `Copilotix-master-updated`／本地 `master`。開始及交付前核對 HEAD 和未提交狀態；不得改動其他 Agent 的 worktree。
- 單篇文獻問答已實作：限定當前文獻、固定選區、流式回答、停止、Markdown／KaTeX、可信引用定位。2026-10-07 加入 Qwen／DeepSeek 切換及文獻目錄中的本地持久化。
- 多文獻／向量／reranker 的 RAG 路線已於 2026-10-12 放棄，相關計劃文檔、`knowledge:*` RPC 與嵌入／向量 Repository 代碼已刪除；不合併 demo `codex/rag-review-20260923` 的 schema 5–7。schema 4 中 rag_* 的語義／向量表與 `rag-embed`／`rag-delete` 作業類型只為 migration checksum 與舊庫兼容保留；除刪除文檔／內容換版時的兼容清理外不再讀寫。
- 不支持聯網搜索、工具調用或模型自行讀取本地文件；問題的依據仍限定為当前文獻的原文 evidence pack。已生成的舊記憶體對話無法在應用關閉後補回。

## 2. 服務商、模型與授权

- 默認沿用當前啟用的翻譯服務商；問答面板可另選已啟用的 Qwen、DeepSeek 或 Codex，獨立切換問答模型，不改翻譯模型。API 地址和 Key 共用「服務連接」，不新增第二套 API 設定。
- 舊 `chatProvider` 設定欄位僅兼容讀取，不參與路由。舊客戶端省略 request.provider 時仍沿用翻譯服務商；新客戶端可明確指定 Qwen／DeepSeek／Codex。停用服務商、失效 Key、未驗證 Key 均不得發送。
- 遠端 API 問答支持預設模型：Qwen `qwen-plus`（日常）、`qwen3.8-flash`（快速）、`qwen3.8-max`（高階）；DeepSeek `deepseek-flash`、`deepseek-v4-pro`。不支持自訂名稱，IPC／Main 按服務商驗證預設清單；舊設定與 session 中的自訂型號回退到服務商預設值，既有 turn 保留歷史型號、回答與引用。翻譯專用 `qwen-mt-plus` 留在翻譯設定。
- DeepSeek 官方接口：Flash 顯式關閉 thinking；Pro 啟用 thinking，預留 32768 output tokens。SSE 僅把 content 當作回答，reasoning_content 不混入回答或歷史。本功能不使用 tools，後續輪次無須回傳 reasoning_content。
- 模型清單核對來源：[DeepSeek 模型](https://api-docs.deepseek.com/quick_start/pricing/)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)、[Qwen 官方清單](https://www.alibabacloud.com/help/en/model-studio/models)。區域可用性與真實 Key 需人工驗收。
- Main 在讀完上下文後再次檢查啟用狀態與憑據；401／403 使憑據失效，429 遵守 Retry-After。日志只記 provider、model、requestId、耗時、错误碼、token 数，不記問題、回答、片段或 Key。

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

## 4. 問答索引（切塊）

- 首次打開問答時 `chat:ensure-index` 依已登記的 parsed Markdown＋block mapping 計算 contentRevisionId 並排入 `rag-content-index` 作業；`compute:rag-content-index` 只跨進程傳 documentId／contentRevisionId。Utility 只讀已登記且屬於該文檔的 artifact，檢查 PathPolicy、普通文件與 hash；未登記／越界／內容不一致不可重試，臨時 I/O 可重試。
- `structureAwareChunker.ts` 複用 remark／GFM／math AST 與 block alignment，按 heading、paragraph、list、code、formula、table、caption、other 切塊；只拆超過 700 估算 token 的葉子，優先句子／詞邊界，不截斷代理對；offset 為 UTF-16、overlap 0。寬表拆分帶最小表頭且 confidence=range；無 mapping 時頁碼為空、confidence=none。策略改動須更新 chunker fingerprint。
- 全量 chunk 校驗後由 `SqliteRagRepository.replaceChunksAndActivate` 單事務發布並切換 active revision，舊 active 標為 stale；新 revision 失敗或取消保留舊 ready／100%，首次取消回 queued。切塊零網絡。

## 5. 證據、串流與 UI 契約

- `PaperContextBuilder` 只讀當前激活版本的 chunks。短文按原文順序提供全文；長文依次選固定選區及相鄰 chunk、摘要／引言、輕量詞法排名與大綱，去重並披露 truncated。默認 budget 48000 字元、wire 256 KiB。中文問題配長英文文獻的詞法檢索仍有限，優先使用固定選區；英語 query rewriting 為可選後續。
- 原文 quote／mapping／revision 必須匹配；譯文選區以 mapping 回到原文，只把譯文當未驗證參考。fragment offset 使用 UTF-16，保存引用 locator 與 provenance。
- 系統提示將 evidence、選區、歷史標為不可信資料；JSON escape < 和 >，不讓文本關閉 evidence delimiter。僅允許當前 evidence pack 中簽發的 E1… 引用；未知引用移除，最多 50 個。
- 每篇同時一個請求，替代請求取消前一個；最多 8 篇在途。服務商各有獨立 FIFO，不排在翻譯後面。首字節約 30 秒、stream idle 約 60 秒；回答 32768 字元上限，IPC delta 有界且按 50 ms 合併。
- 事件遵守 accepted → retrieving → evidence-ready → delta/citation → completed/failed/cancelled，帶 requestId、sequence。Renderer 校驗合法轉移、忽略重複／晚到事件、緩衝 ask 返回前的事件、停止後抑制晚到完成。
- 閱讀器只顯示原文 Markdown、中文 Markdown、AI 問答三個頁籤；不再展示 JSON 頁籤，底層 layout JSON 和 ZIP 資料仍保留。問答首次開啟才掛載面板及觸發 ensure-index；只打開論文不得建索引。「添加到對話」加入選區，不自動切換頁籤，最多 8 個。發送時選區隨問題移入該輪：輸入欄清空選區，turn JSON 以可選 `selections`（視圖、≤600 字預覽、頁碼）保存並顯示在問題上方；重試沿用該輪選區（僅記憶體中的完整 fragments，重開後重試不再附帶）。模型收到 `userSelections`（原文／譯文全文），系統提示說明「這段」等指代即該選區。舊 turn 無 `selections` 仍可讀；含此欄位的文件被更早版本讀取時會因 strict schema 拒絕整頁，降級不受支持。
- Enter 發送，Shift+Enter 換行，IME 不誤發；輸入框／模型選擇留在面板底部。停止後保留部分回答；失敗／取消可重試。引用按首次出現順序編號，點擊核對版本後定位來源，不添加懸停提示。
- SafeMarkdown 禁止回答中的外部圖片／可執行鏈接／script 網路副作用；只顯示經驗證引用和 KaTeX 公式。長回答僅在用戶接近底部時自動跟隨，尊重 reduced-motion。

## 5a. 圖片加入問答

2026-10-21 起取代「擴展自動圖片解讀」的方向：圖片由用戶主動加入問答，模型結合上下文逐子圖解讀。figureInsight（文庫封面選圖）保留原樣，不共用存儲。

- 入口：Markdown 原文／譯文每個圖組（`readerFigureGroups` 的 complete／ambiguous／unsupported 均可）在「查看 PDF」旁有「加入问答」，不切換頁籤，最多 4 張／問。PDF 視圖暫無入口（PdfPane 沒有圖區疊層）。
- 能力：`paperChatFigures.ts` 的 `paperChatImageInput`。Qwen 僅 `qwen3.8-flash`／`qwen3.8-max`，DeepSeek 僅 `deepseek-flash`，Codex 依模型目錄 `image`；目錄未知視為不可確認。當前模型不支持時，入口以 `aria-disabled` 變灰、點擊顯示原因（無懸停提示）；已加入的圖片保留在輸入欄，輸入欄顯示原因並禁止發送；Main 在保存 turn 前再次拒絕（`FIGURE_UNSUPPORTED`），從不靜默丟圖。
- 圖片來源：Utility `compute:paper-chat-figure` 按 figureId 重算幾何。complete 且 `figures.json` 裁圖經 figureInsight descriptor 校驗通過時送整圖；否則送該圖組解析出的子圖（`images/<name>.jpg|png`，最多 6 張，PathPolicy、格式頭與大小校驗）。只回傳路徑、大小、SHA-256；Main 重讀並比對雜湊後編碼（>2 MiB PNG 傳輸用 JPEG98），全部圖片 ≤14 MiB、請求 ≤20 MiB，首包等待 120 秒。
- 上下文：`PaperContextBuilder` 收到 `figures`（captionMappingIds、mappingIds、圖號 key）後，圖說 chunk 必選；全文中所有提及該圖號的段落（`figureMentions.ts`：Fig./Figs./Figure/图/圖、`(a)`／`1a`、`1–3` 範圍、Supplementary/Extended Data，不含 Fig. 10 或 configure 1）最多 24 段優先入選；其前後段落次之；章節路徑隨 evidence 傳遞。結果 `figures` 列出 caption／mention／nearby 的 E 編號與因預算略去的提及數。模型收到 `userFigures` 與按順序排列的圖片，提示要求逐子圖、結合正文並以 [E#] 引用提及段落；引用沿用既有可點擊定位。
- 歷史：turn JSON 可選 `figures`（figureId、label、pageIndex、images[path, sha256]），不存圖片位元組；session.json 可選 `figures` 保存輸入欄中的圖。之後的提問只在歷史問題前加「[附图：Fig. 1]」，不重送舊圖。重試按 figureId 重新解析。

兼容策略（shared schema／IPC／Core RPC）：`paper-chat:ask` 請求、`chat:build-context` 請求與結果、turn 與 session 文件均只新增可選欄位，舊客戶端／舊文件不受影響；新增 Core RPC `compute:paper-chat-figure` 與錯誤碼 `FIGURE_UNAVAILABLE`（只增不刪）。無 SQLite migration、無 IPC 通道增減。含 `figures` 的 turn／session 被更早版本讀取時會因 strict schema 拒絕，與 `selections` 相同，降級不受支持。恢復語義不變：圖片不可讀或雜湊不符時該輪以 FIGURE_UNAVAILABLE 失敗並保存，可重新加入圖片後重試。

驗收（2026-10-21，隔離資料目錄複製真實文庫的斷裂力學綜述，Codex gpt-6-luna）：加入 Fig. 1 直接發送，回答分 (a)(b) 解讀，引用圖說 [E73] 與 4.1 節中「Fig. 1 presents a comparison…」段落 [E76]，點擊引用定位到 PDF 第 8 頁圖說；舊 turn（無 figures）照常顯示。

## 6. 代碼與測試入口

| 邊界 | 入口 |
| --- | --- |
| 共享契約 | shared/paperChatSchemas.ts、paperChatStorageSchemas.ts、paperChatFigures.ts、figureMentions.ts、ragSchemas.ts、types.ts、coreRpcSchemas.ts |
| Main／Preload | main/chat/paperChatService.ts、paperChatIpc.ts、chatProvider.ts、main/index.ts、preload/index.ts |
| Utility | utility/core/paperContextBuilder.ts、persistence/paperChatFigureStore.ts、compute/structureAwareChunker.ts、compute/ragContentIndexService.ts、persistence/{paperChatStore,sqliteRagRepository}.ts、utilityOperations.ts；Main 側 ragContentIndexJobRunner.ts、rpcRagContentIndexer.ts |
| UI | renderer/usePaperChat.ts、usePaperChatRouting.ts、components/ReaderChatPanel.tsx、paperChat.css、MarkdownPane.tsx、pages/ReaderPage.tsx |
| 回歸 | paperChatContracts、paperChatService、figureInsightStore（圖片來源）、paperChatUtility、paperChatStore、chatProvider、ReaderChatPanel、paperContextBuilder、ragContracts、ragPersistence、ragContentIndexJobRunner、structureAwareChunker；e2e/paper-chat.spec.ts |

新增持久化回歸覆蓋：真實本地文件重新讀取、文獻隔離、45 輪分頁、完整引用／草稿／模型、取消和清空次序、損壞文件保留、目錄 junction 拒絕、Core RPC 全鏈路和 Renderer reload。E2E 用隔離 vault 與假 Key，只模擬 provider HTTP，不讀寫真人憑據或調用付費 API。

## 7. 驗證與真人验收

本地驗證、遠端授權與 CI 門禁遵循根 [AGENTS.md](../AGENTS.md)，此處只保留問答驗收場景。

人工驗收使用隔離資料目錄：兩篇文獻分別提問；退出應用並重開；驗證問題、回答、引用、草稿和模型保留；停止回答／清空後重開；備份或遷移後再讀取；更新解析版本後點舊引用。真實 Qwen／DeepSeek 的效果、延遲、模型區域可用性與 Windows 視覺／安裝體驗仍由真人驗收，假 HTTP 與 CI 綠燈不能替代。

Codex 例外：不使用 API Key，驗證本機登入並從目錄取得模型；不可用時提示手動重選，保留 session 原型號，不自動回退。兩條隊列、隔離和 migration 5 的兼容／恢復見 [架構](ARCHITECTURE_ZH.md#codex-provider本机-app-server)。

閱讀器頁籤顯示 Chat／原文／译文，底層 view ID 不變。回答元信息只顯示模型、時間及 Token，用時仍可作底層診斷但不顯示。SafeMarkdown 在 Markdown 解析前共用 normalizeMathDelimiters，將完整的 TeX 括號分隔符轉為 $／$$，避開代碼和 HTML；舊回答直接按新規則渲染，不重寫原文。

每条问题右侧「⋯」提供折叠／展开回复及删除聊天；折叠只改变当前展示，保留问题，隐藏回复及其元信息。删除需使用现有 Ant Design Modal 再次确认，成功后从内存和该论文 chat/ 对应 turn JSON 删除，草稿及其他 turn 保留。新增受校验的 paper-chat:delete-turn IPC、chat:delete-turn Core RPC，以 documentId＋turnId＋createdAt 定位，校验记录归属并拒绝链接；删除生成中的目标需先等待取消落盘，防止晚到写入。createdAt 可选加入 ask 结果，使刚完成／停止的回复使用 Main 的真实文件标识，旧客户端兼容。无 SQLite migration。默认阅读器分栏 50/50，旧默认 100/2.05 升级为居中，自定义比例保留。此次按既有用户要求不运行测试。
