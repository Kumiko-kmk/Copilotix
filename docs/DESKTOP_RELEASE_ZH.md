# Windows 桌面发布

## 本地开发包

本地人工测试可生成未签名的精简 Release 包：

```powershell
pnpm desktop:build:bundles
pnpm desktop:release:from-built
```

默认为 `COPILOTIX_RELEASE_MODE=development`。`pnpm desktop:release` 会先完整 build 再执行同一流程。从 1.2.0 起，公开 Release 只上传 `setup.exe`，源代码由 GitHub 按 tag 自动提供 ZIP／tar.gz；不上传运行包 ZIP、SHA 或 manifest。以下本地／CI 布局与内部完整性校验继续保留：

```text
release/
  setup.exe
  uninstall.exe
  安装说明.txt
  advanced/bundle-manifest.json
  advanced/SHA256SUMS.txt
  advanced/release-manifest.json  # 外层发布元数据，不放入 ZIP
release-artifacts/<build-id>/
  Copilotix-1.0.0-win-x64.zip
  program/Copilotix.exe           # 仅开发验收，不进入下载 ZIP
```

下载 ZIP 内仅有一个版本根目录，包含 Setup、卸载入口、说明和校验文件。完整程序已嵌入 Setup；开发运行副本只存于 `release-artifacts/<build-id>/program/`，不进入 ZIP，避免重复交付约 150 MiB 的运行时压缩数据。无需下载开发副本即可离线安装。

当前版本为 **1.3.0**（以 `desktop/package.json` 为准），安装入口固定为 `setup.exe`；版本仍写入 ZIP 名、程序和安装登记。安装目录页后提供默认勾选的“创建桌面图标”，可自行取消。下文体积数值为历史构建记录，当前产物以最终 manifest 为准。

manifest schema 5 标记 `distribution: compact-setup` 和 `runtime.embeddedIn`。外层 `artifactDirectory` 定位 ZIP 所在目录，`runtimeArtifactDirectory` 定位开发运行副本。runtime EXE/ASAR 哈希描述 Setup 内已验证的程序，不表示 ZIP 中存在独立 program。内层 bundle-manifest 保存程序、Setup 和卸载入口的哈希／签名，不含外部产物路径或 ZIP 自引用哈希；内层 SHA256SUMS 仅校验实际存在的 Setup、卸载入口。GitHub 平面清单校验独立 Setup、ZIP 及解压后的两个入口。

保持运行目录 360 MiB、ASAR 40 MiB、Setup 180 MiB、ZIP 155 MiB 门槛。移除此前为重复运行目录放宽到 300 MiB 的 ZIP 预算。Setup 使用最大压缩且不生成增量更新包。

管线先验证完整 runtime、fuses、签章、EXE/ASAR 哈希及 packaged smoke，再使用同一运行目录生成 Setup；Setup 生成前后验证 EXE/ASAR 字节不变，解压 ZIP 回验 Setup、卸载入口及签章。全部通过才原子替换 release；失败保留 staging，旧 release 不变。成功后只清理上一成功构建的受限 artifact 目录。CI 交付精简 ZIP，另一个小型 artifact 供发布 Setup 与外层 metadata，不上传开发运行目录。

顶层 uninstall.exe 是卸载入口，会查找当前用户已注册的安装并交给该安装的真正卸载器；不会把下载目录当作安装位置。卸载保留资料，可明确选择清除文库、设置与凭证并再次确认。下载及解压目录本身需要用户自行删除。用户步骤见 [Windows 安装指南](WINDOWS_INSTALLATION_ZH.md)。

## 统一包验收（2026-10-02）

前次包含重复 program 的统一 ZIP **244.86 MiB**；当前精简 ZIP **94.08 MiB**，减少约 **61.58%**，也低于旧版约 200 MB 的下载包。Setup **93.99 MiB**，独立卸载入口约 **103 KiB**。最终构建、封装审计、fuses 和 packaged smoke 通过，schema／事务／体积策略的 24 项聚焦测试通过。安装后的完整运行目录体积没有变化；削减来自移除下载内容中的第二份程序。

`pnpm desktop:test:release-download` 从本机 HTTP 下载最终 ZIP，验证整包及 Setup／卸载入口哈希，完整解压后实际删除下载文件与解压目录。Setup 内程序由封装审计和隔离安装回验 EXE／ASAR 哈希。CI 已加入此步骤；它验证本机 HTTP 传输，公开 GitHub 资产下载另由 publish job 在发布草稿阶段验收。正式 tag 的可信签章门禁与逐 tag 例外见下文。

