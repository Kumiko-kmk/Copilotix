# Agent 入口（永久保留）

本文件只放入口與規則，保持精簡；細節在模組 README 與 `docs/`，同一事實只寫一處，過時內容直接刪。

## 協作

- 動手前、交付前執行 `git status --short --branch`；不改、不清理、不 stash 其他 agent 的 worktree。跨分支只經 commit 傳遞。
- 未經使用者明確授權不 push、不上傳產物、不觸發遠端發布；只有使用者要求時才打包，否則提供隔離資料目錄的實際截圖。
- 不加懸停提示（`title`、Tooltip、Popover）；例外僅閱讀器筆記與正文引用參考文獻卡。見 [介面偏好](docs/UI_PREFERENCES_ZH.md)。
- 修改 schema、migration、IPC、Core RPC、作業倉庫、Artifact/PathPolicy 或發布腳本，須在所屬模組 README 記錄兼容策略、測試證據與恢復語義。
- 不寫總結／審計／流水文檔；更新既有入口。

## 模組化開發（[ADR-0001](docs/adr/0001-feature-modules.md)）

代碼只在 `desktop/src` 三處：

- `app/`：Main／Preload／Renderer／Utility 入口與組裝、Core RPC 註冊表（`app/contract/coreRpc.ts`）、`CopilotixDesktopApi`；不放業務邏輯。
- `platform/<關注點>/<層>/`：ipc、rpc、jobs、database、files、log、network、assets、credentials、uninstall、codex、markdown、pdf；不得引用 `features/`。
- `features/<模組>/<層>/`：`library`、`parsing`、`translation`、`reader`、`chat`、`insight`、`zotero`、`settings`。層為 `contract`（zod 契約，純資料）、`core`（純邏輯）、`runtime`（Node、無 Electron）、`main`、`utility`、`renderer`，每層一個 `index.ts` 公開入口。

規則（`pnpm desktop:deps` 全部為 error，CI 執行）：模組間只能引用對方 `contract/` 或某層 `index.ts`；禁止循環；進程層互不越界（renderer 不碰 main／node／electron，contract／core 不碰 node／electron）。

開發一個功能：

1. 先讀該模組 `README.md`（用途、公開 API、資料檔、契約、測試入口），改動限於該模組；需要別的模組能力時先在對方公開入口暴露。
2. IPC 頻道在模組 `contract/ipc.ts` 聲明一次（Main 以 `IpcRegistrar` 註冊，preload 由 `createDesktopApi` 組合）；Core RPC 在模組 `contract/rpc.ts` 聲明並加入註冊表。
3. 測試放 `desktop/tests/features/<模組>/`；跑 `pnpm desktop:test --module <模組>`。
4. 單檔 ≤ 600 行，例外寫進模組 README。新模組或跨模組決策寫 ADR。

## 構建與驗證

- Node **24.19.0**、pnpm **11.19.0**（系統 Node 24.11.1 不可用）。在倉庫根目錄：`pnpm install`、`pnpm desktop:build:bundles`；打包 `pnpm desktop:release:from-built`（僅使用者要求時）。
- 日常：`pnpm desktop:test`（受影響用例＋必跑安全集）或 `--module <模組>`；全量 `desktop:test:full`、E2E `desktop:test:e2e:full`，發布前必須全量通過。資料安全、持久化、IPC 來源、取消恢復類回歸不得刪。
- 修改後依序：`desktop:typecheck`、`desktop:lint`、`desktop:deps`、受影響測試、構建。

## 文檔入口

- 進行中：[1.3.0 milestone](docs/MILESTONE_1_3_ZH.md)（進度、技術債、驗收紀錄）。
- 架構與平台契約：[ARCHITECTURE](docs/ARCHITECTURE_ZH.md)；開發、測試與 CI：[DESKTOP_DEVELOPMENT](docs/DESKTOP_DEVELOPMENT_ZH.md)；打包、簽名與 Setup：[DESKTOP_RELEASE](docs/DESKTOP_RELEASE_ZH.md)。
- 專項：[Markdown 格式](docs/MARKDOWN_FORMAT_ZH.md)、[問答](docs/READER_AI_CHAT_PLAN_ZH.md)、[文庫維護](docs/LIBRARY_MANAGEMENT_ZH.md)、[Zotero](docs/ZOTERO_BRIDGE_ZH.md)、[檔案卡](docs/PAPER_INSIGHT_ZH.md)、[簽章政策](docs/CODE_SIGNING_POLICY.md)；索引見 [docs/README](docs/README.md)。
