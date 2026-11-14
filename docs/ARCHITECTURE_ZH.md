# 桌面架構與平臺契約

## 程式碼與程序

Windows x64 Electron 客戶端；PDF 經 MinerU 線上解析，模型服務負責翻譯、問答及解讀，沒有本地解析引擎。模組邊界見 [ADR-0001](adr/0001-feature-modules.md)，具體 API 讀 desktop/src/features/<模組>/README.md。

`Renderer → Preload → Main → Core RPC → Utility`

- Renderer：React／PDF／Markdown／3D；contextIsolation=true、nodeIntegration=false、sandbox=true、webSecurity=true。不能碰 Node、SQLite、憑據或任意本機路徑。
- Preload：固定路徑、最小 window.copilotix 領域 API，雙端 Zod 驗證；不暴露通用 IPC／檔案／網路能力。
- Main：視窗、許可權、Electron net、Credential Vault、模型請求、作業協調；不持有 SQLite 或執行重計算。
- Utility：唯一 SQLite 與計算擁有者，透過小型 descriptor／ID 傳遞產物。RPC 不傳 PDF、ZIP、完整 Markdown、Buffer 或 stream。

Main 驗證 sender 為應用自己的視窗（主視窗或由 `window:open-document` 開的閱讀視窗）、主 frame、精確允許 origin；渲染頁不能自行導覽或開視窗，閱讀視窗的論文由 Main 經 `window:initial-document` 交付，不放在 URL。Key 只進原生憑據庫，不進 DB、renderer、備份、結果或日誌。日誌遮蔽認證和預簽名 URL，不記正文、圖片或上游敏感錯誤。來源內容皆不可信。

## IPC／Core RPC

IPC／事件雙端驗證，結果為 `{ok:true,value}` 或 `{ok:false,error:{code,message,retryable,traceId?}}`，不洩漏 stack／secret。各功能 contract/ipc.ts 宣告頻道，Main IpcRegistrar 與 preload createDesktopApi 組合。

CORE_RPC_VERSION=1，UUID requestId、固定 operation、嚴格 payload／result schema；UTF-8 payload 與 envelope 各 ≤1MiB，拒絕 typed array、迴圈及非 JSON。模組 contract/rpc.ts 經 app/contract/coreRpc.ts 組合，platform 不識業務。取消綁 requestId；握手 10s、一般請求 30s、compute 10min。

Utility 分 data、compute 與獨佔生命週期通道；init／flush／close／文庫維護阻擋兩者，compute:hash-file 走 data 例外。SQLite 事務回撥不得 await。tasks:list／documents:list 使用 `(createdAt DESC,id ASC)` keyset，每頁 ≤200 行／512KiB，Main 逐頁讀，不新增隨文庫無界增長的 RPC。

Supervisor 拒絕故障中的請求、重綁代理，重啟退避 250ms／1s／4s、最多 3 次。退出先 drain、flush、close，截止後才終止。高頻作業事件以 documentId 合併重新整理；Renderer 保持 blocks／annotations 穩定引用。

## 持久化與原子性

- userData：`%APPDATA%\Copilotix-Translation-v2`；DB：`copilotix-desktop-v2.sqlite3`。
- 文獻：`<outputRoot>/documents-v2/<UUID>/`，含 original.pdf、full.md、full.zh-CN.md、layout.json、block_list.json、content_list.json、images 及各功能產物；顯示名不是目錄身份。
- DatabaseSync、WAL、foreign_keys、STRICT；schema_migrations 的 version／name／checksum 不可修改歷史。遷移前快照，待執行遷移同一事務、錯誤回滾，高於程式版本的 DB 拒絕開啟。不得合入舊 RAG demo schema。
- PathPolicy 同時驗 lexical 與 real containment，拒絕 NUL、絕對／越界路徑、symlink／junction 與不安全檔案；renderer 經受控 copilotix-asset ID 讀資源。
- Artifact：受控 staging → 串流限額／hash → fsync → atomic rename → 回驗 → DB revision；不可先發布 DB 或原地覆寫半成品。Windows rename 對暫時鎖定有界重試，永久錯誤不能改用 copy/delete 掩蓋。

## 工作流與資料流

作業持久化 queue／lease owner／heartbeat／checkpoint CAS，同文件 parse／translate 不重複活躍；崩潰按 lease 恢復並有界重試。網路暫時錯誤可重試，協定錯誤不可；人工重試重置失敗塊、保留完成塊。維護／退出先取消並等待聊天落盤。

PDF 匯入上限 200MiB，串流 hash／複製、不改原檔。可選跳過首頁重寫上限 64MiB，單頁／加密失敗回 CORE_PDF_REWRITE_FAILED。Main 提取暫定命名並 checkpoint；解析後只能替換未經使用者覆寫的標題。正式只支援 PDF；未來 Markdown 匯入須顯式 sourceFormat、回填舊資料並走獨立 canonical artifact，不長期猜副檔名。

