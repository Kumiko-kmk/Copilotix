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

## 13. 文庫頁與 AI 解讀（2026-10-08）

- 工作區 `Copilotix-library-ui`／`ui/library-rhinelab`。`LibraryPage` 懶載入 Three.js；從文庫進閱讀器用 `returnTo: 'library'` 返回並恢復論文，其他入口仍返回任務管理。
- RhineLabUI（MIT，LBEILC）來源見 `THIRD_PARTY_NOTICES.md`、`paperArchive/RHINELABUI_LICENSE.txt`。GLB 只含五個外殼網格，用 `?inline`／`parseAsync`，CSP 不變。**不改 `archiveMotion.ts` 已校準曲線**；手感使用 Scene 彈簧速率調整。
- 按本地月份、新月新文在前；長月份分列（每列 4–8 篇，`ceil(n/5)` 列），列／行循環取最近位置並記住論文 ID。狀態色保留完成原色、處理中主色、部分完成琥珀、失敗紅色。搜尋按標題／原檔名分詞，最多 40 項；`/` 聚焦、Enter 選首項、Tab 選結果、Esc 收起，IME 組字不觸發選擇。搜尋定位取消慣性；WebGL 失敗仍可搜尋進閱讀器。
- 渲染契約：單一 rAF 迴圈（tick 期間 frame 非零）、按需約 60 fps，閒置呼吸用牆鐘判定；DPR ≤1.25、≤3.3M 像素，transmission 半解析度、陰影 1024。連續 6 幀超過 `max(23ms, 1.5×節拍)` 時降解析度 15%（下限 0.55），穩定 240 幀且 8 秒未降才回升 8%。外殼盒解析拾取、視錐／霧剔除、共享 instanceMatrix、僅 diffuser 投影、失焦／隱藏停渲染、reduced-motion 與 GPU 釋放保留。模型先 compileAsync 暖機；途經每張選中卡立即發漣漪（最多 6），升起 4.2／回落 4.5。HUD 僅 opacity／transform 動畫。使用者要求移除的「流暢模式」開關、保存與材質降檔不得恢復；固定磨砂透射，保留自動解析度。
- 抽取／解密：點選中卡、「查看档案」或 Enter 開詳情；hero 共用幾何、獨立材質，替代該實例並接管拾取。升起 4.05，detail 鏡頭方向 (-0.277,0.238,0.931)、距離 72、span 5.9；鏡頭進度 >0.6、升起 >3 後開始 0.9 秒掃描。首頁 1600px／LRU 6，內側透射與外側清晰副本同時揭開；內托盤漸變，關閉迅速重磨砂。詳情停拖曳／懸停／呼吸／漣漪；方向鍵／搜尋先收回再換卡，Esc／空白收回，Enter／hero／「打开阅读」進閱讀器。
- `ArchiveDetail` 僅抽取時掛載，共用 `['document', id]` 快取。`paperProfile` 提取標題、作者單位、摘要（譯文優先）、關鍵詞、頂層章節與圖表公式參考數；pdf.js 動態載入。欄位遮罩隨 opening／decrypting／open／closed 揭示。App 已傳入 `PaperInsightSource`，「03 AI 解读」接上真實 Main／Utility 管線；初始讀取不得覆蓋較新的事件，切文獻／卸載清理訂閱。
- AI 解讀完整契約、兼容與恢复語義見 `docs/PAPER_INSIGHT_ZH.md`。預設關閉自動生成，使用既有已驗證的 Qwen／DeepSeek 憑據與論文發送授權；按 translate succeeded 排隊，跳過未過期結果。每篇 single-flight、全域最多 2、可取消；刪文獻、文庫維護、退出須取消並等待落盤。`insight/insight.v1.json` 隨完整文獻備份、恢復、遷移與明確授權的卸載清理；不新增 migration／不改 manifest v1。
- 本地驗證（使用者授權）：95 個單元測試檔、639 項通過／3 項既有跳過；其後補充原子 rename 失敗測試，17 項解讀／IPC 測試再次通過。typecheck 通過；lint 0 errors／63 項既有 any 警告；四 bundle／Utility smoke 通過。Electron E2E：文庫正常／WebGL 降級 2 項，AI 解讀 1 項（真實設定／憑據 IPC，僅 mock provider HTTP，驗證缺 Key、遮罩完全退開後顯示內容、重開持久化與自動生成設定保存）。付費 API、遠端 CI、安裝生命週期未驗證；未 push。
- 性能診斷 Ctrl+Shift+F 顯示 fps、DPR×縮放、卡片／三角形與 GPU。此前 RTX 3060／2560×1600@165Hz 實測方向鍵 55 fps、拖曳 52–55 fps；Claude 的抽取實測約 1.35 秒。這些是本機歷史證據，不代表所有硬體。
- 本地測試包已重建：`release-artifacts/muzkeczu-41844-6fb59349/program/Copilotix.exe`（須保留整個 program 目錄）；同層 `Copilotix-1.1.0-win-x64.zip` 為 compact Setup，入口亦在 `release/setup.exe`。ASAR 23.65 MiB、runtime 353.33 MiB、ZIP 94.11 MiB；packaged smoke、fuses、內容／雜湊／體積門禁通過。官方 Electron 44.1.1 SHA-256 核對後用本地 ZIP 打包，以避免鏡像 TLS 中斷；临时 electronDist 已還原，未更改發布安全政策。ZIP SHA-256：`5976B2ACC148F4002FE997C4F22ECA35E13F23785D9608FC6F29D6B38E39D14E`。
