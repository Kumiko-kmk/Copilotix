# 1.3.0 Milestone：功能模組化與開發秩序

狀態：進行中（2026-10-25 使用者確認方向；重構在分支 `modularize-1.3`）。本文件是本 milestone 的唯一進度入口，各階段完成後在此勾選並刪除過時說明；架構決策見 [ADR-0001](adr/0001-feature-modules.md)。

## 目標

重點是**開發層**的秩序，不是新功能：

1. 功能邊界清晰：每個功能有固定位置、公開入口與資料契約，改一個功能不需要翻遍四個進程層。
2. 可分模組測試：能只跑某個模組的測試，模組間只靠契約測試銜接。
3. 可分模組開發：多個 agent 或分支同時改不同模組時，不再碰同一批檔案。
4. **行為不變**：重構只搬代碼與拆檔案，不改使用者可見行為；行為改動另走功能分支。

## 現狀（2026-10-25 量測）

- 約 4.2 萬行 TypeScript，按**進程層**分目錄：`main` 7.6k、`renderer` 16.5k、`utility` 8.9k、`shared` 6.2k、`core` 1.1k、`runtime` 0.6k、`preload` 0.2k。
- 進程層邊界已由 `eslint.config.mjs` 的 `no-restricted-imports` 守住（renderer 不碰 main／electron，shared／core 不碰 node 與 electron），這部分保留。
- **功能之間沒有邊界**：一個功能（例如閱讀器編輯層）同時散落在 `shared/markdownEdits.ts`、`main/artifactService.ts`、`utility/...`、`renderer/components/MarkdownPane.tsx`；`shared/` 是 40 個檔案的雜物間。
- 中樞檔案過大：`main/index.ts` 723 行承擔 31 個 IPC handler 與全部組裝；`preload/index.ts` 手寫全部 API。
- 超過 600 行的檔案 15 個，最大 `PaperArchiveScene.ts` 1667 行、`markdownTranslationPlan.ts` 1361、`v2TaskRepositoryCompat.ts` 1326、`MarkdownPane.tsx` 1109。
- 本地 `master` 領先 `origin/master` 44 個提交，從未經遠端 CI；版本號仍為 1.2.0。

## 退出標準（全部達成才算完成）

- [ ] 依賴規則（dependency-cruiser）以 **error** 模式通過，0 違規；CI 中執行。
- [x] `src/main/index.ts`（現 `src/app/main/index.ts`，76 行）≤ 150 行，只做組裝；各功能自行註冊 IPC。
- [ ] 每個功能模組有 `index.ts` 公開入口與一頁 `README.md`（用途、公開 API、資料檔、測試入口）。
- [ ] 非生成檔案 ≤ 600 行；例外須在模組 README 說明原因。
- [ ] `pnpm desktop:test --module <name>` 可只跑單一模組；受影響測試選擇改按模組圖。
- [ ] 性能預算進入測試門禁：打開已處理論文至首屏 ≤ 1.5 s、編輯／刪除可見回應 ≤ 100 ms、捲動無 > 50 ms 長任務。
- [ ] 遠端 `full_validation` CI 全綠；核心旅程 E2E（導入→解析→翻譯→閱讀→編輯／刪除→問答→導出 Zotero）通過。
- [ ] 真實文庫走查一次（使用者或在隔離副本），結果記入下方「驗收紀錄」。
- [ ] 技術債清單每項都有結論（修掉／延後並寫原因）。

## 階段

每個階段是一次可獨立合併、可回滾的變更；階段之間跑 `desktop:test:full` 與受影響 E2E。**同一時間只由一個 agent 執行重構**，避免大規模搬檔衝突。

| 階段 | 內容 | 完成標誌 |
|---|---|---|
| M0 基線 | 推到功能分支跑 `full_validation`（需使用者授權 push）；記錄依賴圖基線；加性能預算測試；清理殘留 worktree／`.release-next-*` | CI 綠、基線報告 |
| M1 規則 | 寫入 ADR-0001 的模組地圖；加入 dependency-cruiser（warn 模式），列出違規基線 | 違規清單 |
| M2 平台層 | 抽出 `platform/`：IPC 註冊表、原子檔案、日誌、Utility RPC、Codex runtime、憑據庫；不含功能邏輯 | 平台層不依賴任何功能 |
| M3 中樞拆分 | `main/index.ts` 改為組裝；各功能以 `register(ipc, deps)` 註冊；IPC 契約按功能拆檔，preload 由契約組合 | index.ts ≤ 150 行 |
| M4 逐模組遷移 | 按耦合由低到高：zotero → settings → insight → chat → translation → parsing → library → reader；reader 同時拆 MarkdownPane／PdfPane／Workbench | 每搬完一個模組，規則對它改 error |
| M5 收尾 | `shared/` 拆入各模組契約；規則全面 error；刪除死代碼（先驗證 RAG 殘留是否仍被問答索引使用） | 退出標準前五項 |
| M6 文件 | ARCHITECTURE 依 C4 重寫（系統／容器／元件）；各模組 README；決策寫 ADR；AGENTS.md 瘦身為入口；技術債清單 | 文件審閱 |
| M7 發布 | 版本號 1.3.0、CHANGELOG（Keep a Changelog）、RC 給使用者試用、全量 CI、打 tag（需授權） | 1.3.0 tag |

