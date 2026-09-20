# 跨 Worktree Agent 協作文檔（不得刪除）

> **永久保留：任何 Agent 都不得刪除、改名或以其他文件取代本文件。**
>
> 本文件是不同分支、worktree 與 Agent 之間的共同協作入口。開始工作前必須先閱讀；新增經驗時應保留既有內容，按編號追加或就地修正已失效的命令。

## 協作規則

- Git worktree 不共享未提交文件；需要跨 worktree 傳遞的規則或結論必須提交到 Git，再由其他分支 merge、rebase 或 cherry-pick。
- 不得修改、清理、stash 或重置其他 Agent 的 worktree。
- 動手前和交付前均執行 `git status --short --branch`，避免覆蓋他人尚未提交的工作。
- 涉及共享契約、資料庫 migration、IPC、Core RPC、JobRepository、Artifact/PathPolicy 或發布腳本時，記錄兼容策略、測試證據和恢復語義。
- 發布目錄是完整運行包；不得只交付或單獨複製 `Copilotix.exe`。

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
release/Copilotix-0.1.0-win-x64/Copilotix.exe
```

同目錄的 DLL、PAK、`resources/` 等文件是運行所必需的，不要把 EXE 單獨移出。完整 ZIP 位於：

```text
release/Copilotix-0.1.0-win-x64.zip
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

## 2. 設定頁及後續 UI 新頁面的對齊標準

設定頁右側的「服務連結」內容區是新頁面的尺寸基準：

- 頁籤內容必須作為 `.settings-content-body` 的直接子元素，並使用 `.settings-section` 共用類別。
- 內容區從與「服務連結」卡片相同的頂部基線開始；不得在頁籤內重複顯示「模型設置」「文件存儲」等導覽標題，也不得用空白標題或額外上邊距佔位。
- `.settings-section` 必須填滿 `.settings-content-body` 的可用高度與寬度，沿用相同的頂部及左、右邊界；不得添加頁面專屬的外層 margin、padding 或 max-width。
- 頁面自己的卡片可使用內距，但第一張頂層卡片的外邊緣必須與「服務連結」第一張卡片對齊。
- 刪除可見標題後，仍須以 `section` 搭配 `aria-label` 保留可存取的區域名稱；名稱應與左側導覽文字一致。
- 新增或修改設定頁籤時，測試至少要驗證：區域可由名稱查找、沒有重複頁面標題，以及內容根節點直接套用 `.settings-section`。
