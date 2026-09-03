# MinerU Desktop Demo 架構與二次開發指南

> 本文是目前 demo 版本的權威開發導覽。`master` 是本地整合主線；新功能在独立 `feature/*` 分支/worktree 中实现，所有结论以已标注提交与已验证产物为准。

## 1. 文檔基線

| 項目 | 當前值 |
|---|---|
| 倉庫 | Kumiko-kmk/MinerU |
| 主開發分支 | master |
| 基線 | `master@10225a1`（合并提交 `10225a12c88ac0c4fb1107aa28e3fb5ca28e98b2`） |
| 本地分支策略 | `master` 為整合主線；功能使用 `feature/*` 独立分支与 worktree |
| 當前能力 | UI/Reader 改造、表格翻译/Reader 标注、目录版发布治理、解析后英文标题命名 |
| Desktop 版本 | 0.1.0 |
| Python MinerU 版本 | 3.4.5 |
| 當前發布目標 | Windows 10/11 x64；macOS 尚未接入發布鏈路 |
| Node.js | 24.11.1；package.json 約束為 24.x |
| pnpm | 11.19.0 |

後續功能从 `master@10225a1` 创建独立分支后分阶段完成；高風險操作先建立 bundle、patch 或資料備份。`desktop/dist*` 不再是合法發布位置，正式產物只允許由 `pnpm desktop:release` 寫入根目錄 `release/`。

## 2. 最重要的架構結論

現在的 demo 是 Electron 桌面客戶端，不是 Python 客戶端的簡單包裝，也不會在運行時啟動本倉庫中的 mineru-api 或本地模型。

實際產品鏈路是：

    Windows 用戶
      -> Electron Renderer（React UI）
      -> Preload 暴露的 window.mineru
      -> Electron Main（任務、文件、密鑰、網絡）
      -> MinerU 官方 API v4
      -> 下載官方 ZIP 結果
      -> 本地標準化、版面映射、Markdown 翻譯
      -> PDF / Markdown 雙欄閱讀器

倉庫中的 mineru/、pyproject.toml、docker/、docs/ 等 Python MinerU 代碼仍被保留，但對桌面 demo 的當前運行和 EXE 打包沒有直接依賴。除非未來明確實現“本地解析模式”，否則修改 Python backend 不會改變桌面 demo 的解析結果。

因此後續開發必須先判斷需求屬於哪一層：

1. Desktop 產品層：desktop/，目前 demo 的主要開發範圍。
2. 遠端服務契約層：官方 MinerU API v4，客戶端只能適配，不能在本倉庫內改變服務端行為。
3. Python 引擎層：mineru/，目前不進入桌面運行時。

## 3. 工作區結構

| 路徑 | 角色 | 是否進入 Desktop EXE |
|---|---|---|
| desktop/src/main | Electron 主進程、任務與服務層 | 是 |
| desktop/src/preload | 安全 IPC 橋接 | 是 |
| desktop/src/renderer | React/Ant Design 界面與閱讀器 | 是 |
| desktop/src/shared | 主進程與渲染器共享類型和純函數 | 是 |
| desktop/resources | 圖標等桌面資源 | 是 |
| desktop/tests | Vitest 單元測試 | 否 |
| desktop/e2e | Playwright/Electron 端到端測試 | 否 |
| desktop/scripts | 可重現的目錄版打包與發布驗證腳本 | 構建輸入 |
| desktop/package.json | 依賴、腳本、electron-builder 配置 | 構建輸入 |
| package.json | workspace 統一命令與 Node/pnpm 約束 | 構建輸入 |
| pnpm-lock.yaml | 可重現依賴鎖 | 構建輸入 |
| .github/workflows/desktop-windows.yml | Windows CI 與發布 | 否 |
| release | 唯一正式發布目錄；運行目錄、ZIP、manifest、校驗值 | 生成產物，不入 Git |
| mineru | Python 解析引擎 | 當前否 |
| pyproject.toml | Python 包與 CLI/API 入口 | 當前否 |
| docs、docker、demo、tests | 上游 Python 項目資料 | 當前否 |

## 4. Desktop 技術棧

| 層 | 主要技術 |
|---|---|
| 桌面容器 | Electron 37、electron-vite 4 |
| UI | React 19、Ant Design 5 |
| PDF | pdfjs-dist 5 |
| Markdown | unified、remark、react-markdown |
| 任務併發 | p-queue |
| 本地數據 | Node 內建 node:sqlite，WAL 模式 |
| 憑證 | @napi-rs/keyring，Windows Credential Manager |
| ZIP | extract-zip、archiver |
| 類型檢查 | TypeScript 5 |
| 單元測試 | Vitest 3 |
| E2E | Playwright 1.55 |
| 打包 | electron-builder 26 目錄目標、archiver ZIP、extract-zip 驗證 |

### 4.1 Phase 3A1 進度（Utility RPC）

Phase 3A1 已建立 strict Zod Core RPC envelope、transport-agnostic client、具重啟/優雅關閉的 Electron utility supervisor，以及獨立 `desktop/src/utility` entry。RPC 目前只開放 `ping`、`cancel`、`drain`、`shutdown` 控制操作；資料庫與 compute operation registry 留待後續階段擴充。這一階段尚未完成 DB 隔離：`DatabaseSync` 仍由 main process 持有，沒有把既有資料庫或 migration 移入 utility process。

### 4.2 Phase 3A2 进度（Persistence / Compute 隔离）

Phase 3A2 已将 SQLite、迁移、兼容 repository 与文件 hash、解析结果归一化、block mapping 放入 utility；main 仅通过严格、异步 RPC proxy 访问，并在 utility 重启后重新初始化。RPC 不传 PDF、ZIP、完整 Markdown、HTML 或 Buffer，数据库操作在 utility 内串行化。Scheduler 尚未完成，任务队列仍由现有 TaskService 管理。

### 4.3 Phase 3B1 进度（Durable Job Scheduler Foundation）