Parser Token 只送固定 API origin，不送預簽名上傳來源。下載 ZIP 在受控 staging 防穿越、歸一化、驗 hash 後發布；layout 頁碼由共用 normalizer 統一零基。翻譯分塊、表格 ID、重試、編輯與匯出見 [Markdown 契約](MARKDOWN_FORMAT_ZH.md) 及 translation README。

問答保留單篇 rag_documents／rag_content_revisions／rag_chunks 與 rag-content-index 作業。schema 4 語義／向量殘表僅作 migration／刪除相容，不恢復 embedding 或多文獻 RAG；身份綁 document／artifact revision／hash，不能只用 mapping ID。詳見 [問答](READER_AI_CHAT_PLAN_ZH.md)。

## Codex provider（本機 App Server）

- platform/codex/runtime 以無 shell 的 `codex.exe app-server --listen stdio://` 呼叫 CLI 0.159.x；chat ModelGateway 共用於翻譯、問答、Brief、圖片解讀，不取代解析或提供 embeddings。模型／視覺／推理能力取實際目錄，缺模型顯式失敗。
- 每次請求新 ephemeral thread；互動獨立 FIFO，背景最多 8 個單請求程序槽，槽內可復用程序但不復用論文會話。閒置 30s、連線／協定錯誤或退出關閉；正常 failed turn 可留供重試。
- 會話覆蓋禁 shell、MCP、應用、外掛、瀏覽器、搜尋、記憶、子代理；只讀沙箱、無持久歷史、忽略專案文件並讀回隔離配置，不改使用者配置。工具請求拒絕並終止。
- 初始化 15s、生成空閒 120s、總計 10min；排隊取消立即完成，執行 interrupt 後 5s 終止。空結果、非成功完成、工具嘗試不得視為成功。
- 429／限流／過載共享冷卻 5s 起指數退避至 60s＋抖動，並發減半至 1、成功逐槽恢復至 8。同冷卻窗只減一次；僅背景且無部分輸出最多 6 次。互動、部分輸出、登入／額度／上下文／其他 4xx 不重試；暫時連線及 5xx 按分類處理。診斷只記分類、次數、耗時和槽位。
- 同作業 signal 的短翻譯每批 ≤16組／64片段／約8K字元，超長組獨發不截斷；本地對映短 ID、逐單元及表格校驗。翻譯 low、Brief medium 在 thread 與 turn 均生效。翻譯失敗可按已啟用順序回退，Brief 可回退 Qwen／DeepSeek（上下文超限除外）；問答／圖片解讀不回退。實際 provider/model 落盤，回退標記不混入正文。
- migration 5 add-codex-provider 擴充套件 documents／translation_blocks／translation_cache 約束，1–4 不變；僅事務外暫關 FK，複製／索引／提交前 FK check，失敗回滾恢復。降版需遷移前快照；chat／insight JSON 新列舉不改既有內容。
- 連線快照 userData/codex-runtime/connection-status.json 原子存最多 8 組路徑／推理強度／模型狀態，不存 token、不改登入檔；啟動恢復後背景檢查，不自動發模型測試。版本變更不繼承驗證，損壞重檢。

## 驗證與專項入口

[開發測試](DESKTOP_DEVELOPMENT_ZH.md)、[打包／安裝／簽章](DESKTOP_RELEASE_ZH.md)、[UI](UI_PREFERENCES_ZH.md)、[未決事項](MILESTONE_1_3_ZH.md)。本地、mock、CI、真實付費服務、原生 GUI／GPU 分開宣告；packaged CLI smoke 不啟動 renderer，不代表 GUI 透過。macOS／Linux 尚無發布驗收。使用已配置服務即同意傳送該功能所需內容，舊 chatConsent 僅作 wire 相容，不恢復獨立同意開關。

## 1.3.1 共用內容與模型基礎

[document](../desktop/src/features/document/README.md) 擁有文件區塊、來源版本、對映、圖組與編輯投影，Utility 按需建立可重建模型，Main／Renderer 透過受控描述與資源協定讀取。舊格式保留在集中相容層，模型變更不全庫遷移。

[platform/models](../desktop/src/platform/models/README.md) 共用連線健康與預算，首次與冷卻後僅一個真實請求試探；輸入錯誤／取消不傷害連線，部分輸出不重放。模型傳輸失敗不再疊加業務／作業重試；解析網路作業沿用原恢復規則。

文庫事件以 sessionId／revision 及 documentId／變化類別／內容版本更新，進度只讀單篇摘要。正文、譯文與編輯各自失效，全庫預熱與完整封面門檻不變。Bing／TranSmart 僅保留歷史來源身份，不再執行新請求。
