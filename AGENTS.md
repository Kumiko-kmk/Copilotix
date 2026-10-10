# 跨 Worktree Agent 協作文檔（永久保留）

本文件是分支與 Agent 的共同入口，不得刪除、改名或以其他文件取代。開始工作前閱讀；維護時保留有效契約，刪除過時進度與重複敘述，細節連到專項文檔。

## 協作規則

- 動手前與交付前執行 `git status --short --branch`，確認 worktree、分支及未提交內容；不得修改、清理、stash 或重置其他 Agent 的 worktree。
- Worktree 不共享未提交文件；跨分支傳遞須先 commit，再 merge、rebase 或 cherry-pick。
- 共享 schema、migration、IPC、Core RPC、JobRepository、Artifact/PathPolicy 或發布腳本的修改，須記錄兼容策略、測試證據與恢復語義。
- 預設不跑本地 lint、typecheck、單元／覆蓋率及 E2E；仍須維護相關測試。只有使用者要求本地驗證時才執行。未明確授權不得 push、上傳產物或觸發遠端發布；允許本地 commit、build 與打包，驗證邊界見第 8 節。

## 1. 本地 Windows 構建與交付

使用 Node **24.19.0**、根 `packageManager` 指定的 pnpm **11.19.0**。系統 Node 24.11.1 曾靜默崩潰並留下舊 out；不要使用。Codex fallback pnpm 版本可能不符，可用正確 Node 執行 Corepack 快取的 `11.19.0/bin/pnpm.mjs`，不得偽造 user-agent。

在倉庫根目錄執行：

```powershell
pnpm install                       # 新 worktree 或依賴／lockfile 改變時
pnpm desktop:build:bundles          # 源碼改動後重建 Main、Preload、Renderer、Utility
pnpm desktop:release:from-built     # 使用新 out 打包；不可與 desktop:release 並行
```

僅源碼與 `desktop/out/` 均未變更時，才可省略 build。打包內建的 ASAR、資源、fuses、體積、雜湊與 packaged smoke 校驗不可移除；成功後原子更新發布目錄，失敗保留 `.release-next-*` 供排查。

- 人工測試入口：`release-artifacts/<build-id>/program/Copilotix.exe`，不可單獨搬走 EXE；同目錄 DLL、PAK、resources 均必需。
- 交付包：`release-artifacts/<build-id>/Copilotix-<version>-win-x64.zip`，Setup 規則見第 6 節。
- Runtime 上限 **360 MiB**，Electron 約占 330 MiB。Renderer-only 套件放 `devDependencies`；Main 純 JS 優先由 electron-vite externalize `exclude` 打入 bundle；原生或刻意外部化套件才留 `dependencies`。

## 2. 文檔格式接口（PDF / Markdown）

- 現階段導入、解析、閱讀正式支持 PDF。列表僅按 `originalName` 顯示 `.md`／`.markdown` 為 Markdown，其餘舊記錄兼容顯示 PDF。
- 正式接入 Markdown 時，在 IPC、Core RPC、資料庫及 migration 加入 `sourceFormat: 'pdf' | 'markdown'` 並回填舊資料，不得長期依賴副檔名推斷。
- Markdown 導入接受 UTF-8 `.md`／`.markdown`（`text/markdown`），經 PathPolicy 原子落盤及摘要校驗，不走 PDF 上傳／解析器；在標準化邊界產生 canonical Markdown artifact。
- 保持 PDF／舊資料可讀，維護重複判定、狀態投影、刪除／重試、artifact revision 及恢復測試。

## 3. 設定頁與新 UI 對齊

- 以「服務連結」內容區為尺寸基準：頁籤根節點是 `.settings-content-body` 的直接子元素，使用 `.settings-section` 並填滿可用寬高。
- 不重複導覽標題、不用空白標題佔位、不加專屬外層 margin／padding／max-width；首張卡片的頂、左、右邊緣須與基準一致。
- 卡片內距可自訂；以 `section`／`aria-label` 保留與導覽一致的區域名稱。測試驗證可按名稱查找、無重複標題及共用根類別。

