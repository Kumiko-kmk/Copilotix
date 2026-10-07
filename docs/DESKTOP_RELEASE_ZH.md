# Windows 桌面发布

## 本地开发包

本地人工测试可生成未签名的精简 Release 包：

```powershell
pnpm desktop:build:bundles
pnpm desktop:release:from-built
```

默认为 `COPILOTIX_RELEASE_MODE=development`。`pnpm desktop:release` 会先完整 build 再执行同一流程。公开下载主入口是单个 `Copilotix-<version>-win-x64.zip`，解压后先运行 Setup；完整布局如下：

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

当前版本为 **1.0.0**，安装入口固定为 `setup.exe`；版本仍写入 ZIP 名、程序和安装登记。安装目录页后提供默认勾选的“创建桌面图标”，可自行取消。以下体积记录来自前次 0.1.0 构建，重新打包后的实际数值以最终 manifest 为准。

manifest schema 5 标记 `distribution: compact-setup` 和 `runtime.embeddedIn`。外层 `artifactDirectory` 定位 ZIP 所在目录，`runtimeArtifactDirectory` 定位开发运行副本。runtime EXE/ASAR 哈希描述 Setup 内已验证的程序，不表示 ZIP 中存在独立 program。内层 bundle-manifest 保存程序、Setup 和卸载入口的哈希／签名，不含外部产物路径或 ZIP 自引用哈希；内层 SHA256SUMS 仅校验实际存在的 Setup、卸载入口。GitHub 平面清单校验独立 Setup、ZIP 及解压后的两个入口。

保持运行目录 360 MiB、ASAR 40 MiB、Setup 180 MiB、ZIP 155 MiB 门槛。移除此前为重复运行目录放宽到 300 MiB 的 ZIP 预算。Setup 使用最大压缩且不生成增量更新包。

管线先验证完整 runtime、fuses、签章、EXE/ASAR 哈希及 packaged smoke，再使用同一运行目录生成 Setup；Setup 生成前后验证 EXE/ASAR 字节不变，解压 ZIP 回验 Setup、卸载入口及签章。全部通过才原子替换 release；失败保留 staging，旧 release 不变。成功后只清理上一成功构建的受限 artifact 目录。CI 交付精简 ZIP，另一个小型 artifact 供发布 Setup 与外层 metadata，不上传开发运行目录。

顶层 uninstall.exe 是卸载入口，会查找当前用户已注册的安装并交给该安装的真正卸载器；不会把下载目录当作安装位置。卸载保留资料，可明确选择清除文库、设置与凭证并再次确认。下载及解压目录本身需要用户自行删除。用户步骤见 [Windows 安装指南](WINDOWS_INSTALLATION_ZH.md)。

## 统一包验收（2026-10-02）

前次包含重复 program 的统一 ZIP **244.86 MiB**；当前精简 ZIP **94.08 MiB**，减少约 **61.58%**，也低于旧版约 200 MB 的下载包。Setup **93.99 MiB**，独立卸载入口约 **103 KiB**。最终构建、封装审计、fuses 和 packaged smoke 通过，schema／事务／体积策略的 24 项聚焦测试通过。安装后的完整运行目录体积没有变化；削减来自移除下载内容中的第二份程序。

`pnpm desktop:test:release-download` 从本机 HTTP 下载最终 ZIP，验证整包及 Setup／卸载入口哈希，完整解压后实际删除下载文件与解压目录。Setup 内程序由封装审计和隔离安装回验 EXE／ASAR 哈希。CI 已加入此步骤。公开 GitHub 下载尚未执行，当前为未签名开发包；正式 tag 的可信签章门禁保留。

实际安装／删除使用独立 GUID、独立 Unicode 和空格 Temp 路径及相同 installer.nsh，从与最终包完全相同的 EXE／ASAR 安装并通过 Core smoke，再由独立 GUID 编译的同一卸载入口 `/S` 调用实际 NSIS 卸载器，确认程序与测试登记移除。使用者原有安装、登记与 SQLite 哈希保持不变，所有测试安装已清理。`pnpm desktop:test:release-download:install` 可重跑此隔离场景，不执行正式入口对日常安装的卸载。可选清理文库继续由临时 SQLite 文库测试覆盖，不以静默卸载验收冒充交互式清理 UI 验收。

证据位于 `desktop/test-artifacts/release-download-acceptance.json` 和 `isolated-launcher-acceptance.json`。

## GitHub 正式发布

各版本的简体中文发布说明保存为 `docs/releases/<版本>.zh-CN.md`，首行为 Release 标题。发布 job 从对应文件创建草稿，不追加英文自动生成摘要；内容应包括版本更新、下载与安装、服务配置、升级、数据保留、文件校验及实际验证范围。说明和版本号必须与发布 tag 对应，缺少说明时停止发布。

