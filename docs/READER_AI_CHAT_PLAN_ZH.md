# 單篇論文問答契約

僅當前論文、選區、流式回答、停止、Markdown／KaTeX 與驗證引用；不聯網、不執行工具、不讓模型讀本機文件。模組 API／資料表／測試入口見 [chat README](../desktop/src/features/chat/README.md)，Codex 隔離及 migration 5 見 [架構](ARCHITECTURE_ZH.md#codex-provider本机-app-server)。多論文／向量 RAG 已放棄，單篇切塊索引仍在用，不合入舊 demo schema 5–7。

## 服務商與隊列

預設使用啟用的翻譯服務商；問答可獨立選已啟用 Qwen／DeepSeek 預設模型或 Codex 目錄模型，不改翻譯設定。預設清單與圖片能力以 contract 為準，不接受任意型號；舊自訂型號回退預設而保留 turn 歷史，舊 chatProvider 不參與路由，省略 request.provider 沿用翻譯。Codex 缺模型時保留 session 型號並要求重選，不靜默切模型／供應商。

Main 讀完上下文後再驗啟用與憑據；失效／未驗 Key 不發送，401／403 使憑據失效、429 遵守 Retry-After。DeepSeek Flash 關 thinking、Pro 啟 thinking 預留32768 output tokens，SSE 只把 content 當回答，不混 reasoning_content。日誌只記分類、模型、requestId、耗時／用量，不記問答內容或 Key。

每篇一請求，替代先取消，最多8篇在途。交互獨立 FIFO，不排后台生成之後；雲端 background 每服務商最多8串流、共享冷卻及憑據失效。排隊可取消，首字節計時從真正 HTTP 發送開始，文字30s／圖片120s，stream idle60s，回答≤32768字元，IPC delta 每50ms有界合併。

## 本地記錄與恢復

文獻 chat/session.json 保存草稿、選區、模型；<毫秒>-<requestId>.json 為每輪 version1，保存問題、回答、驗證引用、provider/model、時間／狀態，不存 Key 或完整 evidence pack。可選 completedAt／durationMs／usage 兼容舊資料，未知用量不記0；UI 顯示模型、時間、Token，用時僅診斷。

Utility 依 DB 登記 storage_path、PathPolicy 驗文獻／檔名歸屬、普通文件及無鏈接，每篇序列化原子保存。先存問題才開始，成功落盤才 completed，串流約每秒 checkpoint，取消／失敗保留部分回答。退出等取消落盤；異常 pending 恢復 cancelled、不自動重發付費請求，最後未落盤增量不保證恢復。

缺目錄回空，不建索引；壞檔／不支持版本報錯保留，不覆蓋。成功恢復才啟草稿自存，切篇忽略晚到結果。歷史每頁≤20輪／256KiB keyset，不裁掉舊輪；模型近期歷史≤6組／24000字元，不作論文 evidence。備份／遷移含完整 chat，維護／刪文獻／退出前先取消等待落盤。

清空只刪該文獻已識別 turns，保留草稿、選區、其他文獻及來源。刪單輪經 paper-chat:delete-turn／chat:delete-turn，documentId＋turnId＋createdAt 校驗歸屬／拒絕鏈接，活動輪先等取消落盤。ask 結果 createdAt 可選兼容舊客戶端。折疊僅改展示；刪除須現有 Modal 確認。無 SQLite migration。

## 索引與 evidence

首次顯示問答才 ensure-index；普通開論文不建索引。依登記 parsed Markdown／mapping 的 revision/hash 建 rag-content-index，RPC 只傳 documentId／revision，Utility 驗安全路徑與 hash。來源不一致不可重試，暫時 I/O 才可。

structureAwareChunker 共用 AST／mapping，按語義塊切，僅>700估計tokens葉子再按句詞拆；UTF-16 offsets、overlap0，不斷代理對。寬表帶最小表頭 confidence=range，無 mapping 頁碼空／confidence=none；策略改變更新 fingerprint。全量校驗後一事務切 active revision，失敗／取消保留舊 ready，首次取消回queued，切塊不聯網。

PaperContextBuilder 只讀當前 active chunks；短文原序，長文選區／相鄰、摘要引言、詞法排名及大綱，去重並披露 truncated。預設48000字元／wire256KiB；跨語言檢索有限，優先明確選區。原文 quote／mapping／revision 要匹配，譯文選區回原文，譯文只作未驗參考；引用保留locator／provenance，舊引用版本不符不可導航。

evidence／選區／歷史皆不可信，JSON escape <／>；只接受當次簽發 E#、未知移除、最多50引用。引用存在或數字匹配不等於科學結論正確，不用 mapping ID 作跨文獻身份。

## 事件、選區與展示

事件 accepted→retrieving→evidence-ready→delta/citation→completed/failed/cancelled，帶requestId／sequence；Renderer 驗轉移、去重、緩衝 ask 返回前事件，取消後抑制晚到完成。

問答在四視圖工作台內，頁籤名 Chat／原文／译文，view ID 不變，無 JSON 視圖但保留產物。加入選區不切頁籤、最多8個；發送時移入 turn，可選 selections 存視圖／≤600字預覽／頁碼，完整 userSelections 給模型。重試用記憶體 fragments，重開後不重附完整選區。

Enter發送／Shift+Enter換行，IME不誤發；輸入與模型選擇固定底部。停止保留部分回答，失敗可重試；引用按首次出現編號、點擊驗版本定位、不加懸停提示。只在接近底部時跟隨。SafeMarkdown 禁外部圖片／可執行連結／script 副作用，數學分隔符只作顯示歸一化、避開code／HTML，不改歷史正文。

## 圖片加入問答

- Markdown 圖組右鍵加入（complete／ambiguous／unsupported皆可），不切頁籤，每問≤4組；PDF 暫無入口。不支持image的模型入口停用並顯示原因，保留已加圖片、禁止發送；Main 保存 turn 前再驗，FIGURE_UNSUPPORTED，不靜默丟圖。
- compute:paper-chat-figure 重算幾何：complete且descriptor驗證成功用整圖，否則用該組解析子圖≤6張。Utility 只回受控 path／size／SHA-256，Main 重讀驗 hash。>2MiB PNG 可用JPEG98且僅在更小時採用、不改像素或原圖；全部圖片≤14MiB、請求≤20MiB。
- evidence必含圖說，正文圖號提及最多24段優先、相鄰段次之，含章節路徑與caption／mention／nearby E編號、預算略去數。userFigures＋圖片要求逐子圖並引正文；不能把 Fig.10／configure1 認成 Fig.1。
- turn/session 可選 figures 保存figureId／label／頁碼／image path+hash，不存bytes；後續輪只給附圖文字、不重送舊圖，重試重新解析。不可讀／hash不符以FIGURE_UNAVAILABLE保存失敗，可重新加入再試。
- IPC／chat:build-context只增可選欄位，新增compute:paper-chat-figure、無SQLite migration。新schema讀舊資料兼容；更早strict客戶端會拒絕含selections／figures的文件，不能宣稱降版安全。

## 驗證邊界

測試覆蓋跨文獻隔離、真實文件重讀／分頁、引用版本、草稿模型、取消清空刪除順序、壞檔保留、junction拒絕、RPC與renderer重載。E2E僅mock provider HTTP、隔離vault，不用真人Key。真人驗收在隔離副本測兩篇提問→重開→停止／清空／刪輪→備份遷移→更新解析後舊引用；真服務品質、區域、延遲及GUI須獨立驗收，歷史成功不代表當前構建。