### 階段進度

- [ ] M0 基線（push／遠端 CI 待授權；worktree 清理由主對話處理）
- [x] M1 規則
- [x] M2 平台層
- [x] M3 中樞拆分
- [ ] M4 逐模組遷移：~~zotero~~ · ~~settings~~ · ~~insight~~ · ~~chat~~ · ~~translation~~ · parsing · library · reader
- [ ] M5 收尾

### 依賴基線（M1，2026-10-25）

`pnpm desktop:deps`（warn 模式，CI 在 typecheck 後執行）：274 個模組、1165 條依賴，**9 個違規，全為 `no-circular`**，皆在 `shared/`：`types.ts` 與 `ipcSchemas`、`paperChatSchemas`、`paperChatStorageSchemas`、`paperInsight`、`figureInsight`、`pdfImport`（經 `titleNaming`）互相引用型別（7 個）；`readerFigureGroups` ↔ `readerFigureLayout`；`paperBrief/lengths` ↔ `paperBrief/schema`。功能邊界 0（尚無 `features/`），進程層 0，入口不可達的檔案 0。跨模組耦合集中在 `shared/types.ts`、`ipcSchemas.ts`、`coreRpcSchemas.ts`、`utilityOperations.ts`、`main/index.ts`、`preload/index.ts` 六個中樞，M2–M5 依次拆開。

## 技術債清單（待逐項結論）

- Runtime 355.6／360 MiB，暫列 advisory（`release-policy.mjs`）。
- 中文全形標點緊貼 `**` 時粗體不渲染（問答回答中可見）。
- 部分圖說中 φ 顯示為「�」。
- Zotero 導入不顯示首頁進度卡（導入結果只回數量）。
- PDF 視圖無引用懸停（無鏈接注釋層）。
- 「重新翻譯此段」「長按拖曳排序」尚未在真實憑據下走過完整流程。
- CI「只測受影響部分」的選擇邏輯尚未在遠端驗證。
- 本機 E2E `reader.spec.ts`「keeps the complete minimap static across long-document jumps」穩定失敗（標題距捲動容器頂 15.45 px，期望 16±0.5），master 原樣即如此，疑與顯示縮放有關；待在 CI／其他機器確認。
- RAG 時期遺留：`sqliteRagRepository.ts`、`rag-content-index` 作業與相關 schema；需先確認問答索引是否仍依賴，再決定刪除或改名歸入 chat 模組（schema 4 的 rag_* 表為遷移兼容必須保留）。

## 參考規範

- 版本與變更：Semantic Versioning 2.0、Keep a Changelog、Conventional Commits。
- 架構文件：C4 model、ADR（Michael Nygard 格式）。
- 性能：RAIL（回應 < 100 ms、每幀 16 ms、空閒工作分段 < 50 ms）。
- 安全：Electron Security Checklist（逐條核對並記錄結果）。
- 品質總表：ISO/IEC 25010 八個面向，作為 M6 審閱清單。

## 驗收紀錄

（各階段完成後在此記錄日期、提交與證據入口，一行一項。）

