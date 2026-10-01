# Copilotix Windows Setup 安裝器開發管理報告

日期：2026-10-01  
規劃分支：`setup`  
狀態：設計與排期；尚未實作安裝器

## 目標與結論

將 Windows x64 的主要交付物改為 `Copilotix-Setup-<version>-x64.exe`。使用者可在安裝精靈中選擇安裝位置，完成後從桌面圖標或開始菜單啟動，也能透過 Windows 的應用程式管理入口卸載。保留現有 ZIP 作為進階用戶的免安裝備選，至少在新安裝器驗證穩定前不移除。

此方案可行。專案已使用 electron-builder 26 建置 Windows 目錄包；同一工具支援 NSIS 引導式安裝器。核心設定是 `win.target: nsis`、`nsis.oneClick: false`、`nsis.allowToChangeInstallationDirectory: true`，並明確配置桌面與開始菜單捷徑。現有 `appId` 應保持不變，避免後續升級與卸載辨識發生變化。[electron-builder v26 NSIS 文件](https://www.electron.build/v26/docs/nsis/)

難點不在安裝器介面本身，而在現有發布管線只接受「完整運行目錄、ZIP、manifest、SHA256SUMS」：它會對特定產物名稱、內容、體積、簽名和 GitHub 資產數量做嚴格檢查。因此應新增 Setup 產物的完整驗證，而非僅把 `win.target` 改成 `nsis`。

## 建議的交付與安裝目錄

```text
release/
├─ Copilotix-Setup-<version>-x64.exe       # 新手主要下載入口
├─ Copilotix-<version>-win-x64.zip         # 免安裝備選
├─ release-manifest.json
└─ SHA256SUMS.txt
```

安裝位置預設使用目前用戶可寫的程式目錄，安裝精靈允許改到其他位置；安裝後的 `Copilotix.exe`、DLL、PAK 與 `resources/` 仍需維持 Electron 的完整運行結構。桌面和開始菜單只放指向該 EXE 的捷徑，不複製單獨 EXE。

應用資料目前固定在 `%APPDATA%\Copilotix-Translation-v2`，文檔庫另有可配置位置。安裝位置的變化不應遷移或刪除這些資料。卸載預設只移除程式及捷徑，保留設定、憑證與文檔庫；若將來提供「刪除個人資料」，必須另行設計明確確認與備份流程。

## 里程碑與驗收

| 階段 | 主要工作 | 完成標準 | 粗估 |
| --- | --- | --- | --- |
| M0：基線與決策 | 在獨立 `setup` 工作樹保存目前代碼；確定安裝範圍為目前用戶、預設路徑、捷徑與保留資料策略；盤點舊 ZIP 用戶的升級路徑 | `master` 工作樹未被切換或清理；需求和安裝／卸載語義寫入本報告 | 0.5 天；工作樹與代碼基線已完成 |
| M1：本地 Setup 原型 | 新增 NSIS 引導式配置及獨立打包命令；補齊安裝器 `.ico`、產品名稱、安裝語言與路徑選擇；保留現有目錄／ZIP 構建能力 | 本地產生 Setup.exe；可選自定義目錄；桌面與開始菜單捷徑指向已安裝程式；正常卸載 | 1–2 天 |
| M2：發布鏈整合 | 擴充原子發布暫存區、manifest、SHA256SUMS、產物清單與體積門檻；對 Setup.exe 驗證檔案與簽名；更新 CI 上傳／回讀／比對及發佈說明 | 新、舊產物同時經校驗後才發佈；任何缺檔、雜湊或簽名失敗都阻止正式發布 | 1–2 天 |
| M3：安裝生命週期 | 覆蓋首次安裝、自定義路徑、覆蓋升級、已運行背景佇列時更新、卸載及重裝；確認資料庫、憑證、文檔庫與內置教程檔案可用 | 升級沿用原安裝位置及資料；卸載不刪用戶資料；ZIP 與安裝版不會因同時運行破壞任務 | 1–2 天 |
| M4：發佈準備 | 更新用戶下載指引、版本號及正式簽名流程；人工檢查安裝精靈和捷徑圖標 | 新手只需下載 Setup.exe 即能完成安裝並找到啟動入口；發佈文件與產物一致 | 0.5–1 天 |

粗估總量為 **4–7 個開發工作日**，不含外部受信任簽名證書的申請與審核時間。M1 可以先產出本地未簽名測試安裝器；正式公開發布仍受現有簽名門禁約束。

## 影響範圍

- `desktop/package.json`：Windows target、NSIS 選項、圖標與安裝器名稱；應保留目錄包路徑供內部 smoke 與 ZIP 驗證。
- `desktop/scripts/package-directory.mjs`、`release-policy.mjs`、`release-transaction.mjs` 及相關驗證腳本：加入 Setup 產物、獨立體積上限、雜湊、簽名和原子發布；不能讓安裝器取代對 `app.asar` 與原生依賴的檢查。
- `.github/workflows/desktop-windows.yml`：構建、上傳、下載回讀與 GitHub draft 資產數量目前固定為三項，需同步擴充。
- `docs/DESKTOP_RELEASE_ZH.md`、安裝／卸載指引及簽名說明：把 Setup 標記為主要下載入口，ZIP 標記為免安裝方式。
- 程式主流程原則上不需改動；`userData` 固定路徑、單實例與托盤中的背景佇列需要在安裝／更新場景下確認。

## 風險與控制

1. **簽名尚未就緒。** 現有正式發佈要求有效受信任證書；`CODE_SIGNING_POLICY.md` 記錄的 SignPath 申請尚無批准確認。Setup.exe 本身也必須納入簽名與 Authenticode 驗證，不能以本地未簽名包冒充正式版本。
2. **升級時程式可能仍在托盤運行。** 安裝器需要處理佔用檔案，明確提示退出並驗證任務安全停機；不可直接殺掉仍有任務的進程。
3. **自定義安裝位置與資料庫位置是兩回事。** 改安裝路徑不等於遷移文檔庫；介面文案應明確，卸載不得默認清空文庫或憑證。
4. **雙發佈產物會增加磁碟與 CI 成本。** 當前運行目錄約 354.56 MiB，ZIP 約 150.77 MiB；Setup 應有自己的大小限制，避免套用接近上限的 ZIP 門檻。
5. **安裝版與免安裝版共用資料位置。** 應明確測試從舊 ZIP 改用 Setup 的首次啟動，以及兩個版本被誤開時的單實例行為。

## 暫不納入本輪

自動更新、MSIX／Microsoft Store、跨平台安裝器、靜默企業部署，以及卸載時刪除用戶資料。這些功能會引入額外的服務、憑證或資料安全決策，可在 Setup 主流程穩定後另立里程碑。
