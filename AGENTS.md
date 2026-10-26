# 跨 Worktree Agent 協作文檔（永久保留）

本文件是分支與 Agent 的共同入口，不得刪除、改名或以其他文件取代。開始工作前閱讀；維護時保留有效契約，刪除過時進度與重複敘述，細節連到專項文檔。

## 協作規則

- 動手前與交付前執行 `git status --short --branch`，確認 worktree、分支及未提交內容；不得修改、清理、stash 或重置其他 Agent 的 worktree。
- Worktree 不共享未提交文件；跨分支傳遞須先 commit，再 merge、rebase 或 cherry-pick。
- 不要寫無意義的文檔。維護文檔主要供其他 agent 接手，使用者不會逐份閱讀；只保留當前契約、必要決策、限制、未完成需求與證據入口。不要每次改動都新建總結／審計／交付報告，不記對話、操作流水或重複貼測試輸出；優先更新既有入口，同一事實只留一處，過時內容直接清理。使用者要求的指南與法定許可資料按其用途保留。
- 使用者不喜歡滑鼠懸停時出現文字提示／浮層，包括原生 `title`、Tooltip、Popover 預覽與以全文補充截斷文字的彈窗。全應用不再添加這類說明；圖示仍保留 `aria-label`，必要資訊在頁面內或明確點擊後顯示。僅閱讀器筆記與正文引用的參考文獻卡兩處為使用者要求的例外。清單與實作邊界見 [介面偏好](docs/UI_PREFERENCES_ZH.md)。
- 共享 schema、migration、IPC、Core RPC、JobRepository、Artifact/PathPolicy 或發布腳本的修改，須記錄兼容策略、測試證據與恢復語義。
- 每次功能修改，只有使用者明確要求打包、EXE、安裝包或發布產物時才執行打包；未要求打包時，提供對應改動的實際介面截圖供使用者確認。截圖不代表完整測試驗收，不以示意圖或舊版本截圖代替。截圖與預覽須避開其他修改進程，優先使用隔離資料目錄／預覽，不重建或覆蓋其他進程正在使用的共享 out、不終止其他進程；無法隔離時如實說明。使用者明確要求不截圖時遵從，不追溯補拍先前改動。
- 預設不跑本地 lint、typecheck、單元／覆蓋率及 E2E。使用者要求驗證時跑 `desktop:test`（只跑受改動影響的用例＋必跑安全集），需要全量時才跑 `desktop:test:full`；不要每個功能都重跑完整 UI、覆蓋率、打包和安裝驗收。2026-10-14 使用者已授權精簡測試：同類小用例合併，重複外觀／源碼字串檢查和過時流程可刪除；資料安全、持久化、IPC 來源與取消恢復等行為回歸保留。未明確授權不得 push、上傳產物或觸發遠端發布。

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
- Runtime 上限 **360 MiB**，Electron 約占 330 MiB；2026-10-22 起依使用者要求暫列 `ADVISORY_RELEASE_LIMITS`（`release-policy.mjs`），超出只警告不失敗，app.asar／ZIP／Setup 上限仍為硬門禁，恢復時從清單移除即可。Renderer-only 套件放 `devDependencies`；Main 純 JS 優先由 electron-vite externalize `exclude` 打入 bundle；原生或刻意外部化套件才留 `dependencies`。

## 2. 文檔格式接口（PDF / Markdown）

- 現階段導入、解析、閱讀正式支持 PDF。列表僅按 `originalName` 顯示 `.md`／`.markdown` 為 Markdown，其餘舊記錄兼容顯示 PDF。
- 正式接入 Markdown 時，在 IPC、Core RPC、資料庫及 migration 加入 `sourceFormat: 'pdf' | 'markdown'` 並回填舊資料，不得長期依賴副檔名推斷。
- Markdown 導入接受 UTF-8 `.md`／`.markdown`（`text/markdown`），經 PathPolicy 原子落盤及摘要校驗，不走 PDF 上傳／解析器；在標準化邊界產生 canonical Markdown artifact。
- 保持 PDF／舊資料可讀，維護重複判定、狀態投影、刪除／重試、artifact revision 及恢復測試。

## 3. 設定頁與新 UI 對齊

