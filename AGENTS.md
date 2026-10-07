# 跨 Worktree Agent 協作文檔（不得刪除）

> **永久保留：任何 Agent 都不得刪除、改名或以其他文件取代本文件。**
>
> 本文件是不同分支、worktree 與 Agent 之間的共同協作入口。開始工作前必須先閱讀；新增經驗時應保留既有內容，按編號追加或就地修正已失效的命令。

## 協作規則

- Git worktree 不共享未提交文件；需要跨 worktree 傳遞的規則或結論必須提交到 Git，再由其他分支 merge、rebase 或 cherry-pick。
- 不得修改、清理、stash 或重置其他 Agent 的 worktree。
- 動手前和交付前均執行 `git status --short --branch`，避免覆蓋他人尚未提交的工作。
- 涉及共享契約、資料庫 migration、IPC、Core RPC、JobRepository、Artifact/PathPolicy 或發布腳本時，記錄兼容策略、測試證據和恢復語義。
- Setup 交付目錄可獨立安裝；便攜版必須完整交付運行目錄或 ZIP，不得單獨複製 `Copilotix.exe`。

## 1. 最快捷生成供人工測試的 Windows EXE

以下命令均在倉庫根目錄使用 PowerShell 執行。首次使用某個 worktree，或 `package.json` / `pnpm-lock.yaml` 有變更時，先安裝依賴：

```powershell
pnpm install
```

### 修改源碼後的最快可靠路徑

```powershell
pnpm desktop:build:bundles
pnpm desktop:release:from-built
```

第一條命令重建 Main、Preload、Renderer 和 Utility 四個 bundle；第二條直接使用剛生成的 `desktop/out/` 打包，省略重複 build，但仍會完成 ASAR、資源、fuses、體積、ZIP、雜湊和 packaged smoke 驗證，並原子更新發布目錄。

工具版本：Node 24.19.0；打包必須實際使用根 `packageManager` 指定的 pnpm 11.19.0。Codex 的 fallback pnpm 可能是其他版本，此時可用 Node 執行本機 Corepack 快取中 11.19.0 的 `bin/pnpm.mjs --dir desktop package:directory:from-built`；不得偽造 user-agent 繞過版本檢查。

可供測試的入口為：

```text
release-artifacts/<build-id>/program/Copilotix.exe
```

同目錄的 DLL、PAK、`resources/` 等文件是運行所必需的，不要把 EXE 單獨移出。完整 ZIP 位於：

```text
release-artifacts/<build-id>/Copilotix-1.0.0-win-x64.zip
```

### 僅重新打包

如果源碼和 `desktop/out/` 自上次成功 build 後均未改變，只需：

```powershell
pnpm desktop:release:from-built
```

若修改過任何會進入 bundle 的源碼，不得跳過 `desktop:build:bundles`，否則會打包舊代碼。

體積預算（2026-10-07）：runtime 上限 360 MiB 中 Electron 本體約占 330 MiB，餘量很小。`dependencies` 會原樣打進 app.asar，只供 Renderer 使用（已由 Vite 打包）的套件必須放 `devDependencies`；Main 需要的純 JS 套件優先用 electron-vite 的 externalize `exclude` 打包進 bundle（如 zod），只有原生模組或刻意外部化的套件（keyring、katex 等）才留在 `dependencies`。調整後 app.asar 由 29.9 降至 22.0 MiB、runtime 由 359.5 降至 351.6 MiB。

### 正式交付前的驗證路徑

依使用者要求，日常開發預設不執行本地 lint、typecheck、單元／覆蓋率或 E2E 測試。2026-10-07 補充：未經使用者明確允許，不得 push、上傳產物或觸發遠端發布。允許本地 commit；只有授權上傳後，才可用 GitHub Actions 驗證最新提交（詳見第 8 節）。

需要供真人驗收的本地 EXE 時，可按上面的快速路徑 build／打包並本地交付，不以 push 為前提；打包內建的產物校驗不能移除，亦不能聲稱已通過完整 CI。`pnpm desktop:release` 會重新 build，不能與 `desktop:release:from-built` 同時並行執行。打包失敗時保留 `.release-next-*` 供排查；確認不再需要後才能清理。

