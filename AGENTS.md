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

### 正式交付前的驗證路徑

依使用者 2026-10-06 的要求，日常開發預設不再執行本地 lint、typecheck、單元／覆蓋率或 E2E 測試；改由 GitHub Actions 驗證（詳見第 8 節）。完成修改後 commit 並 push 工作分支，等待最新版本的 `Desktop Windows / build` 成功，再合併或交付。只在本地 commit 不會觸發遠端測試。

需要供真人驗收的本地 EXE 時，仍可按上面的快速路徑 build／打包；打包內建的產物校驗不能移除。`pnpm desktop:release` 會重新 build，不能與 `desktop:release:from-built` 同時並行執行。打包失敗時保留 `.release-next-*` 供排查；確認不再需要後才能清理。

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
- 單篇論文 AI 問答的維護與交接見 `docs/READER_AI_CHAT_PLAN_ZH.md`（負責人 astra）。2026-10-07 已加入文獻目錄 `chat/` 下的原子持久化、歷史分頁、草稿／選區／模型恢復；不新增 migration，不合併 demo 分支的 schema 5–7。清空、文獻刪除、文庫維護及退出前必須等待對應問答取消並落盤，防止晚到寫入復活記錄或破壞快照。
- 問答共用「服務連接」的 API／憑據，默認沿用翻譯服務商，但面板可選已啟用的 Qwen／DeepSeek 及獨立問答模型；不修改翻譯模型。舊 request 省略 provider 保持兼容，舊 chatProvider 設定不參與路由。Key、valid 狀態及 consent 仍分別驗證；不得在聊天文件中保存 Key。
- 問答是閱讀器右側第四個頁籤，首次進入才掛載及建索引；「添加到對話」只加入選區，不切換頁籤。已恢復引用必須再核對 revision。構建 bundle 使用 Node 24.19.0，系統 Node 24.11.1 會靜默崩潰並留下舊 out/。


## 8. 遠端 CI 驗證與預設不跑本地測試

- 日常開發不再預設跑本地自動化測試及 lint/typecheck；測試程式仍須隨行為修改一同維護，由遠端執行。只有使用者另行要求本地驗證時才執行。
- 正常流程為修改 → commit → push 工作分支 → 查看該版本 Actions → 修復失敗並再次 push → `build` 成功後才合併／交付。必須確認檢查對應最新 push；PR 還須通過最新合併結果的檢查。不得用舊版本成功、取消、跳過或未觸發代替成功，也不得為變綠刪掉斷言、降低覆蓋率門檻或關閉安全門禁。
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