## 4. 文檔庫維護契約

- 維護經 Main 原生選目錄與確認、IPC 維護鎖、Utility 持久化隊列；活動任務期間不可切庫。
- manifest v1、schema_migrations 與 SQLite 結構共同約束兼容。恢復先校驗並保留舊庫；遷移複製完成後才事務切換路徑，不自動刪除舊文檔目錄。
- API Key 不進備份。實現、恢復語義與回歸項見 `docs/LIBRARY_MANAGEMENT_ZH.md`。

## 5. 許可與簽名

- 自有代碼沿用根 `LICENSE.md` 的 MIT，不覆蓋第三方或歷史上游許可。
- 打包生成第三方許可匯總（包括開發依賴），並複製 MIT 與聲明到 `resources/licenses`；缺少許可文本須如實列出。
- 本機自簽僅供測試，不自動加入系統信任。正式政策與 SignPath 見 `docs/CODE_SIGNING_POLICY.md`、`docs/SIGNPATH_APPLICATION.md`。

## 6. Setup 交付契約

- ZIP 為 compact-setup：根目錄含 Setup、`uninstall.exe`、安裝說明及小型 advanced 校驗文件；runtime 嵌入 Setup，不在 ZIP 重複放置，開發副本留在 `release-artifacts/<build-id>/program/`。
- schema 5：distribution 為 compact-setup，`runtime.embeddedIn` 標記內嵌；外層 `runtimeArtifactDirectory` 指向開發副本，`artifactDirectory` 指向 ZIP 目錄。ZIP 內 bundle-manifest 不含外部產物路徑或自身哈希；外層 release-manifest 在 ZIP 完成後加入 `transport.sha256`，不進 ZIP。成功只清理上一成功版本已驗證的產物路徑，失敗暫存保留。
- 強制目前使用者安裝，允許選位置。安裝／卸載發現應用運行時提示退出，不強制結束背景隊列。
- 卸載預設保留資料、憑據與獨立文庫；只有明確勾選清除、Main 第二次原生確認後，獨立 Utility 才按唯讀清單驗證並安全清理。覆蓋升級／靜默卸載不得清資料；新增憑據或儲存結構須同步卸載清單與路徑驗證。
- Setup、主程式、內嵌卸載器均受正式簽章門禁。必要驗收入口：`pnpm desktop:test:installer:wizard`、`pnpm desktop:test:installer`；腳本拒絕覆蓋既有安裝。

## 7. 閱讀器、併發與問答契約

