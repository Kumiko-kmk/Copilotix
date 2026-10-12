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

```powershell
pnpm desktop:lint
pnpm desktop:typecheck
pnpm desktop:test:coverage
```

当前 Vitest coverage gate（`desktop/vitest.config.ts`）是：lines `80%`、statements `80%`、functions `80%`、branches `75%`。统计范围主要是 `src/main/**`、`src/core/**`、`src/shared/**`，renderer、preload、utility、测试、生成文件及纯类型文件等按配置排除；新代码不可通过扩大排除项规避门禁。

CI 还执行 bundle build、verified directory release、脚本/发布校验和 Playwright E2E。真实 API、真实翻译、真实 PDF 和 GUI E2E 是有条件的验证，不得用未运行的本机命令补写通过结论。

本地驗證是否執行、實際通過範圍與環境限制以根 [AGENTS.md](../AGENTS.md) 為入口。CLI smoke 不代表 GUI 驗收；測試啟動策略不改產品或 CI 的 sandbox。

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
