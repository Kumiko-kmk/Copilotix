# MinerU 桌面翻译版

这是基于 MinerU 开源解析引擎构建的非官方个人桌面客户端。它不包含本地解析模型，而是连接 MinerU 官方精确解析 API，在解析完成后自动生成简体中文 Markdown。

## 开发环境

- Windows 10/11 x64
- Node.js 24.11.1
- pnpm 11.19.0
- MinerU 官方 API Token（在 [MinerU API 管理](https://mineru.net/apiManage) 获取）

```powershell
pnpm install
pnpm desktop:dev
```

首次安装依赖时，pnpm 可能要求批准 Electron、esbuild 和 electron-winstaller 的构建脚本。不要批准清单之外的未知脚本。

## 测试与构建

```powershell
pnpm desktop:typecheck
pnpm desktop:test
pnpm desktop:build
pnpm desktop:dist
pnpm desktop:test:e2e
```

最终文件位于 `desktop/dist/`：

- `MinerU-<版本>-x64-setup.exe`：可选择安装目录的 NSIS 安装器
- `MinerU-<版本>-x64-portable.exe`：便携版

程序没有代码签名，Windows SmartScreen 可能显示未知发布者。安装前请先卸载官方客户端；自制版使用独立的 `%APPDATA%\MinerU-Translation` 数据目录，不会主动删除官方解析结果。

## 配置

1. 在“设置 → 系统设置”填写必需的 MinerU 官方 API Token，然后点击“验证 Token”。API 地址固定为 `https://mineru.net`。
2. 设置结果保存目录。
3. 在“参数设置”选择解析模型和翻译源。千问、DeepSeek API Key 写入 Windows Credential Manager，不会保存到 SQLite 或前端。
4. Bing 与腾讯 TranSmart 使用非官方网页接口，可能限流、变化或失效；客户端会重试并按配置回退。

## 隐私与安全

- PDF 会通过官方预签名上传地址发送到 MinerU 服务。
- 待翻译文本会发送到选定翻译服务；备用策略可能使同一文档使用多个服务。
- Token 只发送到固定的 `https://mineru.net/api/v4` 接口；预签名上传及结果下载请求不携带 Token。
- 日志、任务数据库和渲染进程不保存或返回 API Key。

本客户端为非官方个人改编，MinerU 名称、图标和解析引擎归其原项目所有。继续遵守仓库中的 AGPL-3.0 授权、CLA 与上游署名要求。
