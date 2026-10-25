# 1.3.0 Milestone：功能模組化與開發秩序

狀態：規劃中（2026-10-25 使用者確認方向）。本文件是本 milestone 的唯一進度入口，各階段完成後在此勾選並刪除過時說明；架構決策見 [ADR-0001](adr/0001-feature-modules.md)。

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
- [ ] `src/main/index.ts` ≤ 150 行，只做組裝；各功能自行註冊 IPC。
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

## 技術債清單（待逐項結論）

- Runtime 355.6／360 MiB，暫列 advisory（`release-policy.mjs`）。
- 中文全形標點緊貼 `**` 時粗體不渲染（問答回答中可見）。
- 部分圖說中 φ 顯示為「�」。
- Zotero 導入不顯示首頁進度卡（導入結果只回數量）。
- PDF 視圖無引用懸停（無鏈接注釋層）。
- 「重新翻譯此段」「長按拖曳排序」尚未在真實憑據下走過完整流程。
- CI「只測受影響部分」的選擇邏輯尚未在遠端驗證。
- RAG 時期遺留：`sqliteRagRepository.ts`、`rag-content-index` 作業與相關 schema；需先確認問答索引是否仍依賴，再決定刪除或改名歸入 chat 模組（schema 4 的 rag_* 表為遷移兼容必須保留）。

## 參考規範

- 版本與變更：Semantic Versioning 2.0、Keep a Changelog、Conventional Commits。
- 架構文件：C4 model、ADR（Michael Nygard 格式）。
- 性能：RAIL（回應 < 100 ms、每幀 16 ms、空閒工作分段 < 50 ms）。
- 安全：Electron Security Checklist（逐條核對並記錄結果）。
- 品質總表：ISO/IEC 25010 八個面向，作為 M6 審閱清單。

## 驗收紀錄

（各階段完成後在此記錄日期、提交與證據入口，一行一項。）