Phase 3B1 已加入独立 durable job repository、租约/心跳、依赖门控、过期恢复、重试退避与可测试 scheduler 基础；main 目前只初始化 scheduler，尚未注册真实 parse/translate runner，也不会 claim 作业。TaskService 接管与真实 runner 接入留在 Phase 3B2。

electron-vite 与独立 Vite 配置生成四份 bundle：

    desktop/src/main       -> desktop/out/main
    desktop/src/preload    -> desktop/out/preload
    desktop/src/renderer   -> desktop/out/renderer
    desktop/src/utility    -> desktop/out/utility

electron-builder 再把 out、desktop/package.json 和圖標打入 ASAR 與完整 Windows 運行目錄。@napi-rs/keyring 被 asarUnpack，以便原生模塊正常載入；不再生成安裝器或自解壓 portable。

## 5. Electron 進程與安全邊界

### 5.1 主進程

入口是 desktop/src/main/index.ts。bootstrap 在 app.ready 後建立：

1. 獨立 userData 目錄。
2. TaskRepository。
3. WindowsCredentialVault。
4. SettingsService。
5. OfficialMinerUClient。
6. JsonLineLogger。
7. TaskService。
8. mineru-asset 自定義協議。
9. IPC handler、主窗口與系統托盤。

Windows 正常數據目錄：

    %APPDATA%\MinerU-Translation
      mineru-desktop.sqlite3
      mineru-desktop.sqlite3-wal
      mineru-desktop.sqlite3-shm
      mineru-desktop.log

測試環境可以用 MINERU_E2E_USER_DATA 指向隔離目錄。

主窗口安全選項：

- contextIsolation = true
- nodeIntegration = false
- sandbox = true
- webSecurity = true

窗口關閉時默認隱藏到托盤，任務隊列繼續運行；只有托盤“退出”或應用退出流程會真正關閉數據庫。

### 5.2 Preload

desktop/src/preload/index.ts 是 renderer 唯一允許的特權入口。它用 contextBridge 暴露 window.mineru，不向前端暴露 Node.js、文件系統、SQLite、Token 或任意 ipcRenderer。

任何新增 IPC 都應同步修改：

1. desktop/src/shared/types.ts 中的 MinerUDesktopApi。
2. desktop/src/preload/index.ts 的 invoke 或事件包裝。
3. desktop/src/main/index.ts 的 ipcMain handler。
4. 對應主進程服務。
5. IPC 的成功、失敗和輸入驗證測試。

不要讓 renderer 傳入任意本地路徑後直接讀寫；應由主進程對路徑來源和作用域進行驗證。

### 5.3 Renderer

desktop/src/renderer/App.tsx 使用本地 React state 切換頁面，沒有 React Router。現有視圖：

| 視圖 | 文件 | 職責 |
|---|---|---|
| 新解析 | pages/NewParsePage.tsx | 選擇/拖放 PDF、模型和翻譯源 |
| 任務管理 | pages/TasksPage.tsx | 搜索、篩選、進度、重試、刪除 |
| 設置 | pages/SettingsPage.tsx | Parser Token、輸出目錄、解析與翻譯配置 |
| 閱讀器 | pages/ReaderPage.tsx、components/ReaderTextPane.tsx | PDF、原文 Markdown、譯文、layout JSON |

ReaderPage 採用 React.lazy 延遲載入，避免初始頁面立即載入 PDF.js。

## 6. IPC 公共契約

共享類型集中在 desktop/src/shared/types.ts。當前 IPC：

| IPC | 前端方法 | 主進程結果 |
|---|---|---|
| settings:get | getSettings | AppSettings |
| settings:save | saveSettings | AppSettings |
| settings:test-parser | testParserConnection | HealthResult |
| settings:test-translation | testTranslationProvider | HealthResult |
| dialog:output-directory | chooseOutputDirectory | 路徑或 null |
| dialog:pdfs | choosePdfs | SelectedPdf[] |
| dialog:inspect-pdfs | inspectDroppedPdfs | SelectedPdf[] |
| tasks:create | createTasks | MinerUTask[] |
| tasks:list | listTasks | MinerUTask[] |
| tasks:retry | retryTask | void |
| tasks:delete | deleteTask | void |
| document:get | getDocument | DocumentPayload |
| reader-annotations:get | getReaderAnnotations | ReaderAnnotation[] |
| reader-annotations:replace | replaceReaderAnnotations | ReaderAnnotation[] |
| document:open-output | openOutputDirectory | void |
| document:save-as | saveAs | 保存路徑或 null |
| tasks:changed | onTasksChanged | 主進程推送任務列表 |
| tasks:open | onOpenTask | 通知 UI 打開指定任務 |

AppSettings 只向前端返回 hasParserToken、qwenHasApiKey、deepseekHasApiKey 三個布爾值，不返回真正密鑰。

MinerUTask 是 UI、SQLite、任務服務和 API 適配器共同使用的數據契約。新增狀態或字段時必須同步：

- shared/types.ts
- database.ts schema、toTask、insert/update
- taskService.ts 狀態轉換
- TasksPage.tsx 標籤與操作
- ReaderPage.tsx 狀態提示
- 單元/E2E 測試

## 7. 任務生命週期

桌面狀態機：

    uploading
       |
       v
    parsing
       |
       v
    translating
       |
       +-------> completed
       |
       +-------> partial

    任一活動階段 -------> failed

各階段的進度分配：

| 階段 | 進度 |
|---|---|
| 本地建檔/上傳 | 0–8 |
| API 已接收 | 約 10 |
| 遠端解析 | 12–40 |
| 遠端完成/本地下載 | 42 |
| 翻譯開始 | 45 |
| 翻譯區塊進度 | 45–100 |
| completed/partial | 100 |

應用在 uploading、parsing 或 translating 未完成時退出，下一次啟動的數據庫遷移會把這些任務標記為 failed，提示用戶手動重試；目前沒有自動恢復全部在途任務。

