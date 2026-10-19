# 跨 Worktree Agent 協作文檔（永久保留）

本文件是分支與 Agent 的共同入口，不得刪除、改名或以其他文件取代。開始工作前閱讀；維護時保留有效契約，刪除過時進度與重複敘述，細節連到專項文檔。

## 協作規則

- 動手前與交付前執行 `git status --short --branch`，確認 worktree、分支及未提交內容；不得修改、清理、stash 或重置其他 Agent 的 worktree。
- Worktree 不共享未提交文件；跨分支傳遞須先 commit，再 merge、rebase 或 cherry-pick。
- 不要寫無意義的文檔。維護文檔主要供其他 agent 接手，使用者不會逐份閱讀；只保留當前契約、必要決策、限制、未完成需求與證據入口。不要每次改動都新建總結／審計／交付報告，不記對話、操作流水或重複貼測試輸出；優先更新既有入口，同一事實只留一處，過時內容直接清理。使用者要求的指南與法定許可資料按其用途保留。
- 使用者不喜歡滑鼠懸停時出現文字提示／浮層，包括原生 `title`、Tooltip、Popover 預覽與以全文補充截斷文字的彈窗。全應用不再添加這類說明；圖示仍保留 `aria-label`，必要資訊在頁面內或明確點擊後顯示。清單與實作邊界見 [介面偏好](docs/UI_PREFERENCES_ZH.md)。
- 共享 schema、migration、IPC、Core RPC、JobRepository、Artifact/PathPolicy 或發布腳本的修改，須記錄兼容策略、測試證據與恢復語義。
- 每次功能修改，只有使用者明確要求打包、EXE、安裝包或發布產物時才執行打包；未要求打包時，提供對應改動的實際介面截圖供使用者確認。截圖不代表完整測試驗收，不以示意圖或舊版本截圖代替。截圖與預覽須避開其他修改進程，優先使用隔離資料目錄／預覽，不重建或覆蓋其他進程正在使用的共享 out、不終止其他進程；無法隔離時如實說明。使用者明確要求不截圖時遵從，不追溯補拍先前改動。
- 預設不跑本地 lint、typecheck、單元／覆蓋率及 E2E。使用者要求驗證時，先跑受影響用例或 `desktop:test:changed`，需要核心回歸再跑 `desktop:test`；不要每個功能都重跑完整 UI、覆蓋率、打包和安裝驗收。2026-10-14 使用者已授權精簡測試：同類小用例合併，重複外觀／源碼字串檢查和過時流程可刪除；資料安全、持久化、IPC 來源與取消恢復等行為回歸保留。未明確授權不得 push、上傳產物或觸發遠端發布。

## 1. 本地 Windows 構建與交付

使用 Node **24.19.0**、根 `packageManager` 指定的 pnpm **11.19.0**。系統 Node 24.11.1 曾靜默崩潰並留下舊 out；不要使用。Codex fallback pnpm 版本可能不符，可用正確 Node 執行 Corepack 快取的 `11.19.0/bin/pnpm.mjs`，不得偽造 user-agent。

在倉庫根目錄執行：

```powershell
pnpm install                       # 新 worktree 或依賴／lockfile 改變時
pnpm desktop:build:bundles          # 源碼改動後重建 Main、Preload、Renderer、Utility
pnpm desktop:release:from-built     # 僅明確要求打包時執行；使用新 out，不與 desktop:release 並行
```

僅源碼與 `desktop/out/` 均未變更時，才可省略 build。打包內建的 ASAR、資源、fuses、體積、雜湊與 packaged smoke 校驗不可移除；成功後原子更新發布目錄，失敗保留 `.release-next-*` 供排查。

