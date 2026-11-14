# 桌面開發與測試

Windows x64；Node **24.19.0**、pnpm **11.19.0**（系統 Node 24.11.1 曾靜默崩潰留下舊 out）。版本源為 package.json；程序與資料契約見 [架構](ARCHITECTURE_ZH.md)。

```powershell
pnpm install
pnpm desktop:dev
```

只在新環境或依賴／lockfile 改變時安裝，依賴構建指令碼先審閱。必要時用正確 Node 執行 Corepack 快取的 pnpm.mjs，不偽造版本或 user-agent。

## Lite 版

同一份程式碼按建構模式出兩個版本：`pnpm desktop:dev:lite` 開發（輸出仍在 out/，切回完整版請重建）；`pnpm desktop:build:lite` 輸出到 `desktop/out-lite/`，與完整版的 out/ 並存。版本由 Vite `define` 的 `__COPILOTIX_LITE__` 在建構時決定；只有組裝層（`app/renderer/main.tsx`、`app/main/bootstrap.ts`）讀它，模組不感知版本。

Lite 組裝器是 `LiteApp.tsx`；完整版是 `App.tsx`，共用邏輯在 `useAppData.ts`、`useGuardedViews.tsx`。Lite 無檔案卡生成：不掛解析完成的自動生成與啟動恢復，也不把來源傳給閱讀器。資料庫、IPC、RPC 與磁碟格式兩版相同，無 migration，但資料不共用。

Lite 是獨立安裝的產品，開發時同樣使用自己的資料目錄（%APPDATA%\Copilotix-Lite、憑據服務 Copilotix-Lite），見[發布](DESKTOP_RELEASE_ZH.md#lite-版獨立安裝)。

`e2e/lite.spec.ts` 跑 out-lite 產物，含打包內容檢查（無 three.js、文庫、主頁字陣、自動生成、完整版資料目錄）；沒有 out-lite 時跳過，須先建構。

## 測試與實際門禁

程式碼修改依序跑 `desktop:typecheck`、`desktop:lint`、`desktop:deps`、受影響測試、`desktop:build:bundles`。檔案改動查連結與 diff，不為此打包。

| pnpm 命令 | 範圍 |
|---|---|
| desktop:test（同 desktop:test:changed） | import 圖＋改動模組全目錄＋必跑安全集 |
| desktop:test --module <name> | features 模組或 platform／app |
| desktop:test:e2e:affected | smoke＋路徑對映 E2E |
| desktop:test:ui | DOM／React 回歸 |
| desktop:test:full | 全部單元／整合 |
| desktop:test:e2e | 原始碼視窗 smoke |
| desktop:test:e2e:full | 全部 Electron，含需產物用例 |
| desktop:test:coverage | 全量與覆蓋率，完整驗收才跑 |

`scripts/affected-tests.mjs` 基準依序為 --base、COPILOTIX_TEST_BASE、merge-base(HEAD, master)，納入 committed／staged／unstaged／untracked；--list 只列選擇。必跑集：ipcContracts、v2Database、sqliteJobRepository、jobScheduler、pathPolicy、libraryMaintenance、uninstallCleanup，新增資料安全測試需同步加入。

package／lockfile、測試或構建配置、tsconfig、工作流、指令碼變動或基準不可解析時全量。單測涵蓋 .test.ts／.test.tsx／.test.mjs；E2E 依路徑對映，入口／preload／共用 helpers 改動全量，未對映原始碼至少 smoke。配置與實際路徑以選擇器為準。

Vitest ≤2 workers、Windows Playwright 每 runner 單 worker；三片由 playwright.config.ts E2E_SHARDS 分配，最後一片收剩餘 spec，總片數與 matrix／COPILOTIX_E2E_SHARD 必須一致。調整時檢查合集無重複遺漏。覆蓋率 lines／statements／functions ≥80%、branches ≥75%，僅計 vitest.config.ts 指定範圍，不能當全倉庫覆蓋率。CI 排程、報告與本地未遠端驗證狀態統一見 [發布契約](DESKTOP_RELEASE_ZH.md#ci-排程與驗收證據)。

## 夾具與介面驗證

- 只在未打包＋NODE_ENV=test＋COPILOTIX_E2E_USER_DATA 時使用獨立 native vault service；只清自己的六種 account。問答經真實設定 IPC 存假 Key，只 mock provider HTTP。
- 閱讀器通常經 openPaperFromLibrary（搜尋 → data-document-id →「開啟閱讀」，無 WebGL 時結果直接進 Reader）；等 reader-header ≤30s、Markdown ready，error 不是 ready。aria-busy 可涵蓋動畫，先等正確展開狀態。從文庫開啟後返回文庫。
- 不以全域性 retry／擴大 timeout／降低斷言掩蓋競態。Windows atomic rename 對 EPERM／EACCES／EBUSY 有界重試約6.3s，永久錯誤 exit 1，不以 copy/delete 替代。
- 截圖採直角 app-shell、完整 CSS 畫素裁切；channel delta ≤1、changedRatio ≤0.001，失敗留 expected／actual。
- 硬體文庫仍需 ≥30fps；軟體渲染改驗持續出幀、三角形與幀率上限，以減少動態效果跑導覽。這不代表真實 GPU 或完整動畫透過。多數 UI E2E 的測試 no-sandbox 亦不代表生產沙箱驗收；packaged smoke 與問答另有硬化檢查。
- 真實模型、付費 API、個人 GUI 配置須另行授權與實測；mock／歷史 CI／瀏覽器不能替代真人、原生安裝或 Notion Desktop 驗收。同類行為併入既有套件，不為簡單 getter、CSS 字串或動畫常數另建套件。

## 構建與文件

`pnpm desktop:build:bundles` 生成四個 bundle；僅明確要求才 `pnpm desktop:release:from-built`，詳見 [發布](DESKTOP_RELEASE_ZH.md)。Wiki 源在 docs/wiki，提交原始檔不等於已發布 Wiki。安全、持久化、來源校驗、取消恢復回歸必須保留。