partial 表示解析成功，但至少一個 Markdown 區塊的翻譯失敗。原文及成功區塊仍可閱讀，重試會利用已保存的區塊結果和翻譯緩存。

## 8. 新建與批次調度

主實現在 desktop/src/main/taskService.ts。

### 8.1 輸入約束

- 當前只接受 PDF。
- 單文件最大 200 MiB。
- inspectPdfs 對整個文件做 SHA-256。
- 默認根據 sourceHash 阻止重複任務，可由 createDuplicates 覆蓋。
- 任務建立時把來源複製為任務目錄中的 original.pdf，後續不再依賴原始外部路徑。
- `originalName` 永久保存用户选择的原始文件名；解析前 `name` 为原文件名、`title` 为空。
- `normalizeParserOutput` 完成后优先从 `block_list.json` 的首个非 discarded `title` 块提取英文标题，Markdown heading 仅作兜底；安全化后将 `name` 更新为 `<title>.pdf`，`title` 不含扩展名。
- 新任务输出目录从原文件名目录移动为 `<安全标题>-<taskId>`，并同步更新 `outputDir`、`sourcePath`。目录移动失败时保留原路径并继续任务；历史任务不启动时批量改名。

刪除實體文件前，TaskService 會 resolve 輸出根與任務目錄，拒絕刪除輸出根本身或根以外的路徑。

### 8.2 併發

| 隊列 | 併發 |
|---|---:|
| 批次處理 queue | 2 |
| 每批上傳 uploadQueue | 3 |
| 結果下載/後處理 resultQueue | 3 |
| MinerU 單批文件數 | 最多 50 |

MINERU_BATCH_SIZE 和 MAX_PDF_BYTES 位於 desktop/src/shared/constants.ts。修改這些值前要核對官方 API 限制。

### 8.3 重試

- 若已有 remoteBatchId 和 remoteDataId，先查詢原批次。
- 遠端已 done：直接下載與後處理。
- 遠端 waiting-file 或 failed：清除遠端信息並重新申請上傳。
- API 返回 -60012 或 -60013：視為批次不存在/不可恢復，重新上傳。
- 其他錯誤：標記 failed。

## 9. 官方 MinerU API v4 適配

desktop/src/main/parserClient.ts 固定使用：

    https://mineru.net

Token 驗證：

    GET /api/v4/extract-results/batch/00000000-0000-0000-0000-000000000000

申請批次與預簽名地址：

    POST /api/v4/file-urls/batch

查詢批次：

    GET /api/v4/extract-results/batch/{batch_id}

申請批次的主要 JSON 字段：

| 字段 | 來源 |
|---|---|
| files[].name | PDF 文件名 |
| files[].data_id | 本地 task UUID |
| files[].is_ocr | forceOcr |
| model_version | vlm 或 pipeline |
| enable_formula | formulaEnabled |
| enable_table | tableEnabled |
| language | ocrLanguage |

本地 task UUID 同時作為官方 data_id，這使批次結果可以直接映射回本地任務。

安全和超時：

- API Token 只加到固定 mineru.net API 請求。
- 上傳 URL 和結果 URL 必須是 HTTPS。
- 預簽名上傳使用 PUT，credentials=omit，不添加 Authorization。
- 申請批次超時 30 秒。
- 上傳超時 10 分鐘。
- 輪詢初始 2 秒，逐步增加，最高 10 秒。
- waiting-file 最長等待 2 分鐘。
- 單批總等待最長 6 小時。
- 結果下載超時 10 分鐘。
- 下載後檢查 ZIP 的 PK 文件頭。

官方狀態契約：

    waiting-file | pending | running | converting | done | failed

未知狀態會直接報錯，避免把新服務狀態錯當成成功。

## 10. Parser 結果標準化

官方結果 ZIP 下載到任務目錄後：

1. 暫存為 .mineru-result.zip。
2. 解壓到 .parsed。
3. 刪除臨時 ZIP。
4. 尋找第一個 Markdown。
5. 尋找以 layout.json 或 middle.json 結尾的 JSON。
6. 可選尋找 content_list 或 content_list_v2 JSON。
7. 複製圖片等媒體資產。
8. 生成 block_list.json。

標準化後的穩定文件名：

| 文件 | 用途 |
|---|---|
| original.pdf | 任務自己的 PDF 副本；改名功能不会物理重命名它，`mineru-asset://{taskId}/original.pdf` 保持兼容 |
| full.md | MinerU 原始 Markdown |
| full.zh-CN.md | 本地翻譯結果 |
| layout.json | 官方 middle/layout JSON |
| content_list.json | 可選的內容列表 |
| block_list.json | PDF 與 Markdown 邏輯區塊映射，當前版本 2 |
| translation.checkpoint.json | 翻譯進度和失敗區塊 |
| translation.manifest.json | 區塊 provider/model/status 摘要 |
| .parsed | 官方 ZIP 的解壓內容，目前會保留 |

“另存為結果 ZIP”會打包整個任務輸出目錄，因此目前也會包含內部 .parsed 目錄。若未來要區分用戶交付包與調試包，應在 TaskService.createResultZip 中顯式定義白名單。

## 11. SQLite 持久化

desktop/src/main/database.ts 使用 node:sqlite 的 DatabaseSync：

- journal_mode = WAL
- foreign_keys = ON

表：

| 表 | 作用 |
|---|---|
| settings | 非敏感配置鍵值 |
| tasks | `originalName`（不可变上传/溯源名）、`title`（安全英文标题）、当前 `name`、状态、远端 ID 与路径 |
| translation_runs | 每個任務的總數、成功數、失敗數 |
| translation_blocks | 區塊級來源、譯文、provider、狀態 |
| translation_cache | 跨任務翻譯緩存 |
| reader_annotations | 原文/譯文視圖標註、UTF-16 區間與 quote/context 錨點 |

tasks、translation_runs、translation_blocks、reader_annotations 之間使用外鍵和 ON DELETE CASCADE。刪除任務記錄會刪除其翻譯運行、區塊與閱讀標註，但全局 translation_cache 不會隨任務刪除；標註不進任務輸出文件或結果 ZIP。