- 以「服務連結」內容區為尺寸基準：頁籤根節點是 `.settings-content-body` 的直接子元素，使用 `.settings-section` 並填滿可用寬高。
- 不重複導覽標題、不用空白標題佔位、不加專屬外層 margin／padding／max-width；首張卡片的頂、左、右邊緣須與基準一致。
- 卡片內距可自訂；以 `section`／`aria-label` 保留與導覽一致的區域名稱。測試驗證可按名稱查找、無重複標題及共用根類別。
- 設定「显示设置」（原「主題外觀」）：整頁限一個視窗高度、不捲動；上方淺／深兩組主題並排、各三張小卡（窄卡隱藏英文名），下方「阅读」區含字號、行間距與共用預覽。`theme.ts` 主題共六套（三淺三深，主題卡不加文字說明）寫入 :root 色 token（`--surface`／`--sheet`／`--ink`／`--on-ink`／`--primary`… 及文庫 3D 用 `--theme-archive-*`）；深色主題另切 antd darkAlgorithm、`color-scheme`、`--lift`、黑色 `--shadow-ink` 與 `--shell-edge`，PDF 頁面保持白紙。antd、canvas 與 Three.js 均從 token 讀色；主題、閱讀字號（13–22px，`--reader-font-size`，Markdown 正文、標題、表格按 em 縮放）與行間距（1.4–2.4 倍，步長 0.1，預設 1.8，`--reader-line-height` 作用於 `.markdown-body`）點選即預覽，但屬設定草稿：經「保存全部更改」寫入 localStorage `copilotix.theme.v1`／`copilotix.reader.font-size.v1`／`copilotix.reader.line-height.v1`，「放弃更改」或未保存離開即還原，並參與離開確認；只改外觀時不調用 settings IPC。新增顏色一律用 token，語義色（成功／警告／錯誤）、PDF 疊層與高亮色板除外。
- 使用者已選擇設定離開確認：應用內離開設定頁時，有草稿須提供「保存并离开／放弃并离开／继续编辑」。保存失敗或憑據部分失敗留在原頁並保留失敗欄位；未保存 API Key 僅留記憶體。設定內頁籤切換保留草稿、不彈確認。

## 4. 文檔庫維護契約

- 維護經 Main 原生選目錄與確認、IPC 維護鎖、Utility 持久化隊列；活動任務期間不可切庫。
- manifest v1、schema_migrations 與 SQLite 結構共同約束兼容。恢復先校驗並保留舊庫；遷移複製完成後才事務切換路徑，不自動刪除舊文檔目錄。
- API Key 不進備份。實現、恢復語義與回歸項見 `docs/LIBRARY_MANAGEMENT_ZH.md`。

## 5. 許可與簽名

- 自有代碼沿用根 `LICENSE.md` 的 MIT，不覆蓋第三方或歷史上游許可。
- 打包生成第三方許可匯總（包括開發依賴），並複製 MIT 與聲明到 `resources/licenses`；缺少許可文本須如實列出。
- 本機自簽僅供測試，不自動加入系統信任。正式政策與 SignPath 見 `docs/CODE_SIGNING_POLICY.md`、`docs/LICENSE_AND_SIGNING_ZH.md`。

## 6. Setup 交付契約

- 從 1.2.0 起，公開 Release 僅上傳 `setup.exe`，源碼由 GitHub 按 tag 提供 ZIP／tar.gz；不發布運行包 ZIP、SHA 或 manifest。下列緊湊 ZIP 與雜湊清單只作本地／CI 內部校驗，不刪除打包安全檢查。

- ZIP 為 compact-setup：根目錄含 Setup、`uninstall.exe`、安裝說明及小型 advanced 校驗文件；runtime 嵌入 Setup，不在 ZIP 重複放置，開發副本留在 `release-artifacts/<build-id>/program/`。
- schema 5：distribution 為 compact-setup，`runtime.embeddedIn` 標記內嵌；外層 `runtimeArtifactDirectory` 指向開發副本，`artifactDirectory` 指向 ZIP 目錄。ZIP 內 bundle-manifest 不含外部產物路徑或自身哈希；外層 release-manifest 在 ZIP 完成後加入 `transport.sha256`，不進 ZIP。成功只清理上一成功版本已驗證的產物路徑，失敗暫存保留。
- 強制目前使用者安裝，允許選位置。安裝／卸載發現應用運行時提示退出，不強制結束背景隊列。
- 卸載預設保留資料、憑據與獨立文庫；只有明確勾選清除、Main 第二次原生確認後，獨立 Utility 才按唯讀清單驗證並安全清理。覆蓋升級／靜默卸載不得清資料；新增憑據或儲存結構須同步卸載清單與路徑驗證。
- 安裝精靈視覺：`scripts/generate-installer-assets.ps1` 生成字陣風格的 sidebar（164×314）與內頁 header（150×57）BMP；完成頁有專案主頁連結。頁面順序、控件 ID 與歡迎／選項／完成頁文案不變（wizard 測試依賴）。
- Setup、主程式、內嵌卸載器均受正式簽章門禁。必要驗收入口：`pnpm desktop:test:installer:wizard`、`pnpm desktop:test:installer`；腳本拒絕覆蓋既有安裝。