Electron 下載不可用時，可在本次 PowerShell 設 `$env:COPILOTIX_USE_INSTALLED_ELECTRON='1'` 再打包；只複製本 worktree 已安裝、版本與發行要求一致的 Electron `dist`，不修改依賴來源。預設下載路徑及所有打包門禁不變，版本不符仍失敗並保留 staging。使用後清除此環境變數。回歸入口：`releasePolicy.test.mjs`、`releaseTransaction.test.mjs`。

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
- 設定「主題外觀」：`theme.ts` 共六套（三淺三深，主題卡不加文字說明）寫入 :root 色 token（`--surface`／`--sheet`／`--ink`／`--on-ink`／`--primary`… 及文庫 3D 用 `--theme-archive-*`）；深色主題另切 antd darkAlgorithm、`color-scheme`、`--lift`、黑色 `--shadow-ink` 與 `--shell-edge`，PDF 頁面保持白紙。antd、canvas 與 Three.js 均從 token 讀色；主題與閱讀字號（13–22px，`--reader-font-size`，Markdown 正文、標題、表格按 em 縮放）點選即預覽，但屬設定草稿：經「保存全部更改」寫入 localStorage `copilotix.theme.v1`／`copilotix.reader.font-size.v1`，「放弃更改」或未保存離開即還原，並參與離開確認；只改外觀時不調用 settings IPC。新增顏色一律用 token，語義色（成功／警告／錯誤）、PDF 疊層與高亮色板除外。
- 使用者已選擇設定離開確認：應用內離開設定頁時，有草稿須提供「保存并离开／放弃并离开／继续编辑」。保存失敗或憑據部分失敗留在原頁並保留失敗欄位；未保存 API Key 僅留記憶體。設定內頁籤切換保留草稿、不彈確認。

## 4. 文檔庫維護契約

- 維護經 Main 原生選目錄與確認、IPC 維護鎖、Utility 持久化隊列；活動任務期間不可切庫。
- manifest v1、schema_migrations 與 SQLite 結構共同約束兼容。恢復先校驗並保留舊庫；遷移複製完成後才事務切換路徑，不自動刪除舊文檔目錄。
- API Key 不進備份。實現、恢復語義與回歸項見 `docs/LIBRARY_MANAGEMENT_ZH.md`。

## 5. 許可與簽名

- 自有代碼沿用根 `LICENSE.md` 的 MIT，不覆蓋第三方或歷史上游許可。
- 打包生成第三方許可匯總（包括開發依賴），並複製 MIT 與聲明到 `resources/licenses`；缺少許可文本須如實列出。
- 本機自簽僅供測試，不自動加入系統信任。正式政策與 SignPath 見 `docs/CODE_SIGNING_POLICY.md`、`docs/SIGNPATH_APPLICATION.md`。

## 6. Setup 交付契約

- 從 1.2.0 起，公開 Release 僅上傳 `setup.exe`，源碼由 GitHub 按 tag 提供 ZIP／tar.gz；不發布運行包 ZIP、SHA 或 manifest。下列緊湊 ZIP 與雜湊清單只作本地／CI 內部校驗，不刪除打包安全檢查。

- ZIP 為 compact-setup：根目錄含 Setup、`uninstall.exe`、安裝說明及小型 advanced 校驗文件；runtime 嵌入 Setup，不在 ZIP 重複放置，開發副本留在 `release-artifacts/<build-id>/program/`。
- schema 5：distribution 為 compact-setup，`runtime.embeddedIn` 標記內嵌；外層 `runtimeArtifactDirectory` 指向開發副本，`artifactDirectory` 指向 ZIP 目錄。ZIP 內 bundle-manifest 不含外部產物路徑或自身哈希；外層 release-manifest 在 ZIP 完成後加入 `transport.sha256`，不進 ZIP。成功只清理上一成功版本已驗證的產物路徑，失敗暫存保留。
- 強制目前使用者安裝，允許選位置。安裝／卸載發現應用運行時提示退出，不強制結束背景隊列。
- 卸載預設保留資料、憑據與獨立文庫；只有明確勾選清除、Main 第二次原生確認後，獨立 Utility 才按唯讀清單驗證並安全清理。覆蓋升級／靜默卸載不得清資料；新增憑據或儲存結構須同步卸載清單與路徑驗證。
- 安裝精靈視覺：`scripts/generate-installer-assets.ps1` 生成字陣風格的 sidebar（164×314）與內頁 header（150×57）BMP；完成頁有專案主頁連結。頁面順序、控件 ID 與歡迎／選項／完成頁文案不變（wizard 測試依賴）。
- Setup、主程式、內嵌卸載器均受正式簽章門禁。必要驗收入口：`pnpm desktop:test:installer:wizard`、`pnpm desktop:test:installer`；腳本拒絕覆蓋既有安裝。

## 7. 閱讀器、併發與問答契約