當前遷移方式是 CREATE TABLE IF NOT EXISTS 加 PRAGMA table_info/ALTER TABLE；`original_name` 和 `title` 的新增在事务中执行，旧行回填 `original_name=name`、`title=NULL`。若 schema 繼續演進，建議引入顯式 schema_version 和順序遷移；不要依賴應用啟動時猜測所有歷史狀態。

## 12. 憑證、設置與日誌

### 12.1 憑證

目前 Windows 發布將以下內容保存在 Windows Credential Manager，service 名為 MinerU-Translation；`CredentialVault` 是未來跨平台 adapter 的邊界：

- parser-token
- qwen-api-key
- deepseek-api-key

SQLite 只保存公開配置。SettingsService 會從傳入更新中分離密鑰，再把公開字段寫入數據庫。

`reader_annotations` 按 task、original/translated 視圖、穩定 Reader block key 和 UTF-16 文本區間保存閱讀標註。任務刪除時由外鍵級聯清理；renderer 只能經過經驗證的全視圖事務替換 IPC 讀寫，標註不進任務輸出文件或結果 ZIP。

### 12.2 公開設置

主要設置：

- outputRoot
- parserModel：vlm 或 pipeline
- forceOcr
- formulaEnabled
- tableEnabled
- ocrLanguage
- translationProvider
- Qwen/DeepSeek base URL 和 model

舊的 hybrid-engine 設置值在讀取時會回退為 vlm。

### 12.3 日誌

JsonLineLogger 寫入 JSON Lines。它會：

- 遮蔽鍵名包含 token、authorization、api key、uploadUrl、resultUrl 的值。
- 對普通字符串中的 HTTP(S) URL 移除查詢參數。
- 串行排隊寫入，單次寫失敗不阻塞任務。

新增日誌字段時仍應避免直接傳入文件內容、Token、API Key 或完整預簽名 URL。

## 13. Markdown 翻譯流水線

主要文件：

- desktop/src/main/translation/providers.ts
- desktop/src/main/translation/markdownPipeline.ts
- desktop/src/shared/markdownBlocks.ts

### 13.1 Provider

| Provider | 接口 | 併發 | 憑證 |
|---|---|---:|---|
| Qwen | OpenAI compatible chat/completions | 3 | Credential Manager |
| DeepSeek | OpenAI compatible chat/completions | 3 | Credential Manager |
| Bing | 非官方網頁翻譯接口 | 1 | 無 |
| TranSmart | 非官方網頁翻譯接口 | 1 | 無 |

OpenAI compatible provider 的 base URL 和 model 可配置。Bing 與 TranSmart 依賴非官方網頁接口，頁面或返回格式改變時可能失效。

### 13.2 AST 級翻譯

translateMarkdown 使用 unified/remark 把 Markdown 解析成 AST，再逐頂層節點翻譯：

- 保留 code、inlineCode、math、inlineMath 和 html。
- 普通文本的圖片、URL、表格/列表結構由 AST stringify 保持。
- 單段超過 4,000 字符時按句號、分號或空格拆分。
- 每個操作最多重試 3 次。
- 429 等錯誤可使用 Retry-After，否則指數退避。
- 翻譯總 queue 併發為 3。

MinerU 輸出的 HTML 表格會走獨立的整表翻譯協議：

- `parse5` 讀取 `table/tr/td/th`，保留單元格順序、空單元格、`rowspan`、`colspan` 和原始 HTML 結構；不新增單元格級 bbox 或 PDF 聯動。
- 每張表格及其相鄰 `table_caption`、`table_footnote` 生成一個 v2 結構化請求，所有可翻譯文本以穩定 segment id 傳遞，響應是有序 `{id, text}` 數組。
- Qwen/DeepSeek 接收完整表格 JSON；TranSmart 使用原生 `source.text_list` 在一次 HTTP 請求中提交有序文本數組；Bing 作為兜底時逐 segment 發送短請求。所有 Provider 都在完整校驗後才原子回填整表，不再依賴會被網頁翻譯器改寫的 marker。
- 回填時只替換原 HTML 文本節點，表格標籤、行列合併、屬性、公式、圖片和鏈接均來自原文。
- 缺少、重複、未知、空白或數量不符的 segment 會使當前 Provider 整表失敗並觸發回退；所有 Provider 都失敗時才保留整表原文並將任務標為 partial。圖片型或沒有可翻譯文本的表格保持原樣完成。

參考文獻在進入 Provider 前處理：章節標題統一寫為同級 Markdown 標題“参考文献”，`ref_text` 映射的文獻條目直接保留原文。缺少該映射時，使用參考文獻標題到下一個章節標題之間的連續段落/列表作為回退邊界，因此文獻之後的 Appendix 仍會繼續翻譯。

Provider 回退順序是：

    用戶首選
      -> qwen
      -> deepseek
      -> bing
      -> transmart

首選項會去重。某區塊所有 provider 都失敗時保留原文，任務最終為 partial。

### 13.3 翻譯緩存與恢復

區塊 sourceHash 基於該 Markdown AST 節點的序列化結果。緩存鍵包含流水線版本、provider、model、目標語言和 sourceHash；整表翻譯的緩存值是帶協議版本和完整表格 sourceHash 的 JSON。

已完成且 sourceHash 未變的 translation_blocks 會直接復用。這使部分任務重試時不需要重譯全部內容。

修改 prompt、清洗規則或翻譯語義時，應更新流水線版本。當前表格協議版本為 `mineru-table-translation-v2`，舊任務結果仍可讀取，只有手動重試才會使用新的整表流程。

## 14. PDF 與 Markdown 區塊映射

這是 demo 的核心差異化模塊：

- desktop/src/main/blockMapping.ts
- desktop/src/shared/markdownBlocks.ts
- desktop/src/shared/readerDocument.ts
- desktop/src/renderer/components/PdfPane.tsx
- desktop/src/renderer/components/MarkdownPane.tsx
- desktop/src/renderer/components/ReaderTextPane.tsx