## 2. 文檔格式接口（PDF / Markdown）

- 任務列表目前以 `DocumentSummary.originalName` 的副檔名顯示格式標籤：`.md`、`.markdown` 顯示為 `Markdown`，其餘既有記錄按向後兼容規則顯示為 `PDF`。這只是顯示層兼容接口，目前導入、解析與閱讀流程仍只正式支持 PDF。
- 正式接入 Markdown 時，必須在共享 IPC schema、Core RPC、資料庫文檔記錄與 migration 中增加明確的 `sourceFormat: 'pdf' | 'markdown'`，完成舊資料回填後再讓顯示層優先使用該欄位；不得長期只靠檔名推斷格式。
- Markdown 導入接口預定接受 UTF-8 編碼的 `.md` / `.markdown` 文件（MIME `text/markdown`）。源文件須按既有 PathPolicy 原子落盤並保留校驗摘要；Markdown 不走 PDF 上傳/解析器，而是在標準化邊界產出可供翻譯、RAG 與閱讀器使用的 canonical Markdown artifact。
- 新增格式時必須保持現有 PDF 契約與舊資料可讀，並補齊重複文件判定、任務狀態投影、刪除/重試、artifact revision 及恢復語義測試。

## 3. 設定頁及後續 UI 新頁面的對齊標準

設定頁右側的「服務連結」內容區是新頁面的尺寸基準：

- 頁籤內容必須作為 `.settings-content-body` 的直接子元素，並使用 `.settings-section` 共用類別。
- 內容區從與「服務連結」卡片相同的頂部基線開始；不得在頁籤內重複顯示「模型設置」「文件存儲」等導覽標題，也不得用空白標題或額外上邊距佔位。
- `.settings-section` 必須填滿 `.settings-content-body` 的可用高度與寬度，沿用相同的頂部及左、右邊界；不得添加頁面專屬的外層 margin、padding 或 max-width。
- 頁面自己的卡片可使用內距，但第一張頂層卡片的外邊緣必須與「服務連結」第一張卡片對齊。
- 刪除可見標題後，仍須以 `section` 搭配 `aria-label` 保留可存取的區域名稱；名稱應與左側導覽文字一致。
- 新增或修改設定頁籤時，測試至少要驗證：區域可由名稱查找、沒有重複頁面標題，以及內容根節點直接套用 `.settings-section`。

## 4. 文档库维护契约

- 文档库管理经 Main 原生目录选择与确认、IPC 维护锁、Utility 持久化队列执行。
- manifest v1 与 schema_migrations/SQLite 结构共同约束恢复兼容性。恢复必须校验文件并保留旧库；迁移复制完成后才事务切换路径。
- 不得把 API 密钥加入备份，不自动删除旧文档目录，不在活动任务期间切换库。
- 相关实现与恢复语义见 docs/LIBRARY_MANAGEMENT_ZH.md；数据/IPC/UI 修改需回归该文档列出的测试。

## 5. 许可与签名维护

- 当前 master 自有代码使用根 LICENSE.md 的 MIT 许可；不可用其覆盖第三方或历史上游代码。
- package-directory 在打包前生成第三方许可汇总，并把 MIT 与声明复制到 resources/licenses。清单包括开发依赖，缺少根许可文本的包须如实列出，不能宣称其覆盖完整。
- 本机自签证书仅用于测试；不得自动加入系统信任或替代正式发布签名。SignPath 申请与代码签名政策见 docs/SIGNPATH_APPLICATION.md、docs/CODE_SIGNING_POLICY.md。

## 6. Setup 交付入口

