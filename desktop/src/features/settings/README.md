# settings

設定頁（服務連接、模型、存儲、显示设置）及其 Main 服務：設定持久化、憑據校驗、存儲統計與 API 用量統計。介面規則見 [介面偏好](../../../../docs/UI_PREFERENCES_ZH.md)。

## 公開 API

- `contract/ipc.ts`：`settingsChannels`（`settings:get`／`save`／`validate-credential`、`dialog:output-directory`、`storage:info`、`storage:open-location`、`analytics:usage`）與 `createSettingsApi`；`settingsTypes.ts`、`settingsSchemas.ts`（設定、憑據、存儲與用量的型別與 schema）、`defaultSettings.ts`（`DEFAULT_SETTINGS`）。
- `main/index.ts`：`SettingsService`、`UsageAnalyticsService`（`UsageAnalyticsRecorder`、`ProviderTokenUsage` 供解析、翻譯、問答記錄用量）、`registerSettingsIpc`。
- `renderer/index.ts`：`SettingsPage`、主題（`restoreTheme`、`currentTheme`、`onThemeChange`、`mixHex`、`rgbChannels`）、`refreshCodexStatus`／`useCodexStatus`、`loadStorageInfo`、`SettingsNavigationGuard`。

## 資料

- 設定經 Core RPC `settings:*` 存入 SQLite；API Key 只在 Windows 憑據庫（`platform/credentials`），不進設定與備份。
- `userData/usage-analytics-v1.json`：每日頁數與各服務商 Token 用量。
- localStorage `copilotix.theme.v1`、`copilotix.reader.font-size.v1`、`copilotix.reader.line-height.v1`：顯示設定，經「保存全部更改」寫入。

存儲統計在啟動／文庫根目錄或文檔數量變化時預載，按文庫根目錄快取60秒並合併並發掃描；手動刷新強制更新。

## 測試

`tests/features/settings/`（`pnpm desktop:test --module settings`）；設定頁 E2E 在 `e2e/ui-chrome.spec.ts`、`qa-fixes.spec.ts`。

## 例外

無超過 600 行的檔案（`SettingsPage.tsx` 的用量與存儲面板拆在 `SettingsDashboards.tsx`）。

## 多 API 密鍵

- 「API 密钥」視圖（`renderer/ApiKeysSection.tsx`）按服務商管理 Qwen／DeepSeek，各最多 5 個（`MAX_KEYS_PER_PROVIDER`）：名稱、啟用、拖曳／方向鍵排序、測試、更換、刪除；新增與更換只在記憶體，保存時逐個驗證。服務連接頁只留一行摘要與「管理密钥」。
- 每個密鍵是 `modelConnections` 的一項；Vault 帳號由 connectionId 推導（`credentialRefFor`），`:default` 沿用 1.3.0 的 `qwen-api-key`／`deepseek-api-key`，新增的為 `api-key:<uuid>`，驗證回執為帳號加 `-validation`。Renderer 無法指定帳號；schema 拒絕不一致的身份與超限。
- 保存：`keyMutations` 以 connectionId 為鍵；`credentialMutations.qwen/deepseek` 仍等同預設密鍵。新密鍵驗證失敗不入庫、回 `keyErrors`，畫面保留該行與輸入；移除的密鍵連同回執從 Vault 刪除。未填寫過的預設密鍵不顯示。
- 讀取：`keyStatuses` 每鍵狀態加執行期健康（冷卻至 `retryAt`、被拒）只在讀取時計算，不入 SQLite；`credentials.qwen/deepseek` 為摘要，任一啟用密鍵已驗證即 valid。`providerKeys(provider)` 依順序回傳已啟用且已驗證的密鍵，翻譯、問答、檔案卡與圖片解讀共用；某鍵 401/403 經 `onCredentialRejected` 只標記該鍵。
- 兼容：1.3.0 的 getSettings 只取已知欄位、只讀預設帳號，降級後新增密鍵不被使用（未做降級實測）；損壞的連接列表回退預設。解除安裝列出服務下的 `api-key:*` 一併刪除。文庫備份只含連接描述，不含密鍵。

Bing／TranSmart 從新設定過濾；保留其餘順序與啟停意圖，零啟用來源顯示「未配置」、preferred 為 null，不自動啟用付費服務。歷史來源記錄不改寫。模型 Token 統計由 platform/models 的共用用量入口寫入既有檔案。