- 2026-10-25 M4 translation：服務商、計劃編排、作業、計劃協定、Utility 計劃與表格翻譯 13 檔移入 `features/translation`；Core RPC 聲明與 Utility handler 歸模組；`markdownTranslationPlan.ts` 1361→975 行（型別、常量與純函式拆至 `planModel.ts`，其餘為狀態機，README 註明例外）；`feature-boundary-translation` 改 error。門禁同前（847 通過、E2E 僅既有 minimap 失敗）。
- 2026-10-25 M4 chat：問答服務、模型閘道、Utility 存儲、檢索索引（RAG 殘留確認仍為問答上下文來源，整體歸入 chat，作業名與 rag_* 表不變）、契約與 renderer 共 32 檔移入 `features/chat`；chat 的 Core RPC 聲明與 Utility handler 歸模組；`sqliteRagRepository.ts` 656 行拆為 repository（290）＋ `ragRecords.ts`（394，型別、行映射與校驗）；`feature-boundary-chat` 改 error。門禁同前（847 通過、E2E 僅既有 minimap 失敗）。utility smoke 首次失敗：bundle 佈局改變後，Node 回顯的拋錯源碼行（一整行壓縮代碼，含 pdf-lib 的 "TypeError" 字樣）被誤判為執行期錯誤；`utility-bundle-smoke.mjs` 改為忽略該回顯段，只檢查診斷輸出，並補兩條斷言。
- 2026-10-25 M4 insight：檔案卡與圖片解讀的 Main 服務、Utility 存儲、`paperBrief/`、契約與 renderer 共 22 檔移入 `features/insight`；insight 的 Core RPC 聲明移入 `contract/rpc.ts`，Utility handler 移入 `utility/operations.ts`（`utilityOperations.ts` 只展開）；`CoreUtilityOperationHandler` 去掉泛型（handler 自行校驗 payload，型別上不再依附單一註冊表）；拆掉 `lengths` ↔ `schema` 循環（`ARCHIVE_LENGTHS` 移至 `archiveLengths.ts`）；`feature-boundary-insight` 改 error。門禁同前（847 通過、E2E 僅既有 minimap 失敗）；deps 5 warn（1 循環＋4 個 app-is-root）。
- 2026-10-25 M4 settings：設定、用量、存儲服務與設定頁、主題、Codex 狀態等 12 個檔案移入 `features/settings/{main,renderer}`，外部引用改走 layer index；`SettingsPage.tsx` 739→587 行（面板拆至 `SettingsDashboards.tsx`）；`feature-boundary-settings` 改 error。門禁同前（847 通過、E2E 僅既有 minimap 失敗）。
- 2026-10-25 M4 zotero：`main/zotero/*`、`shared/zotero.ts`、兩個 renderer 元件與樣式移入 `features/zotero/{main,contract,renderer}`，加 `main/index.ts`、`renderer/index.ts`、README；`feature-boundary-zotero` 改 error（0 違規，探針驗證內部引用會報錯）；`affected-tests.mjs` 加 `--module <name>` 與按模組補跑整個測試目錄。門禁同 M3（847 通過、E2E 僅既有 minimap 失敗）；renderer 產物檔名不變。
- 2026-10-25 M3：入口移入 `src/app/{main,preload,renderer,utility}`（輸出仍為 `out/{main,preload,renderer,utility}`，產物檔名不變，renderer bundle 雜湊不變）；`main/index.ts` 723 行拆為 `app/main/index.ts`（76 行生命週期）、`bootstrap`（組裝）、`window`、`services`、`packagedSmoke`；IPC 改為各模組 `contract/ipc.ts` 聲明頻道與 preload API 工廠、`main/ipc.ts` 註冊（library、parsing、translation、reader、chat、insight、zotero、settings，codex 在 platform，視窗在 app），57 個頻道名與舊 preload 逐一相同；`CopilotixDesktopApi` 移至 `app/contract/desktopApi.ts`。基線循環 9→2。typecheck、lint 0 錯誤、847 通過、覆蓋率 84.2／82.1／87.6％（門檻內）、build＋utility smoke 通過、E2E 30 通過／3 跳過，僅既有 minimap 失敗。
- 2026-10-25 M2：44 個檔案移入 `src/platform/`／`tests/platform/`（ipc、rpc、jobs、database、files、log、network、assets、credentials、uninstall、codex、markdown、pdf）；Core RPC 協定改為 `createCoreProtocol(registry)`，`CoreClient`、`UtilitySupervisor`、`createCoreUtilityRuntime` 由構造參數注入，完整註冊表在 `app/contract/coreRpc.ts`（operation 名、schema、線上校驗不變）；作業 RPC schema 移入 `platform/jobs/contract/rpc.ts`。`platform-no-features` 改為 error（0 違規）；新增 6 個 `app-is-root` warn（`main/index.ts`、`utility/index.ts`、`utilityOperations` 與三個 Rpc 轉接器暫借 app 註冊表型別，M3／M4 消除）。typecheck、lint 0 錯誤、`desktop:test:full` 847 通過／3 跳過、build:bundles＋utility smoke 通過、E2E（ipc／rpc 變更觸發全量）30 通過／3 跳過，僅既有 minimap 失敗。
- 2026-10-25 M1：加入 dependency-cruiser 16.10.4（`desktop/.dependency-cruiser.cjs`，warn）、ADR 模組地圖與基線；順帶以行內註解消除 master 既有的 lint 錯誤（`paperChatFigures.ts` 的 `no-control-regex`，正則本意即拒絕控制字元）。typecheck、lint（0 錯誤）、`desktop:test:full` 847 通過／3 跳過、deps 9 warn；build:bundles＋utility smoke 通過；全量 E2E（package.json 變更觸發）30 通過／3 跳過／1 失敗：`reader.spec.ts` 小地圖跳轉後標題偏移 15.45 px（期望 16±0.5），重跑 3 次結果相同，M1 未改任何運行代碼，記入技術債。