### 14.1 block_list 版本

BLOCK_MAPPING_VERSION = 2。

buildBlockMappings 支持兩種輸入：

1. 新的 MinerU middle JSON：pdf_info、para_blocks、discarded_blocks。
2. 舊桌面格式：pdfData[].blocks。

邏輯映射包含：

- 穩定 block id。
- 閱讀順序 order。
- 類型 type。
- sourceText。
- 可選 sourceAsset。
- 一個或多個頁面 bbox。
- pageSize、pageIndex、blockPosition。
- discarded 與 mergeRole。

穩定 ID 使用 taskId 加 blockPosition 列表做 SHA-256，截取前 20 個十六進制字符。若修改 blockPosition 算法，已有翻譯區塊的恢復和緩存命中會受影響。

### 14.2 版面合併

- image/chart/table 頂層複合塊會展開為 body 子塊。
- lines_deleted 通過溢出 line 的幾何相交尋找前序 owner。
- merge_prev 合併到前一個兼容組。
- 同一邏輯組的多個 bbox 標為 source/continuation。
- discarded block 也進入幾何映射，但與正文保持 discarded 標誌。
- 缺少 page_size 時回退到 612 × 792。

### 14.3 Markdown 對齊

alignMarkdownBlocks 不直接按數組下標映射，而是：

- 對 visible text 做 NFKC、HTML entity、大小寫和標點正規化。
- 只在當前游標之後尋找單調、連續的 mapping 區間。
- 少於 16 個 canonical 字符的短文本只允許完整相等匹配；長文本才允許有界的連續包含／前綴回退。
- 每個 mapping id 最多分配給一個 Markdown 邏輯塊，成功後游標移到最後命中 mapping 之後。
- 媒體塊按資產文件名及游標之後的媒體順序輔助匹配。
- 一個 Markdown 節點仍可映射到多個連續物理 bbox；低置信公式或列表保持未映射。

修改 MinerU 輸出標準化、Markdown stringify 或文本正規化時，必須一起驗證映射命中率。

### 14.4 閱讀文檔模型

readerDocument.ts 是 MinerU 映射資料到 UI 的純函數邊界。正文永遠保持 Markdown AST/sourceIndex 順序，mapping 只用於導航，不能參與正文重排。它只把明確類型的 discarded mapping 還原為：

- page-header。
- footnote。
- page-footer。
- page-number。

頁眉插在該頁第一個正文錨點前；腳注、頁腳及「第 N 页」插在該頁最後一個正文錨點後。原文與中文譯文視圖都隱藏容易被誤認為圖片的打印頁碼方塊，只顯示頁眉、腳注、頁腳與統一分頁線。跨頁正文無法安全拆分時，補充元素放在完整邏輯塊之後。所有灰色補充元素都沒有 mapping id，只經過既有 sanitize Markdown renderer 顯示，未知 discarded 雜訊不顯示。

## 15. 閱讀器

### 15.1 mineru-asset 協議

主進程註冊：

    mineru-asset://{taskId}/{relativePath}

TaskService.resolveAsset 把路徑限制在該任務 outputDir 下，拒絕目錄穿越。assetProtocol 支持：

- GET、HEAD、OPTIONS。
- PDF/圖片/JSON/Markdown MIME。
- CORS。
- Accept-Ranges。
- 單一 byte range、suffix range。
- 200、206、404、405、416。
- Cache-Control: no-store。

這個協議讓 sandbox renderer 在不獲得本地文件系統權限的情況下讀取 PDF 和圖片。

### 15.2 PDF.js

PdfPane：

- rangeChunkSize = 256 KiB。
- 只渲染當前頁前後 2 頁。
- Canvas 按 devicePixelRatio 繪製。
- 使用 IntersectionObserver 更新當前頁。
- 支持 60%–200% 縮放。
- 在 PDF 上覆蓋 MinerU bbox。
- 同頁及跨頁合併塊顯示連線。

### 15.3 雙向聯動

- 點擊 PDF bbox，MarkdownPane 激活並滾動到對應區塊。
- 點擊/滾動 Markdown，PdfPane 跳到第一個映射頁。
- 灰色頁眉、腳注和頁腳不參與 PDF 導航或被動捲動選擇，但可作為文本標註錨點；打印頁碼不顯示，統一分頁線不可選取或標註。
- MarkdownPane 在佈局重建時建立 mapping id 到 DOM 的索引，PDF 點擊後不再逐節點掃描。
- 若同一 mapping id 污染到多個正文 DOM 元素，該 id 被標記為歧義並禁用導航，不任選第一個。
- scroll selection suppression 防止一次主動定位造成反向導航循環。
- `translation.manifest.json` version 2 新增 `mappingAlgorithmVersion: 1`。Reader 不直接信任持久化 mappingIds；只要 sourceIndex 完整、唯一、連續且區塊數與當前原文一致，就按 sourceIndex 套用當前原文新算法產生的 mapping，因而可安全恢復舊 version 2 任務的譯文跳轉。malformed sourceIndex 仍按原始順序顯示但禁用 PDF mapping，且不自動改寫或重翻譯。

### 15.4 原文、中文與 JSON 切換

ReaderTextPane 持續掛載三個 tab panel，切換只改變 active/inactive 顯示狀態，不銷毀已完成的 Markdown AST、圖片或捲動容器。中文與 JSON 分兩個 requestIdleCallback 階段預熱，避免同一幀建立兩個長文檔視圖；若用戶先點擊尚未預熱的視圖，該視圖會立即掛載。

隱藏 MarkdownPane 不建立 ResizeObserver、不重算區塊位置，也不處理捲動聯動。長文 block 使用 content-visibility 降低首屏外版面成本。JSON 使用只讀 textarea，搜索只建立命中附近的摘錄，不再為整份 JSON 建立帶高亮的巨型 DOM。

### 15.5 文本標註