实际安装／删除使用独立 GUID、独立 Unicode 和空格 Temp 路径及相同 installer.nsh，从与最终包完全相同的 EXE／ASAR 安装并通过 Core smoke，再由独立 GUID 编译的同一卸载入口 `/S` 调用实际 NSIS 卸载器，确认程序与测试登记移除。使用者原有安装、登记与 SQLite 哈希保持不变，所有测试安装已清理。`pnpm desktop:test:release-download:install` 可重跑此隔离场景，不执行正式入口对日常安装的卸载。可选清理文库继续由临时 SQLite 文库测试覆盖，不以静默卸载验收冒充交互式清理 UI 验收。

证据位于 `desktop/test-artifacts/release-download-acceptance.json` 和 `isolated-launcher-acceptance.json`。

## GitHub 正式发布

### CI 调度与验收证据

日常检查只在 master push、PR 和手动入口执行；功能分支更新由 PR 合并结果验证，避免相同提交同时跑 push 与 PR。保留必需检查 `build`，不对整个工作流增加路径过滤，文档 PR 也会产生有效检查。未开 PR 的分支需要验证时使用手动入口。

完整验证仍使用一个 build 和三个 E2E runner。完整单元／UI／发布脚本回归与覆盖率移到耗时最短的第 1 分片，先回归再构建 bundle／跑 E2E；build 显式安装 Electron，不再等待覆盖率才打包。`publish.needs: [build, e2e]` 保证覆盖率、任一分片或安装验收失败均不能发布。测试范围、覆盖率阈值、单 worker、签章与哈希门禁不变；构建、产物格式及失败恢复语义不变，恢复旧调度只需还原工作流与对应文档，不涉及数据迁移。