## 7. 閱讀器、併發與問答契約

- Core RPC 只保留 Main 實際調用的 operation；完整註冊表在 `desktop/src/app/contract/coreRpc.ts`（由平台、作業與功能各自聲明的 operation 組合），Main／Utility 經構造參數取得綁定的 protocol，`platform/` 不認識具體功能；新增能力採「Utility 生成 descriptor，Main 只傳 ID 與小結果」。可能隨文庫增長的列表一律分頁；`tasks:list`／`documents:list` 採 keyset `{ after? } → { items, next }`，每頁 ≤200 行、≤512 KiB。
- Utility SQLite operation 分 data、compute（`compute:*`）及獨佔生命週期（init／flush／close／library）通道；事務回調內不得 await。Main compute 用 `COMPUTE_RPC_TIMEOUT_MS` 與作業 signal 取消。
- JobScheduler 的 `job-changed(job)`／`job-notification(job)` 用 `job.documentId` 定位文檔；Main 高頻事件經 `createCoalescedRefresh` 合併刷新。Reader 給 MarkdownPane 的 blocks／annotations 用 `useMemo` 保持引用穩定。
- PDF 貼合完整 clientWidth，無外圍 padding／邊框／陰影、原生捲動條、頁間或末頁 gap；浮動捲動條支援拖曳／鍵盤且不佔位。透明欄分隔器覆蓋右欄。寬度／縮放／延遲尺寸改變時，layout effect 按頁號與頁內比例恢復，停用 overflow anchoring 並取消舊 frame；人工翻頁與引用定位正常更新頁碼。
- 問答共享入口：`docs/READER_AI_CHAT_PLAN_ZH.md`（含圖片加入問答，§5a）。文獻目錄 `chat/` 原子保存歷史、草稿、選區與模型，歷史分頁；問答文件本身無獨立 migration；Codex provider 使用資料庫 migration 5，不合併 demo schema 5–7。清空、刪文獻、文庫維護及退出前，須等待相關問答取消與落盤，避免晚到寫入。
- 問答沿用「服務連接」憑據，默認翻譯服務商，可獨立選已啟用 Qwen／DeepSeek 的共享預設模型或 Codex 動態目錄模型，不改翻譯模型；IPC／Main 校驗 provider、Key、valid；Codex 改驗本機登入／模型能力，不讀 API Key。舊 request 可省略 provider；舊 chatProvider 不參與路由，自訂模型回退預設而不損壞歷史，Key 不進聊天文件。首次打開問答才掛載／建索引；添加選區不切頁籤，恢復引用重新核對 revision。
- 只提供 PDF、原文、中文、問答四視圖，JSON 僅保留底層產物與 ZIP。`readerLayout.ts` 為 split／group 純函式樹，每視圖僅出現一次、最後一個不可關閉；localStorage `copilotix.reader.layout.v1` 校驗修復後載入，缺省「PDF｜原文·中文·問答」，首次沿用舊 sessionStorage 欄寬。
- 工作台分組最小 240×140；拆分、移動、關閉／重開、拖曳（5px 起拖、Esc 取消；邊緣四分之一拆分，中間合併）不得破壞唯一視圖。拖曳預覽走獨立 DragContext；分隔器拖動僅本地更新、放開提交。最大化純 CSS、其他分組保持掛載、不持久化；split pane 不设 position，分隔線用 ::after。
- Markdown 僅選中時掛載並恢復 `initialScrollTop`；PDF／問答首次顯示後保持掛載。工具列 portal 到所在分組；PdfPane 的 `toolbarHost`、`initialViewState`／`onViewStateChange` 保持移動／重開錨點。頂欄不再提供複製；另存作用於聚焦分組。
- 圖片分組（`readerFigureGroups.ts`）：MinerU 常把子圖拆成獨立圖塊、把 `(a) …` 子圖說誤標為 table_caption 或掛在別的圖下；子圖說按幾何視為圖內文字，不作屏障；`Figure N |`（Nature 式）視為圖說；這類圖說緊貼其上方一行子圖時，按該行寬度展開成分隔，只認上方子圖（右側列不再串到下一張圖，解析器跨圖說的錯誤父子關係忽略；npj Fig. 5–7，21 篇真實文庫逐篇對比僅這三張改變）。仍無法確認 PDF 裁圖（無圖說／歧義／裁圖失敗）且子圖左右並排時，`ReaderFigureMosaic` 用解析出的子圖按 PDF 相對位置拼排並隱藏逐段原圖，不再逐行堆疊。改動須用真實文庫逐篇核對並排子圖歸屬。圖組預設顯示 PDF 裁圖（有圖說的 complete／ambiguous；無圖說 unsupported 保留解析圖）；圖組下方不放按鈕，右鍵選單可「以解析子图显示／以 PDF 原图显示」、加入問答、在 PDF 中查看、刪除此圖（連同圖說各段），按圖（geometry ID）存文獻目錄 `reader/figure-display.v1.json`（IPC `reader-figure-display:get/set`，無 migration，損壞視為自動），選回自動結果即清除；只覆寫顯示狀態，不改裁圖產物。
- 選區工具列：高亮、下劃線、羽毛筆「写笔记」、加入問答。筆記存文獻目錄 `notes/notes.v1.json`（Core RPC `notes:list/upsert/delete`，IPC `reader-notes:*`），錨點同標註以 quote／前後文重定位；虛線底紋＋頁邊羽毛筆，懸停顯示並可直接編輯（使用者明確要求的懸停例外之一，見介面偏好），點外部自動保存、Esc 放棄。問答選區發送後移入該輪並以 `userSelections` 告知模型，見問答入口文檔。
- 正文引用（第二個懸停例外）：`readerCitations.ts` 從論文自身的 References 區塊（標題範圍，或無標題時從 1 起、像參考文獻的編號段落；容許雙欄亂序、跨頁續行與合併段）建立「標記 → 條目」索引，識別方括號數字（含區間／列表、全形括號）、上標數字（僅在正文不用方括號引用時，作者行的單位上標排除）與作者年份（敘述式／括號式，中文「等人」、全形標點）；完全本地，對不上不標記。`ReaderCitations.tsx` 以 CSS Highlight 標色、caret 命中測試懸停顯示條目（另一視圖文字不同時並列），點擊經選區同步跳到條目並閃爍高亮。PDF 視圖未做（無鏈接注釋層）。邊界見介面偏好。
- 快捷鍵：Ctrl+1–4 顯示四視圖，Ctrl+反斜線右拆，Ctrl+Alt+←/→ 移組，Ctrl+W 關閉，Ctrl+Shift+T 重開，Ctrl+Shift+M／雙擊最大化，Esc 還原。
- `readerScrollSync.ts` 以 mappingId＋塊內比例對齊視口 35% 閱讀線；僅人工捲動領先，120ms 程式回聲不回報，每幀最多一次。參與者為分組選中且在 layout.synced 的視圖（預設原文＋中文、PDF 關閉、問答不參與）；PDF 用 `pdfSyncPosition`。引用無可見閱讀視圖時，`ensureReadingView` 在問答旁拆開／重開原文或中文／PDF，先還原最大化，不能取代問答。共用少量 mappingId 的合成夾具有歧義，同步／選段聯動須用真實解析資料驗收。