- 同一發布命令產生精簡 ZIP，解壓後根目錄含 Setup、`uninstall.exe`、安裝說明及小型 advanced 校驗文件。完整 runtime 已嵌入 Setup，開發副本只存 `release-artifacts/<build-id>/program/`；ZIP 存同一產物目錄，不得再把 runtime 放入 ZIP 重複交付。schema 5 標記 distribution compact-setup、runtime.embeddedIn；外層 runtimeArtifactDirectory 指向開發副本，artifactDirectory 指向 ZIP 所在目錄。ZIP 內 bundle-manifest 不含外部產物路徑或 ZIP 自身哈希；外層 release-manifest 在 ZIP 完成後加入 transport.sha256，且不進 ZIP。發布成功只清理上一成功版本的已驗證 artifact 路徑，失敗暫存保留。
- Setup 強制目前使用者範圍，允許選擇安裝位置。安裝或卸載發現 Copilotix 仍在運行時須提示退出；不得強制結束背景佇列。預設卸載保留應用資料、系統憑證及獨立文檔庫；只有使用者明確勾選清除資料並經 Main 第二次原生確認，才由獨立 Utility 唯讀清單驗證並安全清理。覆蓋升級與靜默卸載不得觸發清理。程序目錄提供 uninstall.exe。新增憑證種類或文檔儲存結構時，須同步更新卸載清單與路徑驗證。
- 正式發布仍須受信任簽章；Setup、主程式和內嵌卸載器皆受簽章門禁約束。必要安裝驗收可執行 `pnpm desktop:test:installer:wizard` 和 `pnpm desktop:test:installer`，腳本會拒絕覆蓋既有安裝。

## 7. 閱讀器基座契約（大文庫、併發與長論文）

- Core RPC 只保留 Main 實際調用的 operation；舊的逐塊翻譯、翻譯快取、整表標註替換等已移除。新增 RAG/問答 operation 時沿用「Utility 生成 descriptor、Main 只傳 ID 與小結果」模式。
- `tasks:list`、`documents:list` 為 keyset 分頁（`{ after? }` → `{ items, next }`，每頁 ≤200 行、≤512 KiB）。任何可能隨文庫增長的列表 RPC 都必須分頁，不得一次返回全量。
- Utility 觸及 SQLite 的 operation 分三條通道：data、compute（`compute:*`）與獨佔的生命週期（init/flush/close、library）。SQLite 事務必須保持同步（`transaction(() => …)` 內不得 await），否則通道交錯不再安全。Main 側 compute 請求用 `COMPUTE_RPC_TIMEOUT_MS`，並以作業 signal 取消。
- JobScheduler 事件為 `job-changed(job)`、`job-notification(job)`；通知與 UI 均以 `job.documentId` 定位文檔，job id 與 document id 不同。
- Main 對文檔變更用 `createCoalescedRefresh` 合併刷新；新的高頻事件源（例如 RAG 索引進度）應走同一路徑，不得每個事件都全量查詢。
- Reader 傳給 `MarkdownPane` 的 `blocks`、`annotations` 必須保持引用穩定（`useMemo`），否則滾動聯動會反覆重建長論文的高亮與小地圖。
- PDF 閱讀區無外圍 padding／邊框／陰影，100% 按完整 clientWidth 貼合。原生捲動條必須完全隱藏以免佔用右側／底部空間，使用不佔位且可拖曳／鍵盤操作的浮動捲動條；頁間及末頁底部無額外 gap，DOM 與虛擬頁高計算保持一致。欄寬分隔器透明並覆蓋右欄，不留固定寬度空白條。寬度、縮放及延遲頁面尺寸改變時，在 layout effect 中按 PDF 頁號與頁內比例立即恢復位置；禁用原生 overflow anchoring，並取消舊滾動 frame，避免用舊像素偏移重新判斷頁碼。真人滾動及明確翻頁／引用定位仍正常更新頁碼。
- 單篇論文 AI 問答的維護與交接見 `docs/READER_AI_CHAT_PLAN_ZH.md`（所有 Agent 的共享入口）。2026-10-07 已加入文獻目錄 `chat/` 下的原子持久化、歷史分頁、草稿／選區／模型恢復；不新增 migration，不合併 demo 分支的 schema 5–7。清空、文獻刪除、文庫維護及退出前必須等待對應問答取消並落盤，防止晚到寫入復活記錄或破壞快照。
- 問答共用「服務連接」的 API／憑據，默認沿用翻譯服務商，但面板可選已啟用的 Qwen／DeepSeek 及獨立問答模型；不修改翻譯模型。舊 request 省略 provider 保持兼容，舊 chatProvider 設定不參與路由。Key、valid 狀態及 consent 仍分別驗證；不得在聊天文件中保存 Key。
- 閱讀器只有 PDF、原文 Markdown、中文 Markdown、AI 問答四個視圖，移除 JSON 展示但保留底層 layout 產物與 ZIP。問答只支持共享預設模型清單，IPC／Main 按服務商校驗；舊 session／設定的自訂型號回退到預設值，不損壞历史 turn。首次進入才掛載及建索引；「添加到對話」只加入選區，不切換頁籤。已恢復引用必須再核對 revision。構建 bundle 使用 Node 24.19.0，系統 Node 24.11.1 會靜默崩潰並留下舊 out/。