原文與中文 Markdown 共用划選工具欄和當前荧光筆顏色，但標註資料按視圖隔離。正文以 source block 序號作為穩定 key，頁眉、頁腳與腳注使用 mapping ID；跨 block 選區拆成多個區間後一次事務保存。區間保存 quote 與最多 32 字符前後文，渲染時先驗證 offset，內容改變後才做唯一 quote/context 重定位，歧義錨點保留但不繪製。

視覺層使用 CSS Custom Highlight API，不插入或包裝 ReactMarkdown、KaTeX、表格與代碼 DOM。高亮與下劃線獨立，部分重疊按字符區間拆分、合併；再次操作已完全覆蓋的同色高亮或下劃線會刪除該範圍。“添加到對話”目前只有可選 renderer 回調和類型化選文載荷，沒有 IPC 或聊天後端。

## 16. 開發構建與目錄版發布

從倉庫根目錄：

    pnpm install --frozen-lockfile
    pnpm desktop:typecheck
    pnpm desktop:test
    pnpm desktop:build
    pnpm desktop:release

輸出：

| 產物 | 路徑／用途 |
|---|---|
| 開發 bundle | desktop/out；只供開發與源碼 E2E |
| 唯一運行目錄 | release/MinerU-0.1.0-win-x64；入口 MinerU.exe |
| 傳輸 ZIP | release/MinerU-0.1.0-win-x64.zip |
| 發布元數據 | release/release-manifest.json、release/SHA256SUMS.txt |

electron-builder 配置：

- appId：com.kumiko.mineru.translation
- productName/executableName：MinerU
- x64
- ASAR 開啟
- Electron locale 僅保留 zh-CN
- 目標：dir
- build 前精確清理 desktop/out，禁止累積舊哈希 bundle
- `desktop/scripts/package-directory.mjs` 每次只重建根目錄 release
- ZIP 生成後立即解壓驗證 MinerU.exe 與 resources/app.asar
- 發布門禁：app.asar ≤ 40 MiB、運行目錄 ≤ 330 MiB、ZIP ≤ 140 MiB，且不得包含 @napi-rs/canvas
- 暫無代碼簽名

`desktop:build` 只生成開發 bundle。`desktop:release` 先精確清理 `release/` 再生成唯一運行目錄、ZIP、manifest 與 SHA-256；setup、portable 及 `desktop/dist*` 都不是受支持產物。更新時關閉應用並整體替換運行目錄，userData 與 Credential Manager 數據不受影響；這是當前 Windows 流程，macOS `.app`/簽名/公證尚未接入。

## 17. CI 與發布

.github/workflows/desktop-windows.yml 在 windows-latest 上執行：

1. pnpm install --frozen-lockfile
2. typecheck
3. unit tests
4. desktop:release
5. E2E
6. 上傳 release ZIP、manifest 與 SHA256SUMS

以 desktop-v 開頭的 tag 會建立 GitHub Release。

push 只觸發 master；以 desktop-v 開頭的 tag 建立 GitHub Release。CI 不再上傳 setup 或 portable。

## 18. 測試結構

### 18.1 Vitest

現有單元測試覆蓋：

| 測試 | 主要契約 |
|---|---|
| parserClient.test.ts | API 字段、狀態、錯誤、ZIP、Token probe |
| fileUploader.test.ts | 無憑證 PUT、HTTP 200 |
| taskService.test.ts | 批次隔離、manifest 算法版本及 sourceIndex 安全降級 |
| taskBatching.test.ts | 每批最多 50 |
| blockMapping.test.ts | 穩定 ID、合併、discarded |
| markdownBlocks.test.ts | 單調文本／媒體對齊、短句不擴張、ID 不重用、97 頁真實回歸 |
| markdownPipeline.test.ts / tableTranslation.test.ts / providers.test.ts | AST 保護、整表 v2 JSON、TranSmart 數組與 Bing 短請求、附件聚合、參考文獻保護、缓存、provider 回退與原表保留 |
| assetProtocol.test.ts | Range、HEAD、404/416 |
| readerDocument.test.ts | 正文 sourceIndex 保序、原／譯文頁碼差異、譯文安全重映射、污染 mapping 不重排 |
| MarkdownPane.test.tsx | 資源就緒、錯誤重試、主動／被動聯動、歧義 ID 防禦、跨 block 標註工具欄與選色 |
| readerAnnotations.test.ts / readerAnnotationDatabase.test.ts | 區間增刪改色、重定位、視圖隔離、SQLite 遷移與級聯清理 |
| ReaderTextPane.test.tsx | 次要視圖預熱及三視圖 DOM 常駐 |
| JsonPane.test.ts | JSON 字面搜索與摘錄 |

### 18.2 E2E

| 測試 | 作用 |
|---|---|
| smoke.spec.ts | 開發模式與打包 EXE 啟動 |
| reader.spec.ts | 本地 PDF range、雙向聯動、原／譯文灰色元素差異、舊 manifest 譯文跳轉、短句錯位 fixture、真實 fixture |
| translation-live.spec.ts | 可選真實翻譯 provider |

真實 API/翻譯測試依賴環境變量和外部服務，不能作為所有 PR 的唯一判定。新增功能應優先增加可重現的 fake API 或 fixture 測試。

## 19. Python MinerU 層的關係

Python 3.4.5 源碼仍提供：

- mineru CLI。
- mineru-api。
- mineru-router。
- mineru-gradio。
- Pipeline、VLM、Hybrid、Office backend。
- middle JSON 與 Markdown/content list 渲染。

但 Desktop demo 現在：

- 不 import Python 包。
- 不啟動 Python 子進程。
- 不使用本地 mineru-api protocol v2。
- 不攜帶模型權重。
- 不把 Python 依賴打入 Electron EXE。

Desktop 與 Python 層唯一實際耦合是官方 API 返回的 Markdown、middle/layout JSON、content list 和圖片資產格式。

如果未來增加本地解析，需要新設計：

