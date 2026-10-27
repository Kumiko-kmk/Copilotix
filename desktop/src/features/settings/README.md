# settings

設定頁（服務連接、模型、存儲、显示设置）及其 Main 服務：設定持久化、憑據校驗、存儲統計與 API 用量統計。介面規則見 下方「契約」與 [介面偏好](../../../../docs/UI_PREFERENCES_ZH.md)。

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

## 契約（2026-10-26 自 AGENTS.md 遷入）

### 3. 設定頁與新 UI 對齊

- 以「服務連結」內容區為尺寸基準：頁籤根節點是 `.settings-content-body` 的直接子元素，使用 `.settings-section` 並填滿可用寬高。
- 不重複導覽標題、不用空白標題佔位、不加專屬外層 margin／padding／max-width；首張卡片的頂、左、右邊緣須與基準一致。
- 卡片內距可自訂；以 `section`／`aria-label` 保留與導覽一致的區域名稱。測試驗證可按名稱查找、無重複標題及共用根類別。
- 設定「显示设置」（原「主題外觀」）：整頁限一個視窗高度、不捲動；上方淺／深兩組主題並排、各三張小卡（窄卡隱藏英文名），下方「阅读」區含字號、行間距與共用預覽。`theme.ts` 主題共六套（三淺三深，主題卡不加文字說明）寫入 :root 色 token（`--surface`／`--sheet`／`--ink`／`--on-ink`／`--primary`… 及文庫 3D 用 `--theme-archive-*`）；深色主題另切 antd darkAlgorithm、`color-scheme`、`--lift`、黑色 `--shadow-ink` 與 `--shell-edge`，PDF 頁面保持白紙。antd、canvas 與 Three.js 均從 token 讀色；主題、閱讀字號（13–22px，`--reader-font-size`，Markdown 正文、標題、表格按 em 縮放）與行間距（1.4–2.4 倍，步長 0.1，預設 1.8，`--reader-line-height` 作用於 `.markdown-body`）點選即預覽，但屬設定草稿：經「保存全部更改」寫入 localStorage `copilotix.theme.v1`／`copilotix.reader.font-size.v1`／`copilotix.reader.line-height.v1`，「放弃更改」或未保存離開即還原，並參與離開確認；只改外觀時不調用 settings IPC。新增顏色一律用 token，語義色（成功／警告／錯誤）、PDF 疊層與高亮色板除外。
- 使用者已選擇設定離開確認：應用內離開設定頁時，有草稿須提供「保存并离开／放弃并离开／继续编辑」。保存失敗或憑據部分失敗留在原頁並保留失敗欄位；未保存 API Key 僅留記憶體。設定內頁籤切換保留草稿、不彈確認。
