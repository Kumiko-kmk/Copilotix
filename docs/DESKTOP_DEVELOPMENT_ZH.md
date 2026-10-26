# Copilotix Desktop 桌面翻译版

Copilotix 是个人开发的 Electron 论文阅读客户端。当前版本连接 MinerU 在线 v4 API，在本地保存解析产物并生成简体中文 Markdown，不包含本地解析引擎或模型。

完整的进程边界、数据布局、作业状态、发布约束和修改纪律见 [`ARCHITECTURE_ZH.md`](ARCHITECTURE_ZH.md)。

## 当前架构基线

```text
Renderer（React，sandbox，无 Node）
  -> Preload（contextBridge；Zod 验证的领域 API）
  -> Main（协调、Electron net、Credential Vault、作业调度）
  -> Core RPC（versioned envelope；JSON；每个 payload/envelope ≤ 1 MiB）
  -> Utility（SQLite 与 compute 的唯一拥有者）
```

Main 不持有 SQLite 连接；Utility 使用 `node:sqlite`、WAL 和 STRICT migrations。跨进程不传 PDF、ZIP、完整 Markdown、Buffer 或 stream。IPC/Core RPC 具备 sender/frame/来源校验、schema 验证、request timeout/cancel、Utility heartbeat/restart 和错误 envelope。

### 版本与本地数据

- Electron `44.1.1`
- Node.js `24.19.0`
- pnpm `11.19.0`
- Windows x64 目录版是当前发布目标
- Electron `userData`：`%APPDATA%\Copilotix-Translation-v2`
- 数据库：`%APPDATA%\Copilotix-Translation-v2\copilotix-desktop-v2.sqlite3`
- 结果：`<outputRoot>\documents-v2\{documentId}`

每个文档目录以 UUID 命名，通常包含 `original.pdf`、`full.md`、`full.zh-CN.md`、`layout.json`、`block_list.json`、可选 `content_list.json` 和图片。所有 artifact 使用 PathPolicy、受控 staging、hash、fsync 和 atomic rename；内部 `.translation/` 不进入结果 ZIP。

## 开发

需要 Windows x64、Node `24.19.0`、pnpm `11.19.0`，以及 Parser API Token。

```powershell
pnpm install
pnpm desktop:dev
```

首次安装依赖时，pnpm 可能要求批准 Electron、esbuild 和 electron-builder 的构建脚本；只批准已审阅的依赖脚本。

## 测试与实际门禁

日常修改先跑受影响的测试；需要扩大检查时使用以下入口，不默认执行全部验收：

| 命令 | 范围 |
| --- | --- |
| `pnpm desktop:test` | 只跑受改动影响的单元测试（`.test.ts`／`.test.tsx`／`.test.mjs` 按 import 图，改动落在某模块时另跑该模块整个测试目录）＋每次必跑的安全集；`desktop:test:changed` 为同一命令 |
| `pnpm desktop:test --module <name>` | 只跑一个模块自己的测试：`tests/features/<name>/`，或 `platform`、`app`（ADR-0001） |
| `pnpm desktop:test:e2e:affected` | smoke＋按改动路径映射的 E2E spec |
| `pnpm desktop:test:ui` | 显式运行 DOM／React 回归 |
| `pnpm desktop:test:full` | 所有保留的单元与集成测试 |
| `pnpm desktop:test:e2e` | 源码启动和窗口操作 smoke，无需安装包 |
| `pnpm desktop:test:e2e:full` | 全部 Electron 回归，需要发布产物的用例也包含在内 |
| `pnpm desktop:test:coverage` | 完整回归与覆盖率，仅用于完整验收 |

`scripts/affected-tests.mjs` 以 `--base`、`COPILOTIX_TEST_BASE` 或 merge-base(HEAD, master) 为基准，已提交、暂存、未暂存与未追踪文件都计入；`--list` 只列出选择。每次必跑的安全集为 ipcContracts、v2Database、sqliteJobRepository、jobScheduler、pathPolicy、libraryMaintenance、uninstallCleanup（数据安全、持久化、IPC 来源、取消恢复）。package.json、lockfile、vitest／vite／playwright 配置、tsconfig、工作流或脚本本身改变，或基准无法解析（新分支 push 的全零 SHA）时改跑全量。E2E 不 import 源码，因此按路径映射；preload、main/index.ts、App、e2e helpers 改动跑全部 spec，映射外的源码改动只跑 smoke。

