# Windows 桌面发布

## 本地开发包

使用 [開發工具版本](DESKTOP_DEVELOPMENT_ZH.md)，僅使用者要求時打包：

```powershell
pnpm desktop:build:bundles
pnpm desktop:release:from-built
```

desktop:release 會先 build；不可並行打包，僅源碼與 out 均未改變才可重用 out。預設 COPILOTIX_RELEASE_MODE=development。Electron 下載失敗可暫設 COPILOTIX_USE_INSTALLED_ELECTRON=1，僅接受本工作區同版本 dist，用完清除變數，不改依賴來源或門禁。

- release/setup.exe 為安裝入口；uninstall.exe、安裝說明與 advanced 校驗資料為內部交付。
- release-artifacts/<build-id>/ 包含緊湊 ZIP 及 program/Copilotix.exe 開發副本；不可單獨搬 EXE。
- ZIP 只有一個版本根目錄，含 Setup、卸載入口、說明、內部校驗資料，runtime 已嵌入 Setup，不重複放 program。
- manifest schema 5：distribution=compact-setup、runtime.embeddedIn；外層 artifactDirectory 指 ZIP、runtimeArtifactDirectory 指開發副本。外層含 transport.sha256、不進 ZIP；內層 bundle-manifest 不含外部路徑或自引用 ZIP hash。

封裝只在精確 .release-next-<buildId> staging：驗四 bundle、獨立 uninstall-cleanup.js、ASAR entry、keyring unpack、locale、fuses、資源及體積；以同一 runtime 生成 Setup，前後 EXE／ASAR bytes 不變。fuses 在簽名前寫入讀回；簽後改資源須重簽並重算 hash。重新解壓驗入口、hash／簽章，packaged smoke 僅接受版本匹配 marker 與空 stderr。CLI smoke 不建 renderer 窗口。

runtime-file-times.mjs 只更新 staging runtime 時間戳，不改依賴、內容、簽章或文庫。全部成功才原子替換 release；失敗還原舊 release、保留 staging。成功只清上一成功構建中已驗證的受限產物路徑。硬限 ASAR 40MiB、Setup 180MiB、ZIP 155MiB；runtime 360MiB 目前列 ADVISORY_RELEASE_LIMITS，只警告，恢復硬限須從清單移除。Renderer-only 依賴放 devDependencies，Main 純 JS 優先 bundle，原生／刻意 externalize 才留 dependencies。

## GitHub 正式发布

### CI 调度与验收证据

常規路徑：**PR 驗證 → 合併 → desktop-v* tag 全量驗收並發布**。工作流只接受 PR、tag push、手動；master 合併不再重跑 push CI，直接寫 master 須手動驗證。full_validation 留給大型重構／診斷／明確預演，普通版本不額外跑一輪。

- PR／普通手動：checks 跑 lint、typecheck、deps、受影響單測＋必跑安全集；3 個 e2e runner 並行 build 並選受影響 spec，每個單 worker。全局改動仍全量。僅受影響模式容許空分片，tag 全量不容許。
- 必需檢查仍叫 build，以 always() 等待 checks 與全部 e2e；只有兩者 success 才通過，取消／跳過／失敗均拒絕。publish 依賴此門檻及 e2e。回復調度須同步工作流與選擇器，不可僅移除依賴。
- tag／full_validation：完整回歸與覆蓋率（第1片）、全部 E2E、checks 完整構建封裝、fuses／簽章／smoke、隔離安裝生命週期、下載解壓刪除、遠端資產數量與 hash。archive_diagnostic 僅專項診斷，不替代完整發布驗收。
- 報告留7天：Copilotix-Windows-verification-reports 為封裝／安裝證據；Copilotix-Windows-e2e-reports-<n> 為 trace／截圖／HTML，第1片另含全量 JUnit／coverage；單測結果在 desktop/unit-test-results。