- 閱讀器為編輯器式工作台（2026-10-07，分支 `ui/reader-workbench`）：四個視圖以分組頁籤呈現，可經頁籤右鍵、分組「⋯」選單左右／上下拆分、移動到其他分組、關閉後由「+」重開；每個視圖同時只出現一次（移動而非複製），最後一個可見視圖不可關閉。佈局是 `readerLayout.ts` 的純函式樹（split／group），全局保存於 localStorage `copilotix.reader.layout.v1`，讀取時校驗修復（未知或重複視圖、空分組、單子節點 split、尺寸）並回退預設；預設等同舊版「PDF｜原文·中文·問答」，首次載入沿用舊的 sessionStorage 欄寬。分隔器只受最小尺寸（寬 240px／高 140px）限制，拖曳期間僅本地狀態更新、放開才提交。
- 工作台掛載規則：Markdown 視圖只在成為分組選中頁籤時掛載並以 `initialScrollTop` 恢復；PDF 與問答首次顯示後保持掛載（問答仍首次進入才建索引）。視圖專屬控件（PDF 頁碼／縮放、翻譯狀態、問答工具列）經 portal 渲染到所在分組頁籤欄；`PdfPane` 新增可選 `toolbarHost`、`initialViewState`／`onViewStateChange`，移動或重開時按頁內錨點恢復位置。標頭複製／另存作用於「聚焦分組」的選中視圖。第二階段：頁籤可拖曳（5px 起拖，Esc 取消）到其他分組頁籤欄（移動／同組重排）或分組內容區（邊緣四分之一拆分、中間合併），預覽顯示目標區並在空間不足時禁止；拖曳狀態只經獨立 DragContext 更新幽靈、預覽與插入線，不觸發閱讀器重繪。雙擊頁籤或 Ctrl+Shift+M 最大化分組（純 CSS 覆蓋，其他分組保持掛載，Esc 還原，不持久化）；分組間分隔線畫在分隔器 ::after，split pane 不得設定 position，否則最大化會被困在 pane 內。快捷鍵：Ctrl+1–4 顯示 PDF／原文／中文／問答，Ctrl+（反斜線）向右拆分，Ctrl+Alt+←/→ 移到相鄰分組，Ctrl+W 關閉視圖，Ctrl+Shift+T 重開最近關閉。第三階段：捲動同步以「block mappingId + 塊內比例」對齊（`readerScrollSync.ts`），閱讀線為視口 35%；只有本視圖內滾輪／拖曳／鍵盤／觸控引起的捲動才領先，跟隨產生的程式捲動（120ms 內回聲）不回報，避免互相彈跳；每幀最多派發一次。參與者＝各分組選中頁籤且在 layout.synced（🔗 開關，預設原文＋中文、PDF 關閉、問答不參與；舊佈局缺欄位時套預設）。PdfPane 以 `pdfSyncPosition` 找閱讀線所在塊並以頁內錨點跟隨。窄窗口不另做摺疊：每個 split pane 依 `minNodeExtent` 設 min-width／min-height（分組 240×140），四個視圖在最小窗口內必然放得下。問答引用若無閱讀視圖在畫面上，`ensureReadingView` 會把原文（或中文／PDF）拆到問答左側或重開，而非取代問答；最大化的問答分組會先還原。注意：自動生成的 e2e 夾具（自訂 sourceMarkdown）多段共用少數 mappingId，MarkdownPane 會將其視為歧義而不建索引，捲動同步與選段聯動須用真實解析資料驗證。

