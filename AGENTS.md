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

### 正式交付前的完整路徑

快速路徑刻意跳過 typecheck、lint 和單元測試，只適合生成供人工驗證的包。正式交付前至少執行：

```powershell
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:release
```

`pnpm desktop:release` 會重新 build，不能與 `desktop:release:from-built` 同時並行執行。打包失敗時保留 `.release-next-*` 供排查；確認不再需要後才能清理。

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