**本地變更尚未遠端驗證**：actionlint 通過，實際 Playwright 收集 5+16+13=34、不重複遺漏；窄 smoke 0/2/0；bash 聚合16種組合只 success/success 成功。這不是新工作流的 Windows CI 通過證據。歷史基線：[1.3.0 PR](https://github.com/Kumiko-kmk/Copilotix/actions/runs/40508933803) 約15min、[tag](https://github.com/Kumiko-kmk/Copilotix/actions/runs/40513834352) 約8min18s，不承諾新調度固定耗時。

失敗先看斷言、trace 與階段，只復核失敗 job。既往分別有產品狀態快取回歸、舊批量接口夾具、動畫 aria-busy 等待問題；為通過夾具而放寬封面門檻屬產品錯改，[仍待修復](MILESTONE_1_3_ZH.md)。一次備份通知／退出超時根因未證實，不能定性 GitHub 故障或加全局重試。軟體 WebGL 不代表真 GPU 性能，真服務／原生 wizard 與 opt-in 用例亦不由 CI 取代。維護 Actions 版本需審閱兼容後固定 SHA；branch protection 完整設定曾受 integration 403 限制，不據摘要推斷管理員繞過／審閱設定。

### 版本、签章与公开发布

tag 嚴格為 desktop-v<desktop/package.json version>。docs/releases/<版本>.zh-CN.md 首行作 Release 標題，沿用首版簡體中文分節，充分說明變更、下載安裝、服務設定、升級資料保留及限制；缺檔／版本不符停止。PR 說明包含行為變化、風險、驗證範圍，不以綠燈代替產品契約。

簽章授權、精確 tag 例外唯一依據為 [CODE_SIGNING_POLICY](CODE_SIGNING_POLICY.md)；後續版本不繼承1.3.0未簽名授權。當前直接支持 PFX/P12：WIN_CSC_LINK、WIN_CSC_KEY_PASSWORD；Token／HSM／雲簽需改造，見 [配置](LICENSE_AND_SIGNING_ZH.md)。正常正式構建缺可信證書即失敗，forceCodeSigning；主程式、Setup、卸載器 Authenticode Valid 並記 manifest 主體。自簽不能代替。

build 僅 contents:read，publish 僅 contents:write。自1.2.0起草稿只上傳 **setup.exe**，源碼 ZIP／tar.gz 由 GitHub tag 自動提供；內部 ZIP、SHA、manifest 不公開。回讀草稿恰好一項上傳資產，下載比內部 SHA-256 並按政策驗簽才公開；任一門禁失敗保持未發布，不改寫綠狀態。

## 安装生命周期验收

- desktop:test:installer：隔離位置測首次安裝／覆蓋升級／卸載保留資料／重裝；唯一標記與測試憑據、原庫只讀 hash。預檢已有安裝／快捷方式／實例即拒絕，不繞過保護。
- desktop:test:release-download：本地 HTTP 下載、整包與入口 hash、解壓及實際刪除；不等於 GitHub 下載驗收。
- desktop:test:release-download:install：獨立 GUID、Unicode／空格 Temp 路徑、同一 installer.nsh 和最終 EXE／ASAR、實際卸載器，驗既有安裝／庫／登記不變；不冒充互動清資料 UI。
- desktop:test:installer:wizard：原生向導在隔離位置檢查中文／空格路徑、桌面圖示選項、快捷方式、運行中保護與取消。安裝器字陣 sidebar164×314、header150×57，由 scripts/generate-installer-assets.ps1 生成；頁序／控件ID／文案為測試契約。

下載驗收證據：desktop/test-artifacts/release-download-acceptance.json、isolated-launcher-acceptance.json。packaged smoke 前須有 Setup、uninstaller、manifest、ZIP，其餘源碼 E2E 只需 bundle。真實付費服務與個人安裝不在這些驗收範圍。

## Lite 版獨立安裝

Lite 與完整版是兩個互不相干的安裝。差異集中在 `src/app/contract/appIdentity.mjs`（Main、卸載 Utility、打包腳本共用）；完整版的值已在使用者機器上生效，不得改動。

| | 完整版 | Lite |
|---|---|---|
| appId／產品名／執行檔 | `com.kumiko.copilotix.translation`／Copilotix／Copilotix.exe | `com.kumiko.copilotix.lite`／Copilotix Lite／CopilotixLite.exe |
| userData（%APPDATA%） | Copilotix-Translation-v2 | Copilotix-Lite |
| Windows 憑據服務 | Copilotix-Translation | Copilotix-Lite |
| 預設文檔目錄（文檔） | Copilotix | Copilotix Lite |
| 安裝 GUID | 14328922-… | 0bd267d6-… |
| 發布目錄 | release/ | release-lite/ |

- 資料與密鑰不共用；使用者可用「導出／導入論文數據」帶走資料，API 密鑰仍須重新填寫。單實例鎖跟隨 userData，兩版可同時運行。
- 卸載清理的 userData 資料夾在 Utility 建構時固定（`--mode lite`），不取自請求，因此 Lite 卸載不會碰到完整版的資料或憑據，反之亦然；憑據服務由 Main 依同一身份傳入。
- `pnpm desktop:release:lite` 先建構 out-lite，打包期間暫時把它放到 desktop/out（asar 內路徑各版相同），結束後刪除 out；重跑完整版 E2E 或打包前須重建。中斷時殘留的標記會讓 `from-built` 拒絕打包。其他門禁（fuses、簽章、packaged smoke、ZIP 校驗、體積上限）與完整版相同。
- electron-builder 合併陣列，覆寫只用純量；教程 PDF（約 2 MB）因此仍隨 Lite 打包而不使用。

`pnpm desktop:test:installer:lite` 用真實 Setup 在 Temp 內的中文／空格路徑驗收：向導文案、拒絕全機安裝、安裝與啟動、單實例、運行中拒絕安裝／卸載且不強殺、覆蓋安裝保留資料、卸載保留資料、下載版 uninstall.exe 只跟隨 Lite 的登記、清資料（確認框須只列 Lite 路徑才點確認，否則取消）。開始前記錄完整版的登記值、程式雜湊、快捷方式、資料、文庫清單與憑據名稱，每階段比對，只讀不啟動；若 Lite 資料或憑據已存在則拒絕執行，證據在 desktop/test-artifacts/lite-installer。向導與對話框窗口會短暫出現，可真正點擊的只有測試自己建立的資料。

Lite 的版本由 `LITE_IDENTITY.version` 獨立管理（首版 1.0.0），electron-builder 的 extraMetadata 同步寫入安裝包與 app.asar；不改完整版 package.json 版本。標籤為 `desktop-lite-v<version>`，說明在 `docs/releases/lite/<version>.zh-CN.md`。

`desktop-lite-windows.yml` 對發布腳本／身份／Lite 發布說明的 PR 及手動調度產生驗收產物，完整單測覆蓋率、Lite Electron 流程、封裝與隔離安裝／升級／卸載全過後才上傳安裝包。Lite tag 在同樣門禁後發布；可信簽章仍依 CODE_SIGNING_POLICY，無本版本授權時不公開未簽章產物。發布只上傳 setup.exe，草稿回下載驗 hash／簽章後公開，保留完整版為 latest。完整工作流第 3 片也建構 Lite，避免其 E2E 因缺 bundle 被跳過。`test-installer-*` 其餘腳本只驗完整版的 GUID 與路徑。

## 安裝、資料與許可邊界

appId、四 bundle、單實例與 userData 保持兼容。只裝當前使用者，運行中提示正常退出不強殺；更改安裝位置不等於文庫遷移。下載 uninstall.exe 只轉交已登記安裝的真實卸載器，不清下載目錄。

升級／靜默卸載預設保留資料與憑據；清資料須向導明確選擇＋Main 第二次原生確認，獨立 Utility 驗 token／唯讀清單／固定 userData 邊界。清理程序只用單實例鎖確認沒有實例運行，隨後釋放並改以臨時 userData 運行，不得持有或改寫待刪目錄；token 比對資料庫與 -wal 內容，-shm 不含資料故不比（只讀打開 WAL 資料庫也會動到 -shm／-wal 日期）。junction／漂移拒絕，保護來源 PDF、共享檔、外部備份。新儲存／憑據／原生資源同步打包與卸載清單；退出／備份／維護先等聊天取消落盤，文庫遷移包含 chat。自動更新、MSIX／Store、其他平台尚未接入。

自有代碼 MIT，不覆蓋第三方及歷史許可。打包匯總第三方（含開發依賴）並保留 Electron 聲明，放 resources/licenses；缺文本如實列出。使用者操作見 [安裝指南](WINDOWS_INSTALLATION_ZH.md)、[文庫恢復](LIBRARY_MANAGEMENT_ZH.md)。