- Core RPC 只保留 Main 實際調用的 operation；新增能力採「Utility 生成 descriptor，Main 只傳 ID 與小結果」。可能隨文庫增長的列表一律分頁；`tasks:list`／`documents:list` 採 keyset `{ after? } → { items, next }`，每頁 ≤200 行、≤512 KiB。
- Utility SQLite operation 分 data、compute（`compute:*`）及獨佔生命週期（init／flush／close／library）通道；事務回調內不得 await。Main compute 用 `COMPUTE_RPC_TIMEOUT_MS` 與作業 signal 取消。
- JobScheduler 的 `job-changed(job)`／`job-notification(job)` 用 `job.documentId` 定位文檔；Main 高頻事件經 `createCoalescedRefresh` 合併刷新。Reader 給 MarkdownPane 的 blocks／annotations 用 `useMemo` 保持引用穩定。
- PDF 貼合完整 clientWidth，無外圍 padding／邊框／陰影、原生捲動條、頁間或末頁 gap；浮動捲動條支援拖曳／鍵盤且不佔位。透明欄分隔器覆蓋右欄。寬度／縮放／延遲尺寸改變時，layout effect 按頁號與頁內比例恢復，停用 overflow anchoring 並取消舊 frame；人工翻頁與引用定位正常更新頁碼。
- 問答共享入口：`docs/READER_AI_CHAT_PLAN_ZH.md`。文獻目錄 `chat/` 原子保存歷史、草稿、選區與模型，歷史分頁；無新 migration，不合併 demo schema 5–7。清空、刪文獻、文庫維護及退出前，須等待相關問答取消與落盤，避免晚到寫入。
- 問答沿用「服務連接」憑據，默認翻譯服務商，可獨立選已啟用 Qwen／DeepSeek 的共享預設模型，不改翻譯模型；IPC／Main 校驗 provider、Key、valid、consent。舊 request 可省略 provider；舊 chatProvider 不參與路由，自訂模型回退預設而不損壞歷史，Key 不進聊天文件。首次打開問答才掛載／建索引；添加選區不切頁籤，恢復引用重新核對 revision。
- 只提供 PDF、原文、中文、問答四視圖，JSON 僅保留底層產物與 ZIP。`readerLayout.ts` 為 split／group 純函式樹，每視圖僅出現一次、最後一個不可關閉；localStorage `copilotix.reader.layout.v1` 校驗修復後載入，缺省「PDF｜原文·中文·問答」，首次沿用舊 sessionStorage 欄寬。
- 工作台分組最小 240×140；拆分、移動、關閉／重開、拖曳（5px 起拖、Esc 取消；邊緣四分之一拆分，中間合併）不得破壞唯一視圖。拖曳預覽走獨立 DragContext；分隔器拖動僅本地更新、放開提交。最大化純 CSS、其他分組保持掛載、不持久化；split pane 不设 position，分隔線用 ::after。
- Markdown 僅選中時掛載並恢復 `initialScrollTop`；PDF／問答首次顯示後保持掛載。工具列 portal 到所在分組；PdfPane 的 `toolbarHost`、`initialViewState`／`onViewStateChange` 保持移動／重開錨點。複製／另存作用於聚焦分組。
- 快捷鍵：Ctrl+1–4 顯示四視圖，Ctrl+反斜線右拆，Ctrl+Alt+←/→ 移組，Ctrl+W 關閉，Ctrl+Shift+T 重開，Ctrl+Shift+M／雙擊最大化，Esc 還原。
- `readerScrollSync.ts` 以 mappingId＋塊內比例對齊視口 35% 閱讀線；僅人工捲動領先，120ms 程式回聲不回報，每幀最多一次。參與者為分組選中且在 layout.synced 的視圖（預設原文＋中文、PDF 關閉、問答不參與）；PDF 用 `pdfSyncPosition`。引用無可見閱讀視圖時，`ensureReadingView` 在問答旁拆開／重開原文或中文／PDF，先還原最大化，不能取代問答。共用少量 mappingId 的合成夾具有歧義，同步／選段聯動須用真實解析資料驗收。

## 8. 遠端 CI 與驗證邊界

- 修改 → 本地 commit → 按需本地 build／交付；未授權不 push，未跑完整 CI 如實說明。授權上傳後檢查最新提交的 Actions，合併前 `build` 必須成功，PR 另須通過最新合併結果檢查；舊成功、跳過、取消皆不可替代。
- `.github/workflows/desktop-windows.yml` 覆蓋所有分支 push、PR、`desktop-v*` tag 及手動觸發；新分支須包含最新工作流。只 commit 不會觸發 Actions。
- 保留必需檢查名稱 `build`，包含 frozen-lockfile、lint、typecheck、覆蓋率、四 bundle、packaged smoke、Electron E2E、安裝／升級／卸載／重裝、下載解壓；tag 另受版本、許可與簽章門禁。不得刪斷言、降覆蓋率或關閉門禁。
- `Copilotix-Windows-x64-Bundle` 供安裝驗收；`Copilotix-Windows-verification-reports` 保存 JUnit、覆蓋率及 E2E 失敗證據。CI 未過不可稱已驗證包；CI 無個人 API 憑據，付費模型、視覺及硬體差異仍須真人驗收。

## 9. CI 與夾具維護