## 8. 遠端 CI 驗證與預設不跑本地測試

- 日常開發不再預設跑本地自動化測試及 lint/typecheck；測試程式仍須隨行為修改一同維護，由遠端執行。只有使用者另行要求本地驗證時才執行。
- 未經使用者明確允許不得 push 或上傳遠端。預設流程為修改 → 本地 commit → 按要求本地 build／打包交付；完整 CI 未執行時如實說明。獲授權上傳後才 push 工作分支並查看該版本 Actions；合併前 `build` 必須成功，PR 還須通過最新合併結果的檢查。不得用舊版本成功、取消、跳過或未觸發代替成功，也不得為變綠刪掉斷言、降低覆蓋率門檻或關閉安全門禁。
- `.github/workflows/desktop-windows.yml` 對所有分支 push、PR 和 `desktop-v*` tag 執行，並提供手動觸發。新分支必須包含這份工作流與 CI 設定；基於舊版本的分支要先同步修復。只 commit、不 push 不會執行 GitHub Actions。
- 保持主分支必需檢查名稱 `build`。CI 包含 frozen-lockfile 安裝、lint、typecheck、覆蓋率、四個 bundle、真實打包 smoke、Electron E2E、安装／升级／卸载／重装及下载解压验收；tag 發布另受版本、許可與簽章門禁約束。
- 在 Actions 下載 `Copilotix-Windows-x64-Bundle` 供真人安裝驗收；`Copilotix-Windows-verification-reports` 保存單元 JUnit、覆蓋率摘要及 E2E 失敗證據。不要將 CI 未通過的包稱為已驗證版本。
- 此規則只改變自動化驗證的執行位置；真實 API、視覺效果、硬體／系統差異仍按需求由使用者驗收。CI 不持有個人 API 憑據，不能聲稱付費模型或每台機器都已驗證。

## 9. CI 與夾具維護要點

- Vitest CI 最多 2 workers，Windows Playwright 單 worker；JUnit 放 desktop/unit-test-results，避免被 Playwright 清除。
- Windows 原子 rename 遇 EPERM／EACCES／EBUSY 最多約 6.3 秒有界重試；永久錯誤失敗，CLI exit 1，不用 copy／delete 替代。E2E 前要求 Setup、uninstaller、release-manifest 和 ZIP 均存在。
- 僅「未打包 + NODE_ENV=test + COPILOTIX_E2E_USER_DATA」使用夾具獨立 native vault service；打包版一律用正式 service。夾具只清理自己的六種 account，不讀寫真人或其他夾具憑據。問答 E2E 經真實設定 IPC 保存假 Key，只模擬 provider HTTP。
- 閱讀器從任務列表進入，等 reader-header（最長 30 秒）與 Markdown ready 後再互動；error 不算 ready，不加全局 retry／timeout 或降低原斷言。
- 縮略圖截圖期間 app-shell 用直角及完整 CSS 像素裁切，保持 channel delta ≤1、changedRatio ≤0.001；失敗保留 expected／actual PNG。
- 最新 CI 證據必須對應最新提交；付費 API 回答、視覺效果及每台機器的實際驗收不能由假 HTTP 或其他分支綠燈替代。

## 10. Markdown 公共格式修复（2026-10-06）

- 格式、v4/v5 翻译计划兼容、旧文档映射、原子导出和真实论文验证边界见 `docs/MARKDOWN_FORMAT_ZH.md`。共享规范化入口为 `standardMarkdown.ts`，格式是 CommonMark + GFM + 明确数学扩展；不得把公式降级为代码来冒充修复。
- Markdown 导出须带相邻图片目录并使用相对链接；图片复制失败时不得覆盖已有导出。任务目录里的原始资料不可作为导出目标。结果 ZIP 也须规范化两份 Markdown。
- 对比交付只保留用户要求的两份 Markdown；Notion 桌面验收不能用浏览器或 CI 成功替代。