首次 `desktop-v1.0.0` 的未签章例外要求仓库 Actions variable `COPILOTIX_UNSIGNED_BOOTSTRAP_RELEASE` 精确等于 `desktop-v1.0.0`。2026-10-07，维护者另行明确授权 **仅本次 `desktop-v1.1.0` 未签章发布**；此例外要求 `COPILOTIX_UNSIGNED_RELEASE_TAG` 精确等于 `desktop-v1.1.0`，工作流也严格限制相同 tag，其他 tag 或变量值不能启用例外。Release 说明醒目标注未签章。完整构建、安装／卸载、下载删除、资产数量和远端哈希校验照常执行。对应发布完成后移除变量，后续版本继续要求受信任签章，不以自签证书代替。

正式发布 tag 必须严格等于 `desktop-v<desktop/package.json version>`，例如 package version 为 `1.0.0` 时只能推送 `desktop-v1.0.0`。CI 会先核对 tag 与包版本，再构建并验证 Electron fuses、签名、运行包和哈希。

当前实现只直接接入文件式证书；以下 Secrets 仅适用于已有适用 PFX/P12 的情况。新购公开受信任证书通常使用 Token/HSM/云签名，需按所选服务改造预检查和签名步骤，详见 [许可证选择与签名配置](LICENSE_AND_SIGNING_ZH.md)。

文件式证书路径需要以下 Actions secrets：

- `WIN_CSC_LINK`：Windows `.pfx` / `.p12` 证书路径或 Base64 内容。
- `WIN_CSC_KEY_PASSWORD`：证书密码；若证书不需要密码，可留空。

正式 tag 构建若缺少证书，CI 会在打包前失败；electron-builder 也启用 `forceCodeSigning`。构建后使用 Windows Authenticode 检查主程序、Setup 和独立卸载入口，要求签名状态为 `Valid`，并再次检查待发布 ZIP 内的 EXE。验证出的签名主体分别写入 release manifest 的 runtime、installer 和 uninstaller。此配置不代为采购证书。

Electron fuses 在 electron-builder `afterPack` 阶段写入并读回校验，该阶段发生在代码签名之前。Setup 由已验证的运行目录封装，不能替代 ASAR、原生依赖、许可或 packaged smoke 检查。正式发布 job 仅有 `contents: write`，build job 仅有 `contents: read`。发布 job 创建 draft，将 Windows x64 Setup、ZIP、`SHA256SUMS.txt` 和 `release-manifest.json` 全部上传，核对远端 draft 正好含有这四项资产，并下载逐个比对 SHA-256、再次验证 Setup 签名后才将 draft 发布。任何构建、签名、上传或资产检查失败都会保留 draft 或阻止发布。

## 安装生命周期验收

自动化检查至少包括发布策略、缺失或重复资产拒绝、Setup 体积与哈希、NSIS 配置、运行时目录保护，以及 typecheck、lint、单元测试、完整打包和 Electron E2E。

完整打包后运行 `pnpm desktop:test:installer`。此 Windows 生命周期脚本使用临时安装位置，验证静默首次安装、覆盖升级、卸载保留数据、重装和运行文件。它在当前用户目录添加唯一的测试标记，并在系统凭据存储添加唯一的测试账号；原数据库只读校验哈希，既有 API 账号不被修改。测试结束删除自己的标记和凭据。预检查发现已有 Copilotix 安装、快捷方式或运行实例会拒绝操作。CI 在打包和 E2E 后运行同一脚本。不要在自己的日常 Copilotix 安装上绕过预检查。

初版 Setup 已执行原生精灵、自定义中文与空格路径、快捷方式、覆盖安装、运行中保护、卸载保留数据与测试凭据及重装验收。2026-10-02 新增可选清理后，38 项针对性测试、完整构建／NSIS 编译／包内容检查通过，临时 SQLite 文库实际清理通过；本机已有日常安装，未覆盖或卸载，新卸载精灵的实际 UI 验收未完成。结果摘要见 [Setup 开发报告](SETUP_INSTALLER_DEVELOPMENT_PLAN_ZH.md#本輪完成結果)。正式发布仍需受信任签章；真实服务账号的网络调用不属于这次安装器验证。

## 发布许可决策

2026-09-28，维护者选择 MIT。根 LICENSE.md 与两个 package.json 均声明 MIT，版权主体沿用项目作者 Kumiko-kmk。旧 Python 引擎及其专用 CI 已移除；历史版本许可不变。运行包包含 resources/licenses/Copilotix-MIT.txt 和第三方说明，并保留 Electron 自带声明。

许可门禁可通过；正式发布仍需有效且受信任的代码签名证书。本地开发构建不要求证书。自签测试证书不能代替公开受信任证书。