- Vitest CI ≤2 workers，Windows Playwright 單 worker；JUnit 放 `desktop/unit-test-results`，避免被 Playwright 清除。
- Windows 原子 rename 對 EPERM／EACCES／EBUSY 最多約 6.3 秒有界重試；永久錯誤 exit 1，不用 copy／delete 替代。E2E 前須有 Setup、uninstaller、release-manifest、ZIP。
- 僅「未打包＋NODE_ENV=test＋COPILOTIX_E2E_USER_DATA」用獨立 native vault service；夾具只清理自身六種 account，不碰真人憑據。問答 E2E 經真實設定 IPC 存假 Key，僅 mock provider HTTP。
- 閱讀器一般從任務列表進入，等 reader-header（≤30 秒）及 Markdown ready 再互動，error 不算 ready；不加全局 retry／timeout 或降低斷言。文庫入口另測其返回路徑。
- 縮略圖截圖用直角 app-shell 與完整 CSS 像素裁切，channel delta ≤1、changedRatio ≤0.001；失敗保留 expected／actual PNG。

## 10. Markdown 公共格式與導出

- `docs/MARKDOWN_FORMAT_ZH.md` 定義格式、版本兼容、映射、原子導出與真實論文驗證；`standardMarkdown.ts` 共享規範為 CommonMark＋GFM＋明確數學擴展，不得將公式降級代碼。
- Markdown 導出攜帶相鄰圖片目錄及相對鏈接，圖片失敗不得覆蓋既有導出；原任務資料不可作導出目標。ZIP 同樣規範化兩份 Markdown。
- 對比交付只保留使用者要求的两份 Markdown；瀏覽器／CI 不替代 Notion Desktop 驗收。

## 11. 豐富閱讀與標準導出分離

- 解析、翻譯與閱讀保留 HTML／LaTeX 豐富結構，不展平合併表格。`prepareReaderMarkdown` 僅非結構性準備／圖片路徑修正；`normalizeMarkdown` 僅導出投影，不回寫源資料。
- 新翻譯計劃 v6，兼容合法 v4/v5/v6 manifest；v5 平面表格不可自動恢復，不自動重解析／重翻譯。映射、標註、資源及原子發布契約不變，詳見上述格式文檔。

## 12. 版本與共享進度（可更新／清理）

- 1.1.0 已經 PR #8 合併並發布，說明見 `docs/releases/1.1.0.zh-CN.md`。僅該版的一次性未簽章例外已用完，變量已移除；其他版本要求正式簽章，已發布 tag／文件不改動。歷史 CI 不替代後續最新提交驗證。
- README／Wiki 源在 `docs/wiki/`；目錄提交不會自動發布 Wiki，先合併主倉庫圖片與文檔再同步。真實論文截圖、未發送問答草稿及示意圖須區分，不代表付費 API 驗收。此前 README／Wiki 上傳授權不延伸至新任務。
- 文庫工作區 `Copilotix-library-ui`／分支 `ui/library-rhinelab`；完成範圍与當前驗證見第 13 節。其他 worktree 保持不動。

## 13. 文庫頁與 AI 解讀（2026-10-09）