Codex 的進程隔離、交互 FIFO／后台 8 槽位、新臨時會話、取消／超時、migration 5 恢復與測試入口統一見 [架構文檔](docs/ARCHITECTURE_ZH.md#codex-provider本机-app-server)，使用步驟見 [服務配置](docs/wiki/Service-Setup.md)。

## 8. 遠端 CI 與驗證邊界

- 修改 → 本地 commit → 按需本地 build／交付；未授權不 push，未跑完整 CI 如實說明。授權上傳後檢查最新提交的 Actions，合併前 `build` 必須成功，PR 另須通過最新合併結果檢查；舊成功、跳過、取消皆不可替代。
- `.github/workflows/desktop-windows.yml` 覆蓋 master push、所有 PR、`desktop-v*` tag 及手動觸發；功能分支開 PR 後由合併結果檢查，避免同一提交重跑 push／PR。未開 PR 的分支可手動驗證；新分支須包含最新工作流。只 commit 不會觸發 Actions。
- 保留必需檢查名稱 `build`。完整驗證時 Electron E2E 在與 `build` 並行的三個 `e2e` 矩陣 job 執行，最短的第 1 片先執行完整單元／UI／發布腳本回歸與覆蓋率；`build` 顯式安裝 Electron 後構建，打包後只跑 packaged smoke。publish 同時依賴 build 和全部 e2e（含覆蓋率），任一失敗不可發布。一般 master push／PR 執行 frozen-lockfile、lint、typecheck、模組依賴規則（`desktop:deps`，ADR-0001）、受影響單元測試（相對 PR 目標或上一個 master 提交）＋必跑安全集、四 bundle 和 smoke＋按路徑映射的受影響 E2E（2026-10-22 使用者要求只測改動部分；CI 選擇邏輯尚未在遠端驗證）；不預設打包、跑全套 UI／覆蓋率或安裝。`desktop-v*` tag 或手動勾選 `full_validation` 才跑覆蓋率、全部 Electron E2E、打包／安裝生命週期及下載校驗；tag 的版本、許可、簽章與打包內建安全校驗仍必需。
- `Copilotix-Windows-x64-Bundle` 供安裝驗收；`Copilotix-Windows-verification-reports` 保存 build 的 JUnit、Playwright HTML 與安裝驗收證據；`Copilotix-Windows-e2e-reports-<n>` 保存各片 Playwright HTML／失敗證據，第 1 片另存完整回歸 JUnit 與覆蓋率摘要。CI 未過不可稱已驗證包；CI 無個人 API 憑據，付費模型、視覺及硬體差異仍須真人驗收。

## 9. CI 與夾具維護

- Vitest 預設 ≤2 workers，Windows Playwright 單 worker；JUnit 放 `desktop/unit-test-results`。`desktop:test`／`desktop:test:e2e:affected` 由 `scripts/affected-tests.mjs` 選擇受影響用例（三類測試檔都按 import 圖，E2E 按路徑映射），必跑安全集、全量觸發條件與映射見 [開發文檔](docs/DESKTOP_DEVELOPMENT_ZH.md#测试与实际门禁)；`desktop:test:full`、`desktop:test:e2e:full`、tag 與 `full_validation` 仍為全量，發布前必須全量通過。新增資料安全類測試檔時同步加入必跑集。新測試按功能加入現有套件，不為簡單 getter、動畫常數、CSS 或資料形狀再建文件。
- Windows 原子 rename 對 EPERM／EACCES／EBUSY 最多約 6.3 秒有界重試；永久錯誤 exit 1，不用 copy／delete 替代。packaged smoke 前須有 Setup、uninstaller、release-manifest、ZIP；其餘 E2E 只需 bundle。
- E2E 分片按 `desktop/playwright.config.ts` 的 `E2E_SHARDS` 實測時長分配（各單 worker），最後一片收下未列出的 spec；`COPILOTIX_E2E_SHARD` 為 `n/總數`，總數須與清單和工作流 matrix 一致，否則報錯。某片明顯變長時按 CI 日誌重新分配。
- 僅「未打包＋NODE_ENV=test＋COPILOTIX_E2E_USER_DATA」用獨立 native vault service；夾具只清理自身六種 account，不碰真人憑據。問答 E2E 經真實設定 IPC 存假 Key，僅 mock provider HTTP。
- 任務管理頁與首頁「繼續閱讀」已移除；閱讀器一般經 `openPaperFromLibrary`（文庫搜尋 → 結果 `data-document-id` → 瀏覽面板「打开阅读」，無 WebGL 時結果直接開啟）進入，等 reader-header（≤30 秒）及 Markdown ready 再互動，error 不算 ready；不加全局 retry／timeout 或降低斷言。從文庫進入的 Reader 返回文庫。
- 縮略圖截圖用直角 app-shell 與完整 CSS 像素裁切，channel delta ≤1、changedRatio ≤0.001；失敗保留 expected／actual PNG。

## 10. Markdown 公共格式與導出

- `docs/MARKDOWN_FORMAT_ZH.md` 定義格式、版本兼容、映射、原子導出與真實論文驗證；`standardMarkdown.ts` 共享規範為 CommonMark＋GFM＋明確數學擴展，不得將公式降級代碼。
- Markdown 導出攜帶相鄰圖片目錄及相對鏈接，圖片失敗不得覆蓋既有導出；原任務資料不可作導出目標。ZIP 同樣規範化兩份 Markdown。
- 對比交付只保留使用者要求的两份 Markdown；瀏覽器／CI 不替代 Notion Desktop 驗收。
- 閱讀器內編輯與整段刪除是獨立的使用者編輯層（`edits/markdown-edits.v1.json`），解析、修復與翻譯不得改寫或覆蓋它；閱讀、翻譯、問答與導出都須套用。段落／圖組長按拖曳排序存同檔可選 `order`（整份排列＋塊數，塊數不符即忽略；旧版遇此欄位視為不可讀，恢復原始順序即移除）。契約見上述格式文檔「阅读器内编辑与整段删除」。

## 11. 豐富閱讀與標準導出分離

- 解析、翻譯與閱讀保留 HTML／LaTeX 豐富結構，不展平合併表格。`prepareReaderMarkdown` 僅非結構性準備／圖片路徑修正；`normalizeMarkdown` 僅導出投影，不回寫源資料。
- 新翻譯計劃 v6，兼容合法 v4/v5/v6 manifest；v5 平面表格不可自動恢復，不自動重解析／重翻譯。映射、標註、資源及原子發布契約不變，詳見上述格式文檔。

## 12. 當前狀態與入口

- **進行中：1.3.0 功能模組化 milestone**，進度與退出標準見 [MILESTONE_1_3_ZH.md](docs/MILESTONE_1_3_ZH.md)，目標結構與依賴規則見 [ADR-0001](docs/adr/0001-feature-modules.md)。期間重構只由一個 agent 執行、只搬代碼不改行為；代碼只在三處：`desktop/src/app/`（Main／Preload／Renderer／Utility 入口與組裝、Core RPC 註冊表、`CopilotixDesktopApi`）、`desktop/src/platform/<關注點>/<層>/`（ipc、rpc、jobs、database、files、log、network、assets、credentials、uninstall、codex、markdown、pdf）、`desktop/src/features/<模組>/<層>/`（library、parsing、translation、reader、chat、insight、zotero、settings，各有 README），舊 `shared/`、`core/`、`main/` 等目錄與 `@shared` 等別名已移除；測試按同樣結構放在 `desktop/tests/{app,platform,features/<模組>}/`，`pnpm desktop:deps` 全部規則為 error；每個 IPC 頻道在所屬模組的 `contract/ipc.ts` 聲明一次（Main 以 `IpcRegistrar` 註冊，preload 由 `createDesktopApi` 組合），新增頻道不再改 preload；新功能等 milestone 完成後再開。
- 預設開發分支為 `master`，包含文庫 UI 代碼與文檔。1.2.0 已於 2026-10-19 發布；正式簽章與逐 tag 例外以 docs/CODE_SIGNING_POLICY.md 為準。
- 首頁背景使用 `homeCipher.ts`／`homeWave.ts`；已選定方案與文庫渲染契約見 [介面規範](docs/UI_PREFERENCES_ZH.md)。舊原型與候選方案由 Git 歷史保留。
- Zotero 橋接（只在本機）：首頁「从 Zotero 导入」先讀本機只讀 API，失敗則讀 `zotero.sqlite` 唯讀副本；renderer 只傳條目 key，PDF 走既有 importPaths 按雜湊去重；條目關聯存文獻目錄 `zotero/link.v1.json`（無 migration）。閱讀器「导出到 Zotero」經本機連接器：Zotero 來源的論文建帶 `zotero://select` 連結的獨立筆記（連接器不能寫既有條目），其他論文建條目＋PDF＋子筆記，記錄存 `zotero/export.v1.json`。契約與驗證見 [Zotero 橋接](docs/ZOTERO_BRIDGE_ZH.md)。
- README／Wiki 源在 `docs/wiki/`，不會隨目錄提交自動發布；遠端上傳須另獲授權。真人模型／視覺驗收不能以 mock 或歷史 CI 替代。

## 13. 文庫頁與 AI 解讀

文庫資訊、互動、動畫與渲染契約統一見 [介面規範](docs/UI_PREFERENCES_ZH.md#文庫頁與-ai-解讀)。生成、存儲、兼容與恢復仍以各專項文檔為準；修改時先讀相關契約，不在本入口重複參數與歷史驗收紀錄。