- Core RPC 只保留 Main 實際調用的 operation；新增能力採「Utility 生成 descriptor，Main 只傳 ID 與小結果」。可能隨文庫增長的列表一律分頁；`tasks:list`／`documents:list` 採 keyset `{ after? } → { items, next }`，每頁 ≤200 行、≤512 KiB。
- Utility SQLite operation 分 data、compute（`compute:*`）及獨佔生命週期（init／flush／close／library）通道；事務回調內不得 await。Main compute 用 `COMPUTE_RPC_TIMEOUT_MS` 與作業 signal 取消。
- JobScheduler 的 `job-changed(job)`／`job-notification(job)` 用 `job.documentId` 定位文檔；Main 高頻事件經 `createCoalescedRefresh` 合併刷新。Reader 給 MarkdownPane 的 blocks／annotations 用 `useMemo` 保持引用穩定。
- PDF 貼合完整 clientWidth，無外圍 padding／邊框／陰影、原生捲動條、頁間或末頁 gap；浮動捲動條支援拖曳／鍵盤且不佔位。透明欄分隔器覆蓋右欄。寬度／縮放／延遲尺寸改變時，layout effect 按頁號與頁內比例恢復，停用 overflow anchoring 並取消舊 frame；人工翻頁與引用定位正常更新頁碼。
- 問答共享入口：`docs/READER_AI_CHAT_PLAN_ZH.md`。文獻目錄 `chat/` 原子保存歷史、草稿、選區與模型，歷史分頁；問答文件本身無獨立 migration；Codex provider 使用資料庫 migration 5，不合併 demo schema 5–7。清空、刪文獻、文庫維護及退出前，須等待相關問答取消與落盤，避免晚到寫入。
- 問答沿用「服務連接」憑據，默認翻譯服務商，可獨立選已啟用 Qwen／DeepSeek 的共享預設模型或 Codex 動態目錄模型，不改翻譯模型；IPC／Main 校驗 provider、Key、valid；Codex 改驗本機登入／模型能力，不讀 API Key。舊 request 可省略 provider；舊 chatProvider 不參與路由，自訂模型回退預設而不損壞歷史，Key 不進聊天文件。首次打開問答才掛載／建索引；添加選區不切頁籤，恢復引用重新核對 revision。
- 只提供 PDF、原文、中文、問答四視圖，JSON 僅保留底層產物與 ZIP。`readerLayout.ts` 為 split／group 純函式樹，每視圖僅出現一次、最後一個不可關閉；localStorage `copilotix.reader.layout.v1` 校驗修復後載入，缺省「PDF｜原文·中文·問答」，首次沿用舊 sessionStorage 欄寬。
- 工作台分組最小 240×140；拆分、移動、關閉／重開、拖曳（5px 起拖、Esc 取消；邊緣四分之一拆分，中間合併）不得破壞唯一視圖。拖曳預覽走獨立 DragContext；分隔器拖動僅本地更新、放開提交。最大化純 CSS、其他分組保持掛載、不持久化；split pane 不设 position，分隔線用 ::after。
- Markdown 僅選中時掛載並恢復 `initialScrollTop`；PDF／問答首次顯示後保持掛載。工具列 portal 到所在分組；PdfPane 的 `toolbarHost`、`initialViewState`／`onViewStateChange` 保持移動／重開錨點。頂欄不再提供複製；另存作用於聚焦分組。
- 圖片分組（`readerFigureGroups.ts`）：MinerU 常把子圖拆成獨立圖塊、把 `(a) …` 子圖說誤標為 table_caption 或掛在別的圖下；子圖說按幾何視為圖內文字，不作屏障；`Figure N |`（Nature 式）視為圖說。仍無法確認 PDF 裁圖（無圖說／歧義／裁圖失敗）且子圖左右並排時，`ReaderFigureMosaic` 用解析出的子圖按 PDF 相對位置拼排並隱藏逐段原圖，不再逐行堆疊。改動須用真實文庫逐篇核對並排子圖歸屬。
- 選區工具列：高亮、下劃線、羽毛筆「写笔记」、加入問答。筆記存文獻目錄 `notes/notes.v1.json`（Core RPC `notes:list/upsert/delete`，IPC `reader-notes:*`），錨點同標註以 quote／前後文重定位；虛線底紋＋頁邊羽毛筆，懸停顯示並可直接編輯（使用者明確要求的唯一懸停例外，見介面偏好），點外部自動保存、Esc 放棄。問答選區發送後移入該輪並以 `userSelections` 告知模型，見問答入口文檔。
- 快捷鍵：Ctrl+1–4 顯示四視圖，Ctrl+反斜線右拆，Ctrl+Alt+←/→ 移組，Ctrl+W 關閉，Ctrl+Shift+T 重開，Ctrl+Shift+M／雙擊最大化，Esc 還原。
- `readerScrollSync.ts` 以 mappingId＋塊內比例對齊視口 35% 閱讀線；僅人工捲動領先，120ms 程式回聲不回報，每幀最多一次。參與者為分組選中且在 layout.synced 的視圖（預設原文＋中文、PDF 關閉、問答不參與）；PDF 用 `pdfSyncPosition`。引用無可見閱讀視圖時，`ensureReadingView` 在問答旁拆開／重開原文或中文／PDF，先還原最大化，不能取代問答。共用少量 mappingId 的合成夾具有歧義，同步／選段聯動須用真實解析資料驗收。