- 2026-10-10 選中頁精簡：移除類型／創建時間／檔案卡生成狀態及其獨立讀取組件，元信息只保留空格分隔的單行關鍵詞與下方「總結」；關鍵詞隨寬度縮小至 11px，仍超出則省略，完整內容在 tooltip。總結沿用 v2 `tldr`／v1 `summary`，展示檔案標題下不再重複 v2 總結，儲存／生成契約不變。本輪按使用者要求未跑測試、未打包；僅構建開發界面，使用現有 15 篇論文及已保存檔案卡的隔離副本取得 Electron 截圖，未調用模型、未改原文庫。圖片見 `../investigation/library-notes-20261010/selected.png`、`archive.png`。
- 2026-10-10 重做：先撤銷 `29debc4` 並核對源碼回到 `02e924a`，再實作每分類一列、右下角分類名十二字固定寬度居中、選中頁以關鍵詞取代狀態、詳情「摘要（譯文）→概覽→發現→局限與前提」。原英文／譯文標題與日期渲染保持原結構；閱讀路線與術語不在界面展示，儲存格式、生成提示詞兼容。分類内仍按原序循环浏览。
- 文件日期：原 Electron 資源帶 1980 年修改時間；`runtime-file-times.mjs` 只更新發布暫存 runtime 的時間戳，在 Setup 嵌入前完成，源依賴與用戶文庫不變。文件內容、签章、原子发布及失败恢复语义不变，日期回歸驗證源文件及副本內容保持不變。
- 本輪驗證與交付：20 項針對性回歸、typecheck、修改文件 lint、四 bundle／Utility smoke、发布内建 packaged smoke／完整性／體積檢查通過。基線／重做後及實際打包 EXE 均檢查長標題布局，覆盖三个窗口尺寸、快速換篇、固定分類邊界、關鍵詞與譯文摘要；實際包使用隔離文庫與真正保存的 v2 夾具，無模型呼叫。讀回 241 個 runtime 文件時間均為當前構建日期，EXE／ASAR／Setup／ZIP 哈希一致，包內 74 個 out 文件與本地輸出一致。新入口 `release-artifacts/mv1v19un-28996-e231fd96/program/Copilotix.exe`，證據見 `../investigation/archive-redo-20261010/SUMMARY.md`；未執行全量測試／完整安裝生命週期／遠端 CI，未 push。