普通 master push／PR 的 `build` 检查执行 lint、typecheck、受影响单元测试（相对 PR 目标或上一个 master 提交）、四 bundle 和 smoke＋受影响 E2E。功能分支通过 PR 合并结果验证，不再同时执行相同提交的 push 检查；未开 PR 的分支可手动运行。版本 tag 或手动 `full_validation` 才增加完整覆盖率、Electron 回归、打包、安装／升级／卸载及下载校验。完整回归与覆盖率先在 E2E 第 1 分片运行，与 build 打包并行；发布仍须 build 和三个分片全部成功。发布签章、资料保留和打包内建完整性检查仍保留。

覆盖率阈值仍为 lines/statements/functions `80%`、branches `75%`，仅在显式完整检查中执行。真实 API、真实翻译及个人 GUI 配置仍需单独授权和实际验证。

文库性能检查区分真实硬件与软件渲染：硬件保留 30 fps 下限；Microsoft Basic Render Driver、SwiftShader 等软件渲染器验证持续出帧，并保留帧率上限及三角形负载限制。软件渲染通过不代表真实显卡达到性能目标。阅读器专项通过减少动态效果模式进入，完整动画仍由文库专项验收。

手动工作流可选择 `archive_diagnostic`，在常规检查后单独诊断文库布局、公式、导航和档案生成，避免每次定位界面问题都重跑覆盖率与打包。该选项不替代完整验收；版本 tag 和 `full_validation` 仍执行全部回归、打包、安装及下载校验。

同类测试合并维护；不为布局常数、CSS 字符串或简单辅助函数单独建立套件。取消、恢复、持久化、路径隔离和凭证保护保留行为回归。流程入口与验证边界见根 [AGENTS.md](../AGENTS.md)。

## 构建与发布

```powershell
pnpm desktop:build:bundles
pnpm desktop:release:from-built
```

正式发布由 `desktop/scripts/package-directory.mjs` 生成 Windows x64 完整目录和 ZIP。它在精确 `.release-next-{buildId}` staging 中校验四个 bundle、ASAR entry、locale、fuses、资源、体积（当前 app.asar < 40 MiB、运行目录 < 360 MiB、ZIP < 155 MiB），生成 `release-manifest.json`/`SHA256SUMS.txt`，解压复核并运行：

```text
Copilotix.exe --copilotix-packaged-smoke
```

只有版本匹配的精确 smoke marker、空 stderr、哈希／manifest 校验全部成功后才原子发布；失败恢复旧目录并保留 staging。发布布局以 [Windows 发布](DESKTOP_RELEASE_ZH.md) 为准，勿单独复制 EXE；用户数据与凭据不在发布包内。

## 功能与隐私

当前提供 PDF 导入、官方解析、Markdown／表格翻译、阅读工作台、映射联动、标注、导出、文库与档案卡、单篇论文问答。问答与索引边界见 [维护契约](READER_AI_CHAT_PLAN_ZH.md)；多文献 RAG 路线已放弃。

PDF 会上传到 Parser 服务返回的预签名地址；待翻译文本会发送到所选翻译 Provider。Token 只发送到代码中固定的 Parser API 来源；API Key 进入 Credential Manager，不写 SQLite、Renderer、日志或结果 ZIP。日志会遮蔽 Token、API Key、Authorization 和预签名 URL 查询参数，不记录论文正文。

## 協作

遵循根 [AGENTS.md](../AGENTS.md)，不在此複製 owner、worktree、交付紀錄或授權規則。

## 契約（2026-10-26 自 AGENTS.md 遷入）

### 8. 遠端 CI 與驗證邊界