Codex 的進程隔離、交互 FIFO／后台 8 槽位、新臨時會話、取消／超時、migration 5 恢復與測試入口統一見 [架構文檔](docs/ARCHITECTURE_ZH.md#codex-provider本机-app-server)，使用步驟見 [服務配置](docs/wiki/Service-Setup.md)。

## 8. 遠端 CI 與驗證邊界

- 修改 → 本地 commit → 按需本地 build／交付；未授權不 push，未跑完整 CI 如實說明。授權上傳後檢查最新提交的 Actions，合併前 `build` 必須成功，PR 另須通過最新合併結果檢查；舊成功、跳過、取消皆不可替代。
- `.github/workflows/desktop-windows.yml` 覆蓋所有分支 push、PR、`desktop-v*` tag 及手動觸發；新分支須包含最新工作流。只 commit 不會觸發 Actions。
- 保留必需檢查名稱 `build`。完整驗證時 Electron E2E 在與 `build` 並行的三個 `e2e` 矩陣 job 執行，`build` 打包後只跑 packaged smoke；publish 同時依賴兩者。一般 push／PR 執行 frozen-lockfile、lint、typecheck、快速核心回歸、四 bundle 和源碼啟動 smoke；不預設打包、跑全套 UI／覆蓋率或安裝。`desktop-v*` tag 或手動勾選 `full_validation` 才跑覆蓋率、全部 Electron E2E、打包／安裝生命週期及下載校驗；tag 的版本、許可、簽章與打包內建安全校驗仍必需。
- `Copilotix-Windows-x64-Bundle` 供安裝驗收；`Copilotix-Windows-verification-reports` 保存 JUnit、覆蓋率及 packaged smoke 證據，`Copilotix-Windows-e2e-reports-<n>` 保存各 E2E 分片失敗證據。CI 未過不可稱已驗證包；CI 無個人 API 憑據，付費模型、視覺及硬體差異仍須真人驗收。

## 9. CI 與夾具維護

- Vitest 預設 ≤2 workers，Windows Playwright 單 worker；JUnit 放 `desktop/unit-test-results`。`desktop:test` 只跑核心 `.test.ts`；DOM／React 測試用 `.test.tsx`，由 `desktop:test:ui` 或 `desktop:test:full` 執行；發布腳本 `.test.mjs` 同樣只進完整回歸。新測試按功能加入現有套件，不為簡單 getter、動畫常數、CSS 或資料形狀再建文件。
- Windows 原子 rename 對 EPERM／EACCES／EBUSY 最多約 6.3 秒有界重試；永久錯誤 exit 1，不用 copy／delete 替代。packaged smoke 前須有 Setup、uninstaller、release-manifest、ZIP；其餘 E2E 只需 bundle。
- E2E 分片按 `desktop/playwright.config.ts` 的 `E2E_SHARDS` 實測時長分配（各單 worker），最後一片收下未列出的 spec；`COPILOTIX_E2E_SHARD` 為 `n/總數`，總數須與清單和工作流 matrix 一致，否則報錯。某片明顯變長時按 CI 日誌重新分配。
- 僅「未打包＋NODE_ENV=test＋COPILOTIX_E2E_USER_DATA」用獨立 native vault service；夾具只清理自身六種 account，不碰真人憑據。問答 E2E 經真實設定 IPC 存假 Key，僅 mock provider HTTP。
- 任務管理頁與首頁「繼續閱讀」已移除；閱讀器一般經 `openPaperFromLibrary`（文庫搜尋 → 結果 `data-document-id` → 瀏覽面板「打开阅读」，無 WebGL 時結果直接開啟）進入，等 reader-header（≤30 秒）及 Markdown ready 再互動，error 不算 ready；不加全局 retry／timeout 或降低斷言。從文庫進入的 Reader 返回文庫。
- 縮略圖截圖用直角 app-shell 與完整 CSS 像素裁切，channel delta ≤1、changedRatio ≤0.001；失敗保留 expected／actual PNG。

## 10. Markdown 公共格式與導出

- `docs/MARKDOWN_FORMAT_ZH.md` 定義格式、版本兼容、映射、原子導出與真實論文驗證；`standardMarkdown.ts` 共享規範為 CommonMark＋GFM＋明確數學擴展，不得將公式降級代碼。
- Markdown 導出攜帶相鄰圖片目錄及相對鏈接，圖片失敗不得覆蓋既有導出；原任務資料不可作導出目標。ZIP 同樣規範化兩份 Markdown。
- 對比交付只保留使用者要求的两份 Markdown；瀏覽器／CI 不替代 Notion Desktop 驗收。

## 11. 豐富閱讀與標準導出分離

- 解析、翻譯與閱讀保留 HTML／LaTeX 豐富結構，不展平合併表格。`prepareReaderMarkdown` 僅非結構性準備／圖片路徑修正；`normalizeMarkdown` 僅導出投影，不回寫源資料。
- 新翻譯計劃 v6，兼容合法 v4/v5/v6 manifest；v5 平面表格不可自動恢復，不自動重解析／重翻譯。映射、標註、資源及原子發布契約不變，詳見上述格式文檔。

## 12. 當前狀態與入口

- 當前開發入口為 `Copilotix-master-updated`／本地 `master`，包含文庫 UI 代碼與文檔。1.2.0 為本次發布目標；正式簽章與逐 tag 例外以 docs/CODE_SIGNING_POLICY.md 為準。
- 首頁背景為「解密字陣」`homeCipher.ts`：字元網格按字標實測字寬／行高對齊，避開前景塊；波浪只由開頁、點擊或 75–120 秒一次的自動波觸發，單向擴散不反彈，經 `homeWave.ts` 與字標逐字解碼同步；波後只浮現文庫論文的原文或譯文標題，不加編號（譯文標題閒時讀最近 10 篇，僅保留標題）；新波出發時上一波的標題 0.45 秒內淡出。待機字陣較密並持續閃爍、增減及零星紫色火花，避免被當成靜態背景。其餘六個背景方案原型（`gallery.html`）與舊等高線實作保存在 `docs/design/home-backdrops/`，不參與構建。
- README／Wiki 源在 `docs/wiki/`，不會隨目錄提交自動發布；遠端上傳須另獲授權。真人模型／視覺驗收不能以 mock 或歷史 CI 替代。

## 13. 文庫頁與 AI 解讀

### 資訊與資料

- 圖片 AI 解讀提供 `window.copilotix.figureInsight.get/generate/cancel/onChanged`，模型只返回 `displayWeight`（唯一綜合展示分數）、`overview`、`takeaway`；不加封面評分／理由／supports。每張結果存 `<文獻目錄>/insight/figures/<SHA256(figureId)>.v1.json`，位置、圖片雜湊和來源版本由程序附加；封面依現有結果讀取排序，不觸發生成，尚無獨立解析窗口或自動批次上傳。2026-10-11 已授權 DeepSeek 六篇共 39 張整圖，39/39 返回並保存，逐圖結果／示例在 `../investigation/figure-insight-live-20261011/`。原 PNG 定位與傳輸 JPEG98 身份須區分；接口、兼容、傳輸及驗證邊界只在 [圖片 AI 解讀](docs/FIGURE_INSIGHT_ZH.md) 維護。
- `LibraryPage` 懶載入 Three.js；從文庫進 Reader 用 `returnTo: 'library'` 返回並恢復論文，從教程進入返回教程，其他入口返回首頁。重試與刪除論文在閱讀器頂欄（`DocumentLifecycleActions`）。RhineLabUI 來源與 MIT 許可見 `THIRD_PARTY_NOTICES.md`、`paperArchive/RHINELABUI_LICENSE.txt`；GLB 僅五個外殼網格，沿用 inline／parseAsync 和原 CSP。
- 每分類一列，列／行循環並記住論文 ID；右下角列數等於分類數，分類名十二字固定寬度居中，箭頭位置固定。分類算法、分頁與緩存只在 [內容分類](docs/LIBRARY_CATEGORIES_ZH.md) 維護。
- 瀏覽標題移除末尾 `.pdf`，固定兩行高度、單行垂直居中、超出省略；譯文標題固定一行，沒有譯文留空。停留選中論文 180ms 後讀取，與詳情共用 query cache；不另調模型。
- 選中頁元信息只含單行關鍵詞（空格分隔，按寬度縮至 11px，仍超出省略）及下方總結（v2 `tldr`／v1 `summary`）；不顯示類型、日期、生成狀態。詳情標題下同樣顯示譯文標題，不重複類型／學科／總結；證據基礎與檢驗方式在新舊檔案展示均不顯示，舊字段只作存儲兼容。
- 詳情 v2 依「摘要／背景／結論／討論」顯示；正文統一 16px、首行縮排兩字，背景每點顯示短標題。新舊檔案均不顯示證據基礎／檢驗方式。選區提供共用高亮、下劃線及筆記，不提供加入對話；archive 區塊鍵與原文隔離，保存與重定位邊界見 [Paper Brief](docs/PAPER_BRIEF_ZH.md)。新摘要由全文生成，舊檔仍回退譯文，缺失明示；ABSTRACT 不參與遮擋，正文仍沿用解密動畫。詳情延伸至頁面底部，「打开阅读」靠下，隱藏捲動條並保留滾輪／鍵盤捲動。生成操作在閱讀器「AI 问答」頁籤工具列的「档案卡」點擊選單。HTTP(S) 連結保留目標、下劃線且可換行。無 v2 時保留結構／舊解讀頁；v2 分頁與生成欄位以 [Paper Brief](docs/PAPER_BRIEF_ZH.md) 為準。
- 生成授權、取消、併發、存儲與兼容只在 [AI 檔案卡](docs/PAPER_INSIGHT_ZH.md) 維護。解析完成後與翻譯並行生成，翻譯完成事件補足恢復；自動生成已恆為開啟、不提供開關；使用程序即同意發送所需內容，不再獨立確認；發送前仍核對啟用服務、模型與憑據。既有 15 篇真實生成結果已保存，批次證據在 `../investigation/paper-brief-bulk-20261010/SUMMARY.md`，不代表人工品質驗收。
- 發布時間戳由 `runtime-file-times.mjs` 只更新 staging runtime，避免 Electron 資源顯示 1980 年；不修改依賴、內容、簽章或用戶文庫。

### 互動與渲染

- 不改 `archiveMotion.ts` 已校準曲線。單一 rAF、約 60fps，牆鐘待機，失焦／隱藏停渲染；reduced-motion 直接完成動畫（含漣漪增益），卸載時釋放 GPU。每幀動畫步長上限 `MAX_STEP_SECONDS` 0.25 秒：舊 0.05 秒上限在軟體渲染下把過場拉長數十倍並以多秒重幀阻塞輸入（1.2.0 CI 點擊卡死的實測主因），不得改回。選中論文停留 400ms 後才準備圖片／封面（`useArchivePreparation`），快速翻閱不渲染 PDF；本次會話已確認的整圖不再逐圖查詢 Main。封面首頁按 PDF 內容雜湊存於 renderer IndexedDB `copilotix-archive-pages`（≤160 頁，WebP，失敗回退重繪），關鍵圖頁仍按當前整圖與解讀合成；pdf.js 全應用共用單一 worker（傳入 `worker`，不用會隨文獻銷毀的 `workerPort`）。不得恢復「流暢模式」或材質降檔；未採用效果只在 [動畫候選](docs/LIBRARY_MOTION_IDEAS_ZH.md) 記錄。
- 瀏覽 DPR ≤1.25／≤3.3M 像素，透射半解析度、陰影 1024；6 幀超時降解析度 15%（下限 0.55），穩定 240 幀且 8 秒未降再升 8%。保留解析拾取、剔除、共享 instanceMatrix、compileAsync 暖機；途經選中卡漣漪最多 6，升起 4.2／回落 4.5。
- 抽出沿用單一 hero、4.05 升起與 detail 鏡頭；鏡頭 >0.6、升起 >3 才解密。標記以 4.8 倍速、玻璃清除以 2.4 倍速，清除前緣羽化 0.12；`onDecryptReveal` 啟動文字揭開。首頁 1600px／LRU 6，按需載入 PDF／資料／解讀；換篇或卸載取消晚到結果與訂閱。
- `lineRedaction.ts` 等文字與檔案卡載入後揭開；遮擋期間正文以 `data-redacted` 不繪製（面板淡入時不可透出），墨條開始右滑時才恢復。ResizeObserver 首次回報不算版面變化；ResizeObserver／MutationObserver 忽略遮擋層，重新量測所有可見文字（含部分末行），滑出途中版面改變就移除遮擋。逐行退場 0.95 秒，閱讀順序曲線與卡片解密時間不變；reduced-motion 不畫墨條。詳情標題與譯名不遮擋：opening 時捕捉瀏覽面板標題位置與字級，先平移縮放進詳情標題區（延遲 120ms、440ms），其餘內容與遮擋層 460ms 後一起淡入上移（300ms），標題不會穿過墨條；closing 時內容 120ms 淡出、標題 180ms 退回。瀏覽面板的關鍵詞／總結按論文快取且總結固定三行高，返回時面板整體淡入、不重播標題滾動；`returning` 標記跟隨論文 ID 直到換篇，不可用計時器移除（會重播動畫）。標題左對齊。文庫全區文字兩端對齊（居中標籤除外），遮擋條隨之齊整。
- Enter 忽略 repeat，抽出／解密中不進 Reader，完全展開後再次 Enter 或「打开阅读」進入；點擊已展開封面、Enter 與「打开阅读」共用可取消的閱讀器入口：先預載閱讀器（10 秒超時），主場景封面推進／放大 4%（280ms）後切頁，閱讀器淡入 180ms；Esc 取消待完成跳轉，減少動態效果直接切換。預載失敗留在文庫並可重試，不掛載第二個閱讀器或 3D 場景。抽出卡片封面為「首頁＋關鍵圖片」跨頁，選圖與排版見 [圖片 AI 解讀](docs/FIGURE_INSIGHT_ZH.md)「文庫封面」。移動 ≥8px、pointercancel／lostpointercapture 不觸發點擊。詳情分頁左右／Home／End 移焦，正文方向鍵保留捲動，僅瀏覽區方向鍵換卡。
- 搜尋按標題／原檔名分詞，最多 40 項；`/` 聚焦，Enter 選首項，Tab 選結果，IME 不誤觸並取消慣性。瀏覽 Esc 先收搜尋；抽出期間檢索收合且 inert、結果關閉，Esc 關詳情並移焦回文庫。收合 0.24 秒內完成，詳情拉伸延遲 120ms 才到達頂部，兩者不交疊；返回時詳情先淡出，橫線 0.2 秒後展開、文字 0.38 秒後展開。搜尋結果與選中頁關鍵詞／總結載入時淡入；詳情分頁以單一滑動指示線切換。WebGL 失敗仍可搜尋進 Reader。
- `closing` 保留舊文獻／封面／模型：面板 180ms 淡出且 inert，模型／鏡頭 320ms 收回後卸載。僅一個待選目標，方向輸入累積、搜尋覆蓋；目標移除即取消，收回中重開同篇接續姿態並清掉待選；reduced-motion 直接收回。
- `entryScanTime` 把入場掃描平段壓至約 0.25 秒；肩部在滑入結束時升起。`ARRAY_SCREEN_SHIFT` 將選中卡移向左下（-4%／10% 視口）；瀏覽／詳情共用 `--archive-panel-left` 與 `--archive-detail-width`。
- `onDetailFrame` 寫入 `--archive-detail-top/height` 供 floor veil 遮蓋陣列；詳情頂端與品牌對齊、底端保留 26px 頁面邊距，分頁高度固定，僅正文捲動。不加裝飾框線；返回按鈕在卡片下方。標題位置必須在 opening 時從仍掛載的瀏覽面板捕捉；reduced-motion 跳過。
- 展開後 ≤8.3M 像素，用 2 倍顯示器 DPR，放不下回原生 DPR（≤2），透射全解析度；靜止不重繪，收回恢復瀏覽上限。`applyResolution` 只標記，下一幀開頭 `flushResolution` 後立即渲染，禁止在幀間直接改緩衝區尺寸造成空白幀；首頁貼圖按展開後設備像素高度重採樣。