- 後續動畫候選見 [文庫動畫候選項](docs/LIBRARY_MOTION_IDEAS_ZH.md)。目前僅記錄；待互動邏輯與顯示資訊確認後，按實際需求選擇實作，不預先補效果或擴充動畫架構。
- 工作區 `Copilotix-library-ui`／`ui/library-rhinelab`。`LibraryPage` 懶載入 Three.js；從文庫進閱讀器以 `returnTo: 'library'` 返回並恢復論文，其他入口仍返回任務管理。
- RhineLabUI（MIT，LBEILC）來源與許可見 `THIRD_PARTY_NOTICES.md`、`paperArchive/RHINELABUI_LICENSE.txt`。GLB 僅五個外殼網格，`?inline`／`parseAsync`，CSP 不變。**不改 `archiveMotion.ts` 已校準曲線**；手感調整限 Scene。
- 列按內容分類（2026-10-10，Claude，取代按月份）：Utility `compute:library-categories`／IPC `library:categories` 分頁返回分類，TF-IDF 近鄰圖 + Louvain、約 √n 組，有 AI 檔案卡時以 `field.area` 命名，否則取區分詞；無文本論文入「待分類」，結果僅存 Utility 記憶體。文庫頁（400 ms 防抖）在論文增刪／狀態變化或檔案卡完成時重新請求，返回前顯示「全部論文」。界面不再顯示月份（統計、路徑、列名、檔案編號旁改為分類名）。設計與局限見 [文庫內容分類](docs/LIBRARY_CATEGORIES_ZH.md)。每個分類一列，列／行循環並記住論文 ID；右下角列數與分類數一致，不顯示分列後綴。完成原色、處理中主色、部分完成琥珀、失敗紅色。搜尋按標題／原檔名分詞，最多 40 項；`/` 聚焦、Enter 選首項、Tab 選結果，IME／長按 Enter 不誤觸。搜尋取消慣性，WebGL 失敗仍可搜尋進閱讀器。
- 渲染保留單一 rAF、約 60 fps、牆鐘待機、失焦／隱藏停渲染、reduced-motion 與 GPU 釋放。DPR ≤1.25、≤3.3M 像素，transmission 半解析度、陰影 1024；6 幀超時降解析度 15%（下限 0.55），穩定 240 幀且 8 秒未降才回升 8%。保留解析拾取、剔除、共享 instanceMatrix、compileAsync 暖機；途經選中卡即發漣漪（最多 6），升起 4.2／回落 4.5。不得恢復「流暢模式」、保存項或材質降檔。
- 抽取沿用單一 hero、4.05 升起、原有 detail 鏡頭；鏡頭 >0.6、升起 >3 後進入解密（2026-10-10，Claude）：`archiveDecryption.ts` 移植 RhineLabUI decryption／glass-reveal／document-decryption 曲線，清除前的標記（長入、相接、回縮）以 4.8 倍速、清除以 2.4 倍速播放（共約 1.3 秒，文字約 1 秒後開始揭開；原版互動 3.6 秒）：四角標記與對角線兩端長入、相接、回縮成點（Scene 內 SVG `.paper-archive-inspection`，按卡面模型座標投影），玻璃以 0.12 羽化前緣自上而下清除並帶主色掃描光；清除開始時 `onDecryptReveal` 通知頁面，`lineRedaction.ts` 對 `.paper-archive-reveal` 內每一行文字逐行畫墨條並按閱讀順序向右滑出（0.95 秒）。減弱動畫直接完成且不畫墨條。首頁 1600px／LRU 6，共享 document 查詢；PDF 首頁、文獻資訊與 AI 解讀按需載入，切文獻／卸載取消晚到結果與訂閱。
- 互動契約：Enter 忽略 repeat，抽出／解密中不進閱讀，完全展開後再次 Enter 或點 hero 才進閱讀；「打开阅读」保留直接入口。移動 ≥8px 後不得視為點擊；pointercancel／lostpointercapture 不啟動點擊。詳情分頁左右／Home／End 導航並移焦，正文方向鍵保留捲動；僅文庫瀏覽區方向鍵換卡。瀏覽時 Esc 先收搜尋；抽出期間檢索沿橫線收起並 inert（結果清單同時關閉），Esc 直接關詳情並移焦回文庫。
- `closing` 保留舊文獻、封面與模型，面板 180ms 淡出且 inert，模型／鏡頭 320ms 收回再卸載。換卡只保留一個待選目標，方向輸入累積、搜尋覆蓋；目標移除即取消，收回中重開同篇從當前姿態接續並清除待選。減弱動畫直接完成收回；不新增模型副本、動畫迴圈、IPC 或持久化格式。
- 版面與入場（2026-10-09 晚，Claude）：入場以 `entryScanTime` 把原版掃描波去程與回程之間約 1.3 秒的平板段壓縮為約 0.25 秒，肩部按真實時間在滑入結束時升起，`archiveMotion.ts` 曲線不變。瀏覽鏡頭以 `ARRAY_SCREEN_SHIFT` 把選中卡移向左下（-4%／10% 視口）；瀏覽面板與詳情面板共用 `--archive-panel-left` 左緣。Scene 以 `onDetailFrame` 回報抽出卡最終的投影範圍，頁面寫入 `--archive-detail-top/height`；詳情面板頂端與左側品牌對齊（FILE NO. 對 PAPER ARCHIVE、標題對「文库」），底端到卡片下緣，各分頁高度固定，只有分頁內容捲動；卡片下緣以下由 `.paper-archive-floor-veil` 隨鏡頭轉向完全遮蓋陣列；詳情內容由瀏覽面板範圍以 clip-path 揭露／收回；上下裝飾框線已依使用者要求移除。返回按鈕移到卡片下方。詳情完全展開（`open`）後渲染在 ≤8.3M 像素內用 2 倍顯示器 DPR（瀏覽器按 2×2 平均，邊緣與文字更平滑），放不下則用原生 DPR（≤2），透射亦改全解析度；靜止時不重繪，收回即恢復瀏覽上限。繪圖緩衝區變更一律經 `applyResolution` 標記、於下一幀開頭 `flushResolution` 後立即渲染：此前在幀間（ResizeObserver、按鍵收回詳情、渲染後的自適應降級）改尺寸會清空畫布並以空白幀合成，即文庫偶發閃爍的原因；首頁貼圖按展開後的設備像素高度重採樣，避免 1600px 原圖跨 mip 取樣發糊。
- 逐行遮擋（2026-10-10 修正）：文字與檔案卡載入完成前不揭開；遮擋期間以 ResizeObserver＋MutationObserver（忽略遮擋層本身）在版面或文字變化時重新量測，滑出途中版面變化則直接移除，避免墨條蓋住分頁標籤而晚到文字露出。
- 2026-10-10（Claude）：檔案卡改送 detailed 56 KiB 摘錄（請求 ≤80 KiB、max_tokens 6000、逾時 300 秒），各欄位字數區間見 `paperBrief/lengths.ts` 與 [Paper Brief v2](docs/PAPER_BRIEF_ZH.md)；首答超出區間時修復一次，第二答不因字數丟棄。文庫細節：分頁標籤顯示發現／局限條數，生成中顯示已用時間，「打开阅读」附 Enter 提示，瀏覽面板顯示「档案卡」狀態（已生成／需更新／生成中／未生成）。測試夾具 `tests/fixtures/paperBrief.ts` 已改為符合全部區間，避免觸發修復輪。
- Paper Brief v2 已接入生成、校驗、保存與四分頁；一句話／類型／領域、證據基礎／檢驗方式取代低價值統計，無 v2 回退規則欄位與 v1。發現保留強度、需核對標記及可展開的來源摘錄；章節僅文字，暫不接閱讀器跳轉。設計及人工品質驗收邊界見 [Paper Brief v2](docs/PAPER_BRIEF_ZH.md)。
- 授權、single-flight／併發、取消等待、原子落盤與備份卸載契約見 [AI 檔案卡](docs/PAPER_INSIGHT_ZH.md)。v2 寫 `insight/brief.v2.json`（≤256 KiB），保留 v1；只按 sourceRevision 標 stale，promptVersion 不同僅提示重新生成。新 Core RPC `insight:brief-context/save-brief` 與 ready v2 聯合類型隨 Main／Utility／Preload／Renderer 同版交付，不新增 migration／manifest。
- 真實 DeepSeek 驗證已獲明確授權並完成：DeepONet、AlphaFold 各一次，結果已保存原文庫；具體數量與品質限制見上述專項文檔。其餘動畫候選仍待設計確認，不屬於未完成開發。
- 本輪驗證：96 個單元測試檔，660 項通過／3 項既有跳過；typecheck 通過；lint 0 errors／63 項既有警告。四 bundle／Utility smoke、Electron 文庫正常／WebGL 降級／v2 檔案卡 3 項通過；已檢視 mock 結果截圖。真實 API 兩篇結果已落盤，少量樣本不等於跨學科品質驗收。本地打包與 packaged smoke／完整性／體積門禁通過（runtime 353.28 MiB、ZIP 94.05 MiB）；入口見 `release/advanced/release-manifest.json`。未跑本輪完整安裝生命週期／遠端 CI，未 push／遠端發布。

