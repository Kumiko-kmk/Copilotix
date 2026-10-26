# settings

設定頁（服務連接、模型、存儲、显示设置）及其 Main 服務：設定持久化、憑據校驗、存儲統計與 API 用量統計。介面規則見 [AGENTS.md §3](../../../../AGENTS.md) 與 [介面偏好](../../../../docs/UI_PREFERENCES_ZH.md)。

## 公開 API

- `contract/ipc.ts`：`settingsChannels`（`settings:get`／`save`／`validate-credential`、`dialog:output-directory`、`storage:info`、`storage:open-location`、`analytics:usage`）與 `createSettingsApi`；`settingsTypes.ts`、`settingsSchemas.ts`（設定、憑據、存儲與用量的型別與 schema）、`defaultSettings.ts`（`DEFAULT_SETTINGS`）。
- `main/index.ts`：`SettingsService`、`UsageAnalyticsService`（`UsageAnalyticsRecorder`、`ProviderTokenUsage` 供解析、翻譯、問答記錄用量）、`registerSettingsIpc`。
- `renderer/index.ts`：`SettingsPage`、主題（`restoreTheme`、`currentTheme`、`onThemeChange`、`mixHex`、`rgbChannels`）、`refreshCodexStatus`／`useCodexStatus`、`loadStorageInfo`、`SettingsNavigationGuard`。

## 資料

- 設定經 Core RPC `settings:*` 存入 SQLite；API Key 只在 Windows 憑據庫（`platform/credentials`），不進設定與備份。
- `userData/usage-analytics-v1.json`：每日頁數與各服務商 Token 用量。
- localStorage `copilotix.theme.v1`、`copilotix.reader.font-size.v1`、`copilotix.reader.line-height.v1`：顯示設定，經「保存全部更改」寫入。

## 測試

`tests/features/settings/`（`pnpm desktop:test --module settings`）；設定頁 E2E 在 `e2e/ui-chrome.spec.ts`、`qa-fixes.spec.ts`。

## 例外

無超過 600 行的檔案（`SettingsPage.tsx` 的用量與存儲面板拆在 `SettingsDashboards.tsx`）。