1. Python runtime 和模型的安裝/發現。
2. 本地 mineru-api 啟停與端口管理。
3. API v2 與官方 API v4 的統一 adapter。
4. 模型下載、磁盤空間與 GPU 選擇。
5. EXE 安裝器是否攜帶 Python。
6. 取消、崩潰恢復、日誌與更新。

這應作為獨立的大型設計與提交階段，不應直接塞進 OfficialMinerUClient。

## 20. 高風險熱點

| 文件 | 約行數 | 風險 |
|---|---:|---|
| main/taskService.ts | 629 | 任務、網絡、文件、翻譯與狀態集中；另有跨平台路徑邊界風險 |
| renderer/components/PdfPane.tsx | 396 | PDF.js 生命周期、Canvas、虛擬渲染和幾何 |
| main/parserClient.ts | 340 | 官方 API 契約與超時 |
| main/blockMapping.ts | 318 | middle JSON 兼容與穩定 ID |
| main/database.ts | 401 | schema、遷移和恢復；含 reader_annotations |
| translation/markdownPipeline.ts | 596 | AST、整表翻譯、緩存、重試與回退 |
| main/index.ts | 223 | Electron 生命周期和全部 IPC |
| translation/providers.ts | 307 | 外部接口易變、限流和密鑰 |
| translation/tableTranslation.ts | 481 | HTML 表格解析、segment 協議與整體回填 |
| renderer/components/MarkdownPane.tsx | 675 | Markdown 資源生命週期、位置索引、標註和雙向聯動 |
| renderer/readerAnnotations.ts | 185 | 選區、CSS Custom Highlight 與重定位 |
| shared/markdownBlocks.ts | 241 | 文本匹配啟發式 |
| shared/readerDocument.ts | 242 | 正文、discarded 補充元素與分頁排序 |
| shared/readerAnnotations.ts | 238 | 標註區間、上下文錨點與合併 |

跨模塊公共契約：

- MinerUTask 狀態與進度。
- AppSettings 與密鑰布爾標誌。
- 官方 API v4 JSON/狀態。
- 任務輸出文件名。
- BLOCK_MAPPING_VERSION 與 stableBlockId。
- mineru-asset URL。
- window.mineru IPC。
- translation cache key。

## 21. 後續模塊修改地圖

`master` 是稳定整合主线；每次功能任务应从当前基线创建独立 `feature/*` 分支/worktree，并只选一个主范围：

