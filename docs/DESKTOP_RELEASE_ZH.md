# Windows 桌面发布

## 本地开发包

本地人工测试仍可生成未签名的完整目录包：

```powershell
pnpm desktop:build:bundles
pnpm desktop:release:from-built
```

这条路径默认使用 `COPILOTIX_RELEASE_MODE=development`，不要求签名证书。生成的 ZIP 包含完整运行目录，不要只复制 `Copilotix.exe`。

## GitHub 正式发布

正式发布 tag 必须严格等于 `desktop-v<desktop/package.json version>`，例如 package version 为 `0.1.0` 时只能推送 `desktop-v0.1.0`。CI 会先核对 tag 与包版本，再构建并验证 Electron fuses、签名、运行包和哈希。

当前实现只直接接入文件式证书；以下 Secrets 仅适用于已有适用 PFX/P12 的情况。新购公开受信任证书通常使用 Token/HSM/云签名，需按所选服务改造预检查和签名步骤，详见 [许可证选择与签名配置](LICENSE_AND_SIGNING_ZH.md)。

文件式证书路径需要以下 Actions secrets：

- `WIN_CSC_LINK`：Windows `.pfx` / `.p12` 证书路径或 Base64 内容。
- `WIN_CSC_KEY_PASSWORD`：证书密码；若证书不需要密码，可留空。

正式 tag 构建若缺少证书，CI 会在打包前失败；electron-builder 也启用 `forceCodeSigning`。构建后使用 Windows Authenticode 检查主程序，要求签名状态为 `Valid`，并再次检查待发布 ZIP 内的 EXE。验证出的签名主体写入 release manifest。此配置不代为采购证书。

Electron fuses 在 electron-builder `afterPack` 阶段写入并读回校验，该阶段发生在代码签名之前。正式发布 job 仅有 `contents: write`，build job 仅有 `contents: read`。发布 job 创建 draft，将 Windows x64 ZIP、`SHA256SUMS.txt` 和 `release-manifest.json` 全部上传，核对远端 draft 正好含有这三项资产，并下载逐个比对 SHA-256 后才将 draft 发布。任何构建、签名、上传或资产检查失败都会保留 draft 或阻止发布。

## 发布许可决策

2026-09-28，维护者选择 MIT。根 LICENSE.md 与两个 package.json 均声明 MIT，版权主体沿用项目作者 Kumiko-kmk。旧 Python 引擎及其专用 CI 已移除；历史版本许可不变。运行包包含 resources/licenses/Copilotix-MIT.txt 和第三方说明，并保留 Electron 自带声明。

许可门禁可通过；正式发布仍需有效且受信任的代码签名证书。本地开发构建不要求证书。自签测试证书不能代替公开受信任证书。