- 修改 → 本地 commit → 按需本地 build／交付；未授權不 push，未跑完整 CI 如實說明。授權上傳後檢查最新提交的 Actions，合併前 `build` 必須成功，PR 另須通過最新合併結果檢查；舊成功、跳過、取消皆不可替代。
- `.github/workflows/desktop-windows.yml` 覆蓋 master push、所有 PR、`desktop-v*` tag 及手動觸發；功能分支開 PR 後由合併結果檢查，避免同一提交重跑 push／PR。未開 PR 的分支可手動驗證；新分支須包含最新工作流。只 commit 不會觸發 Actions。
- 保留必需檢查名稱 `build`。完整驗證時 Electron E2E 在與 `build` 並行的三個 `e2e` 矩陣 job 執行，最短的第 1 片先執行完整單元／UI／發布腳本回歸與覆蓋率；`build` 顯式安裝 Electron 後構建，打包後只跑 packaged smoke。publish 同時依賴 build 和全部 e2e（含覆蓋率），任一失敗不可發布。一般 master push／PR 執行 frozen-lockfile、lint、typecheck、模組依賴規則（`desktop:deps`，ADR-0001）、受影響單元測試（相對 PR 目標或上一個 master 提交）＋必跑安全集、四 bundle 和 smoke＋按路徑映射的受影響 E2E（2026-10-22 使用者要求只測改動部分；CI 選擇邏輯尚未在遠端驗證）；不預設打包、跑全套 UI／覆蓋率或安裝。`desktop-v*` tag 或手動勾選 `full_validation` 才跑覆蓋率、全部 Electron E2E、打包／安裝生命週期及下載校驗；tag 的版本、許可、簽章與打包內建安全校驗仍必需。
- `Copilotix-Windows-x64-Bundle` 供安裝驗收；`Copilotix-Windows-verification-reports` 保存 build 的 JUnit、Playwright HTML 與安裝驗收證據；`Copilotix-Windows-e2e-reports-<n>` 保存各片 Playwright HTML／失敗證據，第 1 片另存完整回歸 JUnit 與覆蓋率摘要。CI 未過不可稱已驗證包；CI 無個人 API 憑據，付費模型、視覺及硬體差異仍須真人驗收。

### 9. CI 與夾具維護

- Vitest 預設 ≤2 workers，Windows Playwright 單 worker；JUnit 放 `desktop/unit-test-results`。`desktop:test`／`desktop:test:e2e:affected` 由 `scripts/affected-tests.mjs` 選擇受影響用例（三類測試檔都按 import 圖，E2E 按路徑映射），必跑安全集、全量觸發條件與映射見 [開發文檔](docs/DESKTOP_DEVELOPMENT_ZH.md#测试与实际门禁)；`desktop:test:full`、`desktop:test:e2e:full`、tag 與 `full_validation` 仍為全量，發布前必須全量通過。新增資料安全類測試檔時同步加入必跑集。新測試按功能加入現有套件，不為簡單 getter、動畫常數、CSS 或資料形狀再建文件。
- Windows 原子 rename 對 EPERM／EACCES／EBUSY 最多約 6.3 秒有界重試；永久錯誤 exit 1，不用 copy／delete 替代。packaged smoke 前須有 Setup、uninstaller、release-manifest、ZIP；其餘 E2E 只需 bundle。
- E2E 分片按 `desktop/playwright.config.ts` 的 `E2E_SHARDS` 實測時長分配（各單 worker），最後一片收下未列出的 spec；`COPILOTIX_E2E_SHARD` 為 `n/總數`，總數須與清單和工作流 matrix 一致，否則報錯。某片明顯變長時按 CI 日誌重新分配。
- 僅「未打包＋NODE_ENV=test＋COPILOTIX_E2E_USER_DATA」用獨立 native vault service；夾具只清理自身六種 account，不碰真人憑據。問答 E2E 經真實設定 IPC 存假 Key，僅 mock provider HTTP。
- 任務管理頁與首頁「繼續閱讀」已移除；閱讀器一般經 `openPaperFromLibrary`（文庫搜尋 → 結果 `data-document-id` → 瀏覽面板「打开阅读」，無 WebGL 時結果直接開啟）進入，等 reader-header（≤30 秒）及 Markdown ready 再互動，error 不算 ready；不加全局 retry／timeout 或降低斷言。從文庫進入的 Reader 返回文庫。
- 縮略圖截圖用直角 app-shell 與完整 CSS 像素裁切，channel delta ≤1、changedRatio ≤0.001；失敗保留 expected／actual PNG。

### 文檔與驗收（原 AGENTS §12）

- README／Wiki 源在 `docs/wiki/`，不會隨目錄提交自動發布；遠端上傳須另獲授權。真人模型／視覺驗收不能以 mock 或歷史 CI 替代。