| 修改範圍 | 主文件 | 必須保持 | 最低驗證 |
|---|---|---|---|
| demo/ui-new-功能名 | NewParsePage.tsx | CreateTasksRequest | UI 單測/E2E 新建 |
| demo/ui-tasks-功能名 | TasksPage.tsx | TaskStatus 操作 | 搜索、篩選、重試、刪除 |
| demo/ui-settings-功能名 | SettingsPage.tsx、SettingsService | 密鑰不回傳 | 保存、清除、驗證 |
| demo/reader-pdf-功能名 | PdfPane.tsx、assetProtocol.ts | range、頁碼、bbox | PDF range、縮放、錯誤 |
| demo/reader-sync-功能名 | blockMapping、markdownBlocks、readerDocument、ReaderTextPane、ReaderPage | block id 穩定 | 同頁、跨頁、discarded、tab DOM 常駐 |
| demo/api-功能名 | parserClient.ts、fileUploader.ts | API v4、HTTPS、無 Token 上傳 | request fixture、狀態、錯誤 |
| demo/tasks-功能名 | taskService.ts | 狀態機、輸出契約 | 批次、部分失敗、重試 |
| demo/translation-功能名 | translation/* | AST 保護、緩存、回退 | 公式/代碼/URL、限流 |
| demo/storage-功能名 | database.ts | 遷移、外鍵、舊數據 | 新舊 schema fixture |
| demo/security-功能名 | preload、index、vault、logger | renderer 無密鑰/Node | IPC、路徑、日誌遮蔽 |
| packaging | package.json、package-directory.mjs、workflow | 唯一 release 目錄、ZIP、資源 | clean release、ZIP 解壓、打包 E2E |
| demo/local-parser-功能名 | 新 adapter/進程層 | 遠端模式不退化 | 本地/遠端雙矩陣 |
| engine/功能名 | mineru/ | Python API/middle JSON | Python 專項測試 |

## 22. 對話任務模板

後續可以直接使用：

    基線：Kumiko-kmk/MinerU 本地 master@10225a1；在 feature/* 独立 worktree 工作，
    先閱讀 ARCHITECTURE_ZH.md。
    本次只修改「<模塊>」，目標是「<可觀察結果>」。
    必須保持「<IPC/API/數據/輸出契約>」。
    請先核對當前實現與測試，再實現、補測試，
    運行 typecheck、相關單測及必要 E2E。
    不要改動其他模塊，除非契約兼容確實需要。

若 master 已前進，先核對當前工作樹並更新本文受影響章節。

## 23. 修改前後檢查清單

### 修改前

- 確認位於目标 feature/* worktree，核对其基线为本地 master；高風險修改先建立 bundle／patch 備份。
- 檢查 git status，保留已有改動和未跟蹤產物。
- 確認需求屬於 Desktop、官方 API 適配或 Python 引擎。
- 保存代表性 PDF、layout JSON、Markdown 和 block_list fixture。
- 涉及數據庫時備份 userData。
- 涉及外部 API 時先定義 fake response。

### 修改後

- pnpm desktop:typecheck。
- pnpm desktop:test。
- UI/閱讀器改動運行相關 Playwright E2E。
- 打包改動運行 pnpm desktop:release，核對 release 只有一個版本的運行目錄與 ZIP。
- 在乾淨 Windows 用戶目錄驗證首次啟動。
- 驗證 Token/API Key 不進 SQLite、renderer 和日誌。
- 驗證刪除與資產解析不能逃逸 outputRoot。
- 驗證 PDF 缺失、損壞、密碼保護和 range。
- 驗證單文件失敗不拖垮同批其他文件。
- 驗證 partial 重試不重譯已完成區塊。
- 更新本文的公共契約、文件表和測試表。

## 24. 已知不一致與待決策項

1. 根 LICENSE.md 是基於 Apache 2.0 並帶附加條款的 MinerU Open Source License，但 desktop/package.json 目前聲明 AGPL-3.0-only。這是分發前必須由維護者確認並統一的授權元數據問題。
2. translation cache key 已包含流水線/表格協議版本，但尚未包含完整 prompt 或策略指紋。
3. schema 遷移尚無顯式版本表。
4. app 重啟後在途任務只標失敗，不自動恢復。
5. 結果 ZIP 目前包含內部 .parsed。
6. Bing 與 TranSmart 是非官方網頁接口，穩定性不可保證。
7. 官方 API 是固定的 mineru.net v4；尚無自建 API 地址配置。
8. Desktop 只接受 PDF，沒有接入 Python 引擎支持的 Office 格式。

這些項目不代表文檔未完成，而是當前代碼的真實邊界。若後續決定修改其中一項，應在 master 上建立清晰提交並補充遷移／兼容測試。

## 25. 文檔維護規則

以下變更必須同步更新本文：

- desktop/package.json 的版本、腳本、構建目標。
- shared/types.ts 的 IPC、任務、設置和 block 類型。
- parserClient.ts 的 API 端點、字段、狀態或超時。
- taskService.ts 的狀態機、併發或輸出文件。
- database.ts 的 schema。
- BLOCK_MAPPING_VERSION、stableBlockId 或對齊算法。
- provider、prompt、回退順序或 cache key。
- Electron 安全選項、credential 或 asset protocol。
- CI master 觸發、tag 和 release artifact。
- Desktop 是否開始使用本地 Python MinerU。

更新時先把第 1 節提交號指向已驗證的新 HEAD，再更新受影響章節和測試結果。

## 26. 本基線驗證記錄

驗證日期：2026-09-02。

| 檢查 | 結果 |
|---|---|
| pnpm desktop:typecheck | 通過 |
| pnpm desktop:test | 24 個測試文件通過；106 個測試通過，4 個可選 fixture 測試跳過 |
| pnpm desktop:build | 通過；main、preload、renderer 均成功生成，build 前安全清理舊 bundle |
| Reader E2E | 6 個通過；2 個依賴真實 MinerU fixture 的可選測試跳過 |
| UI chrome E2E | 2 個通過 |
| 開發 bundle smoke | 1 個通過；首屏正常 |
| 真實 Deep Sparse 任務 | 完整離線映射／整表／參考文獻回歸通過；`ref_text` 未進 Provider，表格 caption 與單元格均生成 v2 結果 |
| 正式打包 | 合并前已验证的 Windows 目录版/ZIP 为 app.asar 20.24 MiB、运行目录 297.31 MiB、ZIP 125.64 MiB；合并后未重跑正式 release |
| 打包程式 smoke | 合并后未重跑 packaged smoke；开发 bundle smoke 已通过 |
| git diff --check | 通過 |
| 文檔關鍵路徑核對 | 全部存在 |

本次將整表協議升級為 v2，TranSmart 使用原生數組、Bing 使用短請求兜底，並加入參考文獻原文保護；同一提交新增 `reader_annotations` SQLite 表、兩個 annotation IPC 和對應共享類型，但沒有改動 Python 層、官方 API 或 `DocumentPayload`。TranSmart 公開接口已用無敏感合成文本驗證等長數組返回；可重現 fixture 與真實任務覆蓋混合公式回填、正文保序、補充元素、PDF 聯動、文本標註、視圖常駐與打包程式啟動。

## 27. macOS 可移植性現狀（2026-09-02 評估）

目前 Desktop 的「核心業務」大多可跨平台：React/TypeScript、PDF.js、Markdown、`node:sqlite`、網絡 Provider 和任務隊列沒有直接依賴 Win32。当前发布链路仍是 Windows-only，macOS 不是把 `--win` 改成 `--mac` 就完成，需把以下边界显式抽象：

| 優先級 | 現況 | 必要工作 |
|---|---|---|
| P0 | `taskService.ts` 以 `${root}\\` 判斷路徑邊界 | 改用 `path.relative()` 等跨平台判斷；補 POSIX 資產讀取與刪除測試 |
| P0 | electron-builder、package script、smoke E2E 和 workflow 固定 `win-x64`/`.exe`/`--win` | 增加 darwin arm64 目標、`.app` 入口驗證、資源/manifest/ZIP（或 DMG）策略與 macOS CI |
| P1 | `WindowsCredentialVault` 類名與 Windows Credential Manager 文案 | 改為通用 `CredentialVault` adapter；在真實 Mac 驗證 Keychain 的保存、重啟、更新和簽名權限 |
| P1 | Tray、彩色 PNG 圖標、`window-all-closed` 行為未按 Dock/Menu Bar 驗證 | 增加 macOS Template icon、Dock activate、關窗/退出/通知點擊 E2E 或手工驗收 |
| P2 | README、數據目錄、發布門禁只描述 Windows | 按平台補路徑、產物、簽名/notarization 和 Gatekeeper 文檔 |

建議先支持 Apple Silicon arm64，再決定 Intel/universal；`@napi-rs/keyring` 鎖文件已含 darwin-arm64/x64 可選包，但仍需 Electron 原生模塊與 `.app` 實機驗證。僅開發版可運行約 2–4 個開發日；arm64 未簽名目錄版約 1–2 人周；包含 CI、Developer ID 簽名、公證和回歸約 3–6 人周；Intel/universal、自动更新或本地模型另加约 1–3 人周。

這些結論與 RAG 方案相互獨立：先完成平台 adapter 和路徑安全，再提交 RAG migration/artifact/chunk，避免索引與引用契約被平台修復反覆改寫。Electron 的 macOS 簽名/公證、生命週期和原生模塊要求見官方文檔：<https://www.electronjs.org/docs/latest/tutorial/code-signing>、<https://www.electronjs.org/docs/latest/api/app>、<https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules>。
