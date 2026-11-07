# settings

設定頁（服務連接、模型、存儲、显示设置）及其 Main 服務：設定持久化、憑據校驗、存儲統計與 API 用量統計。介面規則見 [介面偏好](../../../../docs/UI_PREFERENCES_ZH.md)。

## 公開 API

- `contract/ipc.ts`：`settingsChannels`（`settings:get`／`save`／`validate-credential`、`dialog:output-directory`、`storage:info`、`storage:open-location`、`analytics:usage`）與 `createSettingsApi`；`settingsTypes.ts`、`settingsSchemas.ts`（設定、憑據、存儲與用量的型別與 schema）、`defaultSettings.ts`（`DEFAULT_SETTINGS`）。
- `main/index.ts`：`SettingsService`、`UsageAnalyticsService`（`UsageAnalyticsRecorder`、`ProviderTokenUsage` 供解析、翻譯、問答記錄用量）、`registerSettingsIpc`。
- `renderer/index.ts`：`loadSettingsPage`／`loadSettingsDialog` 按需載入頁面／Lite 視窗（直接開關，無縮放過渡），關閉經呼叫方的未保存確認；視窗版只有「服務／存儲／外觀」三個單層分類（服務頁在 `LiteServices.tsx`：每個服務商一把密鑰、翻譯開關、Codex 自動偵測），不顯示用量與存儲圖表，保存欄只在有改動時出現。另提供主題（`restoreTheme`、`currentTheme`、`onThemeChange`、`mixHex`、`rgbChannels`）、`refreshCodexStatus`／`useCodexStatus`、`loadStorageInfo`、`SettingsNavigationGuard`。

## 版面

左列分類、右列面板，只放標題、控件與狀態或錯誤，不加說明行；兩版共用，樣式在 `renderer/settings.css`（Lite 只在 `app/renderer/lite.css` 覆寫側欄寬與底色）。規則見 [介面偏好](../../../../docs/UI_PREFERENCES_ZH.md#设置页版式)。

## 資料

- 設定經 Core RPC `settings:*` 存入 SQLite；API Key 只在 Windows 憑據庫（`platform/credentials`），不進設定與備份。
- `userData/usage-analytics-v1.json`：每日頁數與各服務商 Token 用量。
- localStorage `copilotix.theme.v1`、`copilotix.reader.font-size.v1`、`copilotix.reader.line-height.v1`：顯示設定，經「保存全部更改」寫入。

存儲統計僅在進入「文件存儲」時讀取，按文庫根目錄快取60秒並合併並發掃描；手動刷新強制更新。啟動與背景不輪詢。

Codex 卡片只讀取保存的連接狀態，不自動啟動 CLI。單一「验证连接」入口依次發現程序、檢查登入與可用模型、驗證選定模型（翻譯／問答相同模型只測一次）；失敗即停止，使用者可重試。程序路徑與推理強度收於「高级设置」。模型選擇仍經設定保存，CLI 傳輸、登入方式及憑據存儲不變。

## 測試

`tests/features/settings/`（`pnpm desktop:test --module settings`）；設定頁 E2E 在 `e2e/ui-chrome.spec.ts`、`qa-fixes.spec.ts`。

## 例外

無超過 600 行的檔案（`SettingsPage.tsx` 的用量與存儲面板拆在 `SettingsDashboards.tsx`，存儲區在 `StorageSettings.tsx`，MinerU 憑據編輯在 `CredentialEditor.tsx`）。

## 多 API 密鍵

- 「API 密钥」視圖（`renderer/ApiKeysSection.tsx`）按服務商管理 Qwen／DeepSeek，各最多 5 個（`MAX_KEYS_PER_PROVIDER`）：名稱、啟用、拖曳／方向鍵排序、測試、更換、刪除；新增與更換只在記憶體，保存時逐個驗證。服務連接頁只留一行摘要與「管理密钥」。
- 每個密鍵是 `modelConnections` 的一項；Vault 帳號由 connectionId 推導（`credentialRefFor`），`:default` 沿用 1.3.0 的 `qwen-api-key`／`deepseek-api-key`，新增的為 `api-key:<uuid>`，驗證回執為帳號加 `-validation`。Renderer 無法指定帳號；schema 拒絕不一致的身份與超限。
- 保存：`keyMutations` 以 connectionId 為鍵；`credentialMutations.qwen/deepseek` 仍等同預設密鍵。新密鍵驗證失敗不入庫、回 `keyErrors`，畫面保留該行與輸入；移除的密鍵連同回執從 Vault 刪除。未填寫過的預設密鍵不顯示。
- 讀取：`keyStatuses` 每鍵狀態加執行期健康（冷卻至 `retryAt`、被拒）只在讀取時計算，不入 SQLite；`credentials.qwen/deepseek` 為摘要，任一啟用密鍵已驗證即 valid。`providerKeys(provider)` 依順序回傳已啟用且已驗證的密鍵，翻譯、問答、檔案卡與圖片解讀共用；某鍵 401/403 經 `onCredentialRejected` 只標記該鍵。
- 兼容：1.3.0 的 getSettings 只取已知欄位、只讀預設帳號，降級後新增密鍵不被使用（未做降級實測）；損壞的連接列表回退預設。解除安裝列出服務下的 `api-key:*` 一併刪除。文庫備份只含連接描述，不含密鍵。

Bing／TranSmart 從新設定過濾；保留其餘順序與啟停意圖，零啟用來源顯示「未配置」、preferred 為 null，不自動啟用付費服務。歷史來源記錄不改寫。模型 Token 統計由 platform/models 的共用用量入口寫入既有檔案。