### 給 Astra 的話（Claude，2026-10-09 晚）

文庫瀏覽面板已與詳情共用 `--archive-detail-width`；瀏覽標題固定兩行高度、單行垂直居中、超出兩行省略，顯示時移除末尾 `.pdf`（不改文件名或搜尋索引）。
標題下方固定一行小字顯示已翻譯 Markdown 的中文標題，溢出省略；無譯文時留空，不另發 API。只在選中論文停留 180ms 後讀取內容，與詳情共享 query cache。
文庫中間分隔線上下間距縮為原本三分之一；詳情移除上下裝飾框線及頁數／章節／圖表公式／參考文獻統計列。摘要只顯示譯文，無譯文時提示缺失，移除切原文與「/ 譯文」標籤，首行縮排兩字；「打开阅读」下移 16px，底部保留 24px 內容間距。保留進退場 clip-path 揭露，取消框線拉伸。
後續計畫（使用者明確要求記錄，**本輪尚未實作**）：AI 檔案卡改為全部預設同意並自動生成。本輪僅移除文庫底部同意聲明（unavailable 狀態不顯示底部狀態列），服務授權、既有自動生成開關及生成流程維持現狀；後續接手時需同步相關設定、Main／IPC 授權與自動生成契約。
本次已重建四 bundle／Utility smoke 並通過本地打包內建檢查；依使用者要求更新原 `release-artifacts/mv124gkn-2672-f431fb00/program`，外層 manifest 路徑同步，EXE／ASAR／ZIP 雜湊一致。未跑本輪 lint／typecheck／單元／E2E，也未完成實際畫面驗收；未 push。