## 11. 丰富阅读与标准导出分离（2026-10-07）

- 使用者要求阅读器保留 HTML/LaTeX 丰富结构；解析、翻译发布与阅读器不得将合并表格展平。`prepareReaderMarkdown` 只做非结构性准备和可选图片路径修正；`normalizeMarkdown` 仅用于 Markdown/ZIP 导出投影，不回写源资料。
- 新翻译计划为 v6，读取合法的 v4/v5/v6 manifest；已有 v5 平面表格无法自动恢复合并结构，不应自动重解析或重翻译。映射、标注、资源与原子发布契约不变。详细契约和测试见 `docs/MARKDOWN_FORMAT_ZH.md`。

## 12. 共享開發進度（2026-10-07，可直接清理）

此節是所有 Agent 共享的目前進度，不是某位 Agent 的私人記錄。後續 Agent 可直接更新；若已過時，可整段刪除此節，無須保留舊進度或額外審批。只刪除這個進度區塊；`AGENTS.md` 文件及其他長期協作規則仍須保留。跨 worktree 查閱的本次實作位置為 `Copilotix-master-updated`／`codex/reader-ai-chat`，Git 傳遞仍依協作規則。

- 已完成：DeepSeek／Qwen 預設問答模型、按文獻保存並恢復聊天／草稿／選區；取消自訂模型支援，舊選擇回退預設而保留歷史對話。
- 閱讀器：正文段落上下間距 3px；PDF 無外圍留白、邊框與陰影；欄寬／縮放改變保留頁號及頁內位置；只保留原文 Markdown、中文 Markdown、AI 問答三個頁籤，移除 JSON 展示。最新修正清除了原生捲動條右側／底部佔位、24px 頁間及末頁留白、8px 分隔器佔位，保留浮動捲動條拖曳。
- 最新本地驗證（使用者明確要求測試）：typecheck、PDF／分隔器／聊天儲存 20 項單元測試、四個 bundle 和 Utility smoke 通過。兩項 Electron E2E 通過：反覆欄寬拖曳／鍵盤调整及縮放保持頁碼與頁內位置；真實 15 頁論文在 100%／120% 無右側／底部 gutter、無頁間 gap、兩軸浮動捲動條可拖曳、末頁底邊貼合。已人工檢查測試截圖。未執行完整 CI，付費 API 仍待真人驗收。
- 使用者此次明確要求不打包，現有 `release-artifacts/muxofbtq-39548-6096bb0c/program/Copilotix.exe` 及 `release/setup.exe` 保持原樣，**不含最新 PDF 邊緣修正**；不可把它們當成最新已測版本交付。此前打包 smoke 結果只對此前產物有效。
- 2026-10-07 另開 `ui/reader-workbench`（基於 `codex/reader-ai-chat` 1f6c18f）完成編輯器式閱讀工作台第一至三階段（分組／拆分／拖曳／最大化／快捷鍵／捲動同步／引用顯示），見第 7 節；僅本地 commit，未 push；依第 8 節未跑本地測試，只以 Node 24.19.0 build 四個 bundle 並人工檢查 Electron 截圖（預設佈局、右鍵拆分、向下拆分、關閉／重開、原文｜中文並排點選聯動）。
- 2026-10-07 閱讀器版面緊湊化：視窗標題列 32→28px、閱讀器資訊列 44→36px、工作台頁籤列 48→40px，閱讀區多出 20px；e2e 高度斷言同步更新。最新本地包 `release-artifacts/muxvhkb6-3084-bb0c9178/`（含工作台三階段與緊湊版面），舊產物目錄已按使用者要求清理；僅通過打包內建校驗，未跑 CI。
- 遠端唯讀核對後只有 `master`、`codex/reader-ai-chat`、`codex/rag-review-20260923`；兩個開發分支均未合併，使用者明確選擇保留三個分支，因此未刪遠端分支。本次程式及產物沒有 push／上傳；後續遠端修改仍需符合當時的使用者授權。
