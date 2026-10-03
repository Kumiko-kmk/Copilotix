# Copilotix Desktop 桌面翻译版

Copilotix 是个人开发的 Electron 论文阅读客户端。当前版本连接 MinerU 在线 v4 API，在本地保存解析产物并生成简体中文 Markdown，不包含本地解析引擎或模型。

完整的进程边界、数据布局、作业状态、发布约束和修改纪律见 [`ARCHITECTURE_ZH.md`](ARCHITECTURE_ZH.md)；RAG 未来计划见 [`RAG_DEVELOPMENT_PLAN_ZH.md`](RAG_DEVELOPMENT_PLAN_ZH.md)。

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

### 当前 Windows 环境说明

在当前 Windows build `26200` + GameViewer 环境，sandboxed Renderer/GPU 原生启动失败；因此没有本机 GUI E2E 通过证据。专用 packaged CLI smoke 已通过，且不启动 Renderer，它不能证明 GUI、GPU、Renderer 或 RAG 可用。

该限制不授权修改产品安全基线：不得降低产品默认、发布配置或 CI 的 Renderer/GPU sandbox，也不得把 `--disable-gpu-sandbox` 作为产品建议。GUI E2E 的通过证据必须来自具备原生启动条件的受控环境。

## 构建与发布

```powershell
pnpm desktop:build:bundles
pnpm desktop:release:from-built
```

正式发布由 `desktop/scripts/package-directory.mjs` 生成 Windows x64 完整目录和 ZIP。它在精确 `.release-next-{buildId}` staging 中校验四个 bundle、ASAR entry、locale、fuses、资源、体积（当前 app.asar < 40 MiB、运行目录 < 360 MiB、ZIP < 155 MiB），生成 `release-manifest.json`/`SHA256SUMS.txt`，解压复核并运行：

```text
Copilotix.exe --copilotix-packaged-smoke
```

只有精确的 `COPILOTIX_PACKAGED_SMOKE_OK app=1.0.0 electron=44.1.1` marker、空 stderr、哈希/manifest 审计全部成功后，才会把新目录原子发布到根目录 `release/`；失败时恢复旧目录并保留 staging。发布包是完整目录，不要只复制 `Copilotix.exe`；`userData` 和 Credential Manager 不在发布包内。

## 功能与隐私

当前提供 PDF 导入、官方解析、Markdown/表格翻译、原文/译文/布局阅读、PDF 与 block mapping 联动、荧光笔/下划线标注和另存结果。`ReaderChatSelection` 目前只是 Renderer 选区 payload；当前没有 chunk、index、embedding、vector、FTS、reranker、retrieval 或 chat backend，不要把“添加到对话”当作已实现聊天。

PDF 会上传到 Parser 服务返回的预签名地址；待翻译文本会发送到所选翻译 Provider。Token 只发送到代码中固定的 Parser API 来源；API Key 进入 Credential Manager，不写 SQLite、Renderer、日志或结果 ZIP。日志会遮蔽 Token、API Key、Authorization 和预签名 URL 查询参数，不记录论文正文。

## 协作与已知事项

共享工作区中的公共契约必须有唯一 owner：`shared` schema、Preload API、Main IPC、Core RPC、v2 migration、JobRepository、Artifact/PathPolicy 和发布脚本均需先登记变更、兼容策略、测试和恢复语义。开始/结束记录 `git status --short --branch`；不得覆盖他人改动、stash、清理 release、升级无关依赖或修改其他 worktree。文档中的 `implemented`、`verified`、`planned`、`blocked` 必须有源码/测试证据。

Copilotix 自有代码已采用根目录 MIT 许可证，桌面 package 元数据同步为 MIT；第三方组件仍按各自许可分发。