使用者驗收後提出的版面與入場調整已完成，契約見上方「版面與入場」一條；涉及 `PaperArchiveScene`（`entryScanTime`、`pointCamera`、`onDetailFrame`）、`LibraryPage`、`ArchiveDetail`（`stretchPanel`）、`paperArchive.css`，並改寫一項 LibraryPage 測試（詳情期間檢索不可用）、新增兩項 Scene 測試。依第 8 節未在本地執行，若全量測試或 E2E 有失敗請直接修正。請留意：

1. 詳情面板改為固定高度後，720p 下分頁內容約剩 130px。v2 檔案卡標題、證據基礎／檢驗方式已限制為 2 行（完整內容在 tooltip），若你覺得資訊密度仍過高，可把「作者／單位」移入概覽分頁。
2. `stretchPanel` 依賴瀏覽面板在 `onDetailPhase('opening')` 時仍掛載；如果之後調整詳情掛載時機，請保留這一捕捉點。
3. 減弱動畫時 clip-path 揭露、檢索收合全部跳過。

### 現有文庫批次生成（2026-10-10）

- 使用者明確選擇並授權發送到 `https://api.deepseek.com/chat/completions`；沿用現行 `deepseek-flash`／`brief-v2.2026-10-10` 生成全部 15 篇。首輪 14 篇成功，1 篇單獨重試成功，15 份已保存原文庫 `insight/brief.v2.json`，schema／論文 ID／来源 revision／promptVersion 均核對通過。
- 共 29 次服務呼叫（含修復與重試）、469711 tokens。用量獨立保存於批次報告，未寫入運行中應用的用量統計；未修改永久服務選擇、授權或自動生成設定，未調整產品代碼。
- 全部標示部分摘錄；14 項發現需人工核對，第二答仍有 3 項字數／數量提示，按現行契約保留有效結果。這是實際 API 生成及落盤核對，不等於人工論文品質驗收。報告與舊结果備份見 `../investigation/paper-brief-bulk-20261010/SUMMARY.md`、`report.json`、`audit.json`、`previous-results/`。

### 摘要連結與逐行遮罩修復

- 摘要保留 HTTP(S) 自動連結、Markdown／HTML 連結目標與 URL 下劃線；以純文字展示，長網址可換行。標題／作者等既有清理不變。
- 墨條遮蓋所有可見文字，包括不足半行的底部片段；解密前捲動、尺寸與字體改變會重新量測。逐行退場總時長由 0.95 秒減半為 0.475 秒，閱讀順序曲線與卡片解密時間不變。
- 本輪針對性驗證：paperProfile／archiveDecryption 共 8 項通過；無頭 Chrome 對長摘要部分末行、捲動及改寬三種量測情境均無未遮蓋文字。這是瀏覽器量測驗證，不代替實際 Electron 全流程視覺驗收。
- 四 bundle／Utility smoke 與本地打包內建門禁通過，更新使用者指定的 `release-artifacts/mv124gkn-2672-f431fb00/program`；EXE／ASAR／ZIP 雜湊符合外層 manifest。預設 Electron 下載／解壓兩次停滯，暫時以本地已安裝同版 44.1.1 distribution 完成原發布管線，未改專案打包設定或門禁；失敗暫存保留。舊 `mv144njz-44120-a6636715/program` 被占用而清理失敗，原管線保留恢復目錄，未強制退出舊程式。
