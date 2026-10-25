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