调度依据为 [完整验证 run 39232319096](https://github.com/Kumiko-kmk/Copilotix/actions/runs/39232319096)：build 657 秒，其中覆盖率 165 秒、打包 163 秒、下载／隔离安装验收 168 秒；三个 E2E job 分别 175、244、313 秒。覆盖率与第 1 片顺序执行预计约 340 秒，build 关键路径预计约 496 秒，整轮约 8–9 分钟（原约 11 分钟）。这是按既有步骤耗时的估算，须在改动后的 Windows 完整验证实测，不能当作本轮通过记录；后续重分片时需把覆盖率耗时一并考虑。


清理后源码 E2E 共 34 个（5／16／13），另有 build 中的 packaged smoke；原凭据接口用例已合并到每次执行的启动 smoke，三个小型单元套件并入现有套件，行为断言保留。

build 报告保存于 `Copilotix-Windows-verification-reports`，含 Playwright HTML 与 `test-artifacts` 的安装证据；完整回归 JUnit／覆盖率摘要改存 `Copilotix-Windows-e2e-reports-1`，各分片保存各自 Playwright HTML／失败证据，保留 7 天。不可只看 build 绿灯就声称完整验收通过。

### 托管虚拟机与流程检查边界

2026-10-20 检查 master `5f2b3bcf`：只有一份 Windows 工作流，过量执行主要来自分支 push 与 PR 重复触发。已有分片优化 [PR #12](https://github.com/Kumiko-kmk/Copilotix/pull/12) 已将串行完整验证约 22 分钟缩短至约 11 分钟；本节调度调整继续移除关键路径上的串行等待。

虚拟机失败不能统一归为 CPU／内存不足。历史 [run 39210754487](https://github.com/Kumiko-kmk/Copilotix/actions/runs/39210754487) 覆盖率与打包成功，文库导航在 300 秒预算内仍超时；修正动画步长并对软件渲染使用减少动态效果后，[run 39213831827](https://github.com/Kumiko-kmk/Copilotix/actions/runs/39213831827) 与上述分片完整验证成功。现有证据支持 WebGL 软件光栅化／交互时序问题，未发现可据此确认的 OOM。减少动态效果、就绪状态等待和无 WebGL 搜索进入 Reader 的回退能恢复功能性验证，不能证明硬件帧率或完整动画；后者需要可交互桌面与真实 GPU 的隔离 Windows runner 或本机验收。仅增加 CPU／内存不能保证解决 GPU 缺失，不应通过全局重试或放宽断言掩盖问题。

已确认：master 受保护且要求 `build`，tag 发布等待全部 build／e2e，签章例外按精确 tag 限定，发布前校验远端资产与哈希。[1.2.0 tag run](https://github.com/Kumiko-kmk/Copilotix/actions/runs/39223546750) 成功后才公开 Release，资产仅含 `setup.exe`。普通 PR 的快速检查不包含完整 UI 与覆盖率，这是分层验证边界；发布前须按同一提交完整验收。覆盖率阈值按 `vitest.config.ts` 的 include／exclude 范围计量，不含 renderer／preload／utility，不能用摘要百分比代表整个仓库覆盖率。E2E 的 3 项 opt-in 跳过覆盖本机 Codex、真实 PDF／布局场景；凭据接口检查已并入每次执行的启动 smoke，不能宣称已覆盖真实付费服务。

尚待维护者核实：完整 branch protection API 返回 integration 403，只能确认分支摘要中的 `build` 要求，无法确认审阅人数、管理员绕过等设置；PR #12 未见 review 记录。多数 E2E 的共享辅助函数在测试模式加 `--no-sandbox`，论文问答用例直接启动 Electron 保留沙箱，packaged smoke 也独立验证发行硬化；多数界面 E2E 因此不能用作生产 OS 沙箱的验收证明。现有 Actions 以可变版本 tag 引用，日志还提示 v4 的 Node 20 action runtime 已由平台强制切至 Node 24，后续应审阅并固定兼容版本的提交 SHA。发布后移除未签章例外变量的操作无法通过当前连接确认。

### 版本、签章与公开发布

各版本的简体中文发布说明保存为 `docs/releases/<版本>.zh-CN.md`，首行为 Release 标题。发布 job 从对应文件创建草稿，不追加英文自动生成摘要；内容沿用现有简体中文与分节风格，说明版本更新、下载与安装、服务配置、升级及数据保留。说明和版本号必须与发布 tag 对应，缺少说明时停止发布。

首次 `desktop-v1.0.0` 的未签章例外要求仓库 Actions variable `COPILOTIX_UNSIGNED_BOOTSTRAP_RELEASE` 精确等于 `desktop-v1.0.0`。2026-10-07，维护者另行明确授权 **仅本次 `desktop-v1.1.0` 未签章发布**；此例外要求 `COPILOTIX_UNSIGNED_RELEASE_TAG` 精确等于 `desktop-v1.1.0`，工作流也严格限制相同 tag，其他 tag 或变量值不能启用例外。Release 说明醒目标注未签章。完整构建、安装／卸载、下载删除、资产数量和远端哈希校验照常执行。对应发布完成后移除变量，后续版本继续要求受信任签章，不以自签证书代替。

2026-10-18，维护者明确授权 **仅本次 `desktop-v1.2.0` 未签章发布**。沿用上述逐 tag 约束，只有 tag 与 `COPILOTIX_UNSIGNED_RELEASE_TAG` 同为 `desktop-v1.2.0` 才能启用；版本说明标注未签章，全部 CI 与完整性检查保留，发布后移除变量。此授权不延续到后续版本。

2026-10-27，维护者明确授权 **仅本次 `desktop-v1.3.0` 未签名发布**。只有 tag 与 `COPILOTIX_UNSIGNED_RELEASE_TAG` 同为 `desktop-v1.3.0` 才启用；发布说明明确标注，完整回归、打包、隔离安装与远端资产哈希检查保留。任一门禁失败保留未发布状态，修复后重新验证，不改变文库或安装器格式；成功公开后移除变量。后续版本不继承本次授权。

托管 Windows runner 无 GPU，文库 3D 场景（约 260 万三角形）以软件光栅化运行在 1–3 fps，展开档案单帧可超过 10 秒。2026-10-19 维护者同意：文库导航 E2E（`paper-archive.spec.ts`）检测到软件渲染器时改用减少动态效果运行，断言共用；只有抽出中再按 Enter、收回期间 inert 与收回中重开这几步依赖动画，仅在有 GPU 时验证；软件渲染下逐秒帧率采样改为要求导航与拖拽期间确有场景渲染（硬件仍要求 30 fps，三角形与帧率上限不变）。单用例预算保持 180 秒。1.2.0 的点击卡死已由动画步长修正（见 [文库渲染契约](UI_PREFERENCES_ZH.md#文庫頁與-ai-解讀)）；完整动画在 CI 上不再覆盖，有 GPU 的真实帧率与动画以本机与真人验收为准。

正式发布 tag 必须严格等于 `desktop-v<desktop/package.json version>`，例如 package version 为 `1.0.0` 时只能推送 `desktop-v1.0.0`。CI 会先核对 tag 与包版本，再构建并验证 Electron fuses、签名、运行包和哈希。

当前实现只直接接入文件式证书；以下 Secrets 仅适用于已有适用 PFX/P12 的情况。新购公开受信任证书通常使用 Token/HSM/云签名，需按所选服务改造预检查和签名步骤，详见 [许可证选择与签名配置](LICENSE_AND_SIGNING_ZH.md)。

文件式证书路径需要以下 Actions secrets：

- `WIN_CSC_LINK`：Windows `.pfx` / `.p12` 证书路径或 Base64 内容。
- `WIN_CSC_KEY_PASSWORD`：证书密码；若证书不需要密码，可留空。

正式 tag 构建若缺少证书，CI 会在打包前失败；electron-builder 也启用 `forceCodeSigning`。构建后使用 Windows Authenticode 检查主程序、Setup 和独立卸载入口，要求签名状态为 `Valid`，并再次检查待发布 ZIP 内的 EXE。验证出的签名主体分别写入 release manifest 的 runtime、installer 和 uninstaller。此配置不代为采购证书。

Electron fuses 在 electron-builder `afterPack` 阶段写入并读回校验，该阶段发生在代码签名之前。Setup 由已验证的运行目录封装，不能替代 ASAR、原生依赖、许可或 packaged smoke 检查。正式发布 job 仅有 `contents: write`，build job 仅有 `contents: read`。发布 job 创建 draft，只上传 Windows x64 `setup.exe`；核对远端 draft 仅含这一项上传资产，再下载与内部 manifest 比对 SHA-256，并按签章政策验证 Setup 后才发布。GitHub 的源代码 ZIP／tar.gz 不计入上传资产。任何构建、签名、上传或资产检查失败都会保留 draft 或阻止发布。

## 安装生命周期验收

自动化检查至少包括发布策略、缺失或重复资产拒绝、Setup 体积与哈希、NSIS 配置、运行时目录保护，以及 typecheck、lint、单元测试、完整打包和 Electron E2E。

完整打包后运行 `pnpm desktop:test:installer`。此 Windows 生命周期脚本使用临时安装位置，验证静默首次安装、覆盖升级、卸载保留数据、重装和运行文件。它在当前用户目录添加唯一的测试标记，并在系统凭据存储添加唯一的测试账号；原数据库只读校验哈希，既有 API 账号不被修改。测试结束删除自己的标记和凭据。预检查发现已有 Copilotix 安装、快捷方式或运行实例会拒绝操作。CI 在打包和 E2E 后运行同一脚本。不要在自己的日常 Copilotix 安装上绕过预检查。

原生安装／卸载界面须针对当前构建在隔离目录验收，不能沿用旧版本的通过记录或覆盖本机日常安装。资料保护与待验收边界统一按本节及 [安装指南](WINDOWS_INSTALLATION_ZH.md) 维护。正式发布仍需受信任签章；安装器验证不代表真实服务账号的网络调用已通过。

## 发布许可决策

2026-09-28，维护者选择 MIT。根 LICENSE.md 与两个 package.json 均声明 MIT，版权主体沿用项目作者 Kumiko-kmk。旧 Python 引擎及其专用 CI 已移除；历史版本许可不变。运行包包含 resources/licenses/Copilotix-MIT.txt 和第三方说明，并保留 Electron 自带声明。

许可门禁可通过；正式发布仍需有效且受信任的代码签名证书。本地开发构建不要求证书。自签测试证书不能代替公开受信任证书。

### 安装器维护边界

- appId、四个 bundle、单实例与 userData 路径保持兼容；更改安装位置不能替代文库迁移。
- 发现应用运行时提示正常退出，不强杀后台任务；覆盖升级和静默卸载不清理个人资料。只有向导明确选择清理并经 Main 第二次原生确认，Utility 才按已登记的文献和固定 userData 边界清理；目录 junction、路径漂移或确认 token 不符时拒绝操作，保护原始 PDF、外部备份和共享文件。
- 新增凭据、native 依赖、资源或存储格式时同步更新打包／卸载清单和验证。退出、备份与文库维护前等待聊天取消和落盘；完整迁移文献目录中的 chat 文件。数据库迁移的快照、校验和与回滚约束不变。
- 人工安装验收使用独立 GUID 和隔离目录，检查中文／空格路径、快捷方式、运行中保护与取消；不覆盖日常安装，不用单元测试代替原生 wizard 验收。自动更新、MSIX／Store 与跨平台安装器仍未接入。

## 契約（2026-10-26 自 AGENTS.md 遷入）

### 1. 本地 Windows 構建與交付

使用 Node **24.19.0**、根 `packageManager` 指定的 pnpm **11.19.0**。系統 Node 24.11.1 曾靜默崩潰並留下舊 out；不要使用。Codex fallback pnpm 版本可能不符，可用正確 Node 執行 Corepack 快取的 `11.19.0/bin/pnpm.mjs`，不得偽造 user-agent。

在倉庫根目錄執行：

```powershell
pnpm install                       # 新 worktree 或依賴／lockfile 改變時
pnpm desktop:build:bundles          # 源碼改動後重建 Main、Preload、Renderer、Utility
pnpm desktop:release:from-built     # 僅明確要求打包時執行；使用新 out，不與 desktop:release 並行
```

僅源碼與 `desktop/out/` 均未變更時，才可省略 build。打包內建的 ASAR、資源、fuses、體積、雜湊與 packaged smoke 校驗不可移除；成功後原子更新發布目錄，失敗保留 `.release-next-*` 供排查。

Electron 下載不可用時，可在本次 PowerShell 設 `$env:COPILOTIX_USE_INSTALLED_ELECTRON='1'` 再打包；只複製本 worktree 已安裝、版本與發行要求一致的 Electron `dist`，不修改依賴來源。預設下載路徑及所有打包門禁不變，版本不符仍失敗並保留 staging。使用後清除此環境變數。回歸入口：`releasePolicy.test.mjs`、`releaseTransaction.test.mjs`。

- 人工測試入口：`release-artifacts/<build-id>/program/Copilotix.exe`，不可單獨搬走 EXE；同目錄 DLL、PAK、resources 均必需。
- 交付包：`release-artifacts/<build-id>/Copilotix-<version>-win-x64.zip`，Setup 規則見第 6 節。
- Runtime 上限 **360 MiB**，Electron 約占 330 MiB；2026-10-22 起依使用者要求暫列 `ADVISORY_RELEASE_LIMITS`（`release-policy.mjs`），超出只警告不失敗，app.asar／ZIP／Setup 上限仍為硬門禁，恢復時從清單移除即可。Renderer-only 套件放 `devDependencies`；Main 純 JS 優先由 electron-vite externalize `exclude` 打入 bundle；原生或刻意外部化套件才留 `dependencies`。

### 5. 許可與簽名

- 自有代碼沿用根 `LICENSE.md` 的 MIT，不覆蓋第三方或歷史上游許可。
- 打包生成第三方許可匯總（包括開發依賴），並複製 MIT 與聲明到 `resources/licenses`；缺少許可文本須如實列出。
- 本機自簽僅供測試，不自動加入系統信任。正式政策與 SignPath 見 `docs/CODE_SIGNING_POLICY.md`、`docs/LICENSE_AND_SIGNING_ZH.md`。

### 6. Setup 交付契約

- 從 1.2.0 起，公開 Release 僅上傳 `setup.exe`，源碼由 GitHub 按 tag 提供 ZIP／tar.gz；不發布運行包 ZIP、SHA 或 manifest。下列緊湊 ZIP 與雜湊清單只作本地／CI 內部校驗，不刪除打包安全檢查。

- ZIP 為 compact-setup：根目錄含 Setup、`uninstall.exe`、安裝說明及小型 advanced 校驗文件；runtime 嵌入 Setup，不在 ZIP 重複放置，開發副本留在 `release-artifacts/<build-id>/program/`。
- schema 5：distribution 為 compact-setup，`runtime.embeddedIn` 標記內嵌；外層 `runtimeArtifactDirectory` 指向開發副本，`artifactDirectory` 指向 ZIP 目錄。ZIP 內 bundle-manifest 不含外部產物路徑或自身哈希；外層 release-manifest 在 ZIP 完成後加入 `transport.sha256`，不進 ZIP。成功只清理上一成功版本已驗證的產物路徑，失敗暫存保留。
- 強制目前使用者安裝，允許選位置。安裝／卸載發現應用運行時提示退出，不強制結束背景隊列。
- 卸載預設保留資料、憑據與獨立文庫；只有明確勾選清除、Main 第二次原生確認後，獨立 Utility 才按唯讀清單驗證並安全清理。覆蓋升級／靜默卸載不得清資料；新增憑據或儲存結構須同步卸載清單與路徑驗證。
- 安裝精靈視覺：`scripts/generate-installer-assets.ps1` 生成字陣風格的 sidebar（164×314）與內頁 header（150×57）BMP；完成頁有專案主頁連結。頁面順序、控件 ID 與歡迎／選項／完成頁文案不變（wizard 測試依賴）。
- Setup、主程式、內嵌卸載器均受正式簽章門禁。必要驗收入口：`pnpm desktop:test:installer:wizard`、`pnpm desktop:test:installer`；腳本拒絕覆蓋既有安裝。
