# Copilotix Windows Setup 安裝器開發管理報告

日期：2026-10-01  
規劃分支：`setup`  
狀態：已實作並通過本地驗收；正式公開發布仍需受信任簽章。

## 目標與結論

將 Windows x64 的主要交付物改為 `Copilotix-Setup-<version>-x64.exe`。使用者可在安裝精靈中選擇安裝位置，完成後從桌面圖標或開始菜單啟動，也能透過 Windows 的應用程式管理入口卸載。保留現有 ZIP 作為進階用戶的免安裝備選，至少在新安裝器驗證穩定前不移除。

此方案可行。專案已使用 electron-builder 26 建置 Windows 目錄包；同一工具支援 NSIS 引導式安裝器。核心設定是 `win.target: nsis`、`nsis.oneClick: false`、`nsis.allowToChangeInstallationDirectory: true`，並明確配置桌面與開始菜單捷徑。現有 `appId` 應保持不變，避免後續升級與卸載辨識發生變化。[electron-builder v26 NSIS 文件](https://www.electron.build/v26/docs/nsis/)

難點不在安裝器介面本身，而在現有發布管線只接受「完整運行目錄、ZIP、manifest、SHA256SUMS」：它會對特定產物名稱、內容、體積、簽名和 GitHub 資產數量做嚴格檢查。因此應新增 Setup 產物的完整驗證，而非僅把 `win.target` 改成 `nsis`。

## 建議的交付與安裝目錄

```text
release/
├─ Copilotix-Setup-<version>-x64.exe       # 新手主要下載入口
├─ 安装说明.txt                           # 新手安裝步驟
└─ advanced/                              # 進階及開發者檔案
   ├─ Copilotix-<version>-win-x64.zip      # 免安裝備選
   ├─ Copilotix-<version>-win-x64/         # 完整運行目錄
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

自動更新、MSIX／Microsoft Store、跨平台安裝器與靜默企業部署。卸載時選擇刪除用戶資料已按 2026-10-02 後續需求納入，詳見下方結果。

## 本輪完成結果

- Setup 實測 **93.98 MiB**，相較初版 104.22 MiB 減少 **9.82%**。採最大壓縮、取消增量更新資料，保留完整 Electron 執行期。
- `release/` 頂層只有 Setup、`安装说明.txt`、`advanced/`；新手直接雙擊 Setup。後續精簡後，`advanced/` 只含校驗資料，ZIP 與完整執行目錄存於 `release-artifacts/<build-id>/`，不需隨安裝包交付。
- 保持原有 appId、四個 bundle 與使用者資料路徑。使用現有圖標及奶油色背景；支援目前使用者安裝、自訂目錄、桌面與開始菜單捷徑。安裝與卸載不強制終止背景程式。
- 型別檢查、lint（無錯誤）、完整 build、發布驗證與 packaged smoke 通過；408 項單元／整合測試通過（3 項既有略過），相關發布及閱讀器回歸測試亦通過。
- 最終安裝包的原生精靈、自訂中文與空格路徑、覆蓋安裝、運行中保護、卸載保留資料／憑證及重裝驗收通過；測試安裝已清理。
- 本地包為未簽名測試包。正式主程式、Setup 與內嵌卸載器的簽章門禁保留；未執行公開發布。

驗收證據保存在本工作樹的 `desktop/test-artifacts/installer-wizard/` 及測試／打包日誌，發布與使用方式見 [Windows 安裝指南](WINDOWS_INSTALLATION_ZH.md) 與 [桌面發布文檔](DESKTOP_RELEASE_ZH.md)。

## 2026-10-02 後續需求結果

- 整個 `release/` 交付目錄由約 599.33 MiB 精簡為 **93.99 MiB**，減少 **84.32%**。Setup 是完整離線安裝包，不依賴外部 `release-artifacts/`；開發產物與可選便攜 ZIP 分開保留，成功構建後清理前次成功產物。
- 安裝目錄提供 `uninstall.exe`。預設保留資料，可勾選同步移除文庫、設定與 API 憑證；Main 顯示實際位置與文檔數量二次確認，Utility 唯讀列出已登記目錄。只刪除受限 `documents-v2/<id>` 與固定應用資料目錄，保護外部來源、其他共用檔案與外部備份。取消／錯誤停止卸載；自動升級及靜默卸載不執行此清理。
- 本次針對變更執行 **38 項測試**，全部通過；型別、針對性 lint、完整 build、NSIS 編譯、發布大小／雜湊與 packaged smoke 通過。SQLite 清理使用臨時文庫實際驗證，不刪除本機日常資料。
- 確認最終 Setup 內嵌 `uninstall.exe`。本機已有日常安裝，未覆蓋或卸載；新選項的實際原生 UI 驗收未完成（安全取消測試在啟動安裝／卸載程序前停滯，已停止自有測試程序）。先前初版 Setup 的安裝驗收不能替代本次新卸載 UI 驗收；本輪證據限於上述測試、編譯與包內容檢查。
- Setup 是現有 Electron runtime 的封裝與部署層，功能開發仍沿用 Main／Preload／Renderer／Utility 架構。新增 native 依賴、資源、憑證種類或資料儲存結構時，同步維護打包與卸載清單；資料庫 migration 保持舊資料兼容。

## 統一 Release 推送范本

後續依使用者要求，把 Setup、獨立卸載入口與完整 `program/` 放進同一個版本 ZIP，作為 Release 主下載；不再內嵌另一份便攜 ZIP。ZIP **244.86 MiB**；Setup 仍為 **93.99 MiB**，新增卸載入口約 **103 KiB**。CI 的資產上傳、下載回驗、路徑與校驗清單同步更新。清單 schema 4 區分 ZIP 內 payload 資料與外層 ZIP 哈希，避免自引用。

本次 **50 項相關測試**與型別／打包驗證通過；最終 ZIP 本機 HTTP 下載、SHA 校驗、完整解壓及刪除均通過。使用與最終包相同 EXE／ASAR 的獨立 GUID 安裝，實際透過卸載入口移除測試程式及登記，且原有使用者安裝與 SQLite 未改動，測試安裝已清理。測試不公開推送，正式發布仍需受信任簽章。

## 最终精简范本（schema 5）

原统一 ZIP 的 244.86 MiB 来自两份相同程序：Setup 内的压缩程序与额外 `program/`。现改为只交付 Setup、独立 `uninstall.exe`、安装说明和小型校验资料；完整程序仍在 Setup 内，开发运行副本保留于 `release-artifacts/<build-id>/program`，不随主 ZIP 下载。

最终 ZIP **94.08 MiB**（约 **98.65 MB**），Setup **93.99 MiB**；相较 244.86 MiB 减少约 **61.6%**。用户提到的旧包约 200 MB 未取得同版本原件，按十进制 200 MB 比较约减半；不是完全同源基准。进一步优化应集中于 Electron 版本升级的实际大小、依赖和资源审计；不宜直接裁剪必需 DLL、PAK、凭据 native binding 或教程。改为在线安装器虽可减小下载入口，但需另行联网下载 runtime，并不降低完整安装内容。

50 项针对性测试、类型检查、lint（0 错误／49 项既有警告）、精简打包发布门禁及 packaged core E2E 均通过。本地包仍为开发测试包，正式发布的许可证与受信任签名门禁保持启用。

最终 schema 5 包的 HTTP 下载、SHA256、四个交付入口、下载及解压目录删除、独立 GUID 实际安装／Core 启动／卸载均通过（6 项验收，exit 0）。现有用户程序、安装登记及 SQLite 哈希前后相同。测试安装与临时文件已清理，证据 `desktop/test-artifacts/release-download-acceptance.json` 的 `completed: true`。
