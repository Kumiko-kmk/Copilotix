# 安装、升级与卸载

**适用版本：1.1.0 · Windows x64**

## 下载与校验

从 [1.1.0 Release](https://github.com/Kumiko-kmk/Copilotix/releases/tag/desktop-v1.1.0) 下载以下任一种：

| 文件 | 用途 |
| --- | --- |
| `Copilotix-1.1.0-win-x64.zip` | 推荐交付包：Setup、卸载器、安装说明及校验资料 |
| `setup.exe` | 独立安装器，已内嵌完整程序，可直接安装 |
| `SHA256SUMS.txt` | 核对下载文件 SHA-256 |
| `release-manifest.json` | 查看发布产物清单 |

> **1.1.0 经维护者授权以未签章形式发布。** Windows 可能提示发布者未知；请确认来源是本仓库 Release，并核对校验文件。后续版本仍须遵守正式签章要求。

在下载目录打开 PowerShell，计算下载文件的哈希并与同页 `SHA256SUMS.txt` 对比：

```powershell
Get-FileHash .\setup.exe -Algorithm SHA256
Get-FileHash .\Copilotix-1.1.0-win-x64.zip -Algorithm SHA256
```

## 首次安装

1. 使用 ZIP 时先完整解压，再运行顶层 `setup.exe`；直接下载 Setup 则运行该文件。
2. 选择当前用户可写的安装位置，按需创建桌面快捷方式。
3. 完成安装后启动 Copilotix；桌面应用不需要 Python、CUDA 或本地解析模型。
4. 按[服务配置](https://github.com/Kumiko-kmk/Copilotix/wiki/Service-Setup)验证并保存凭据，再选择文献保存位置。

![Copilotix 1.1.0 实际首页](https://raw.githubusercontent.com/Kumiko-kmk/Copilotix/master/docs/images/screenshots/home-1.1.0.png)

*实际运行首页：选择／拖入 PDF、新手教程与继续阅读入口。*

安装目录放程序，文献保存位置放论文和处理产物，两者相互独立。程序目录提供 `uninstall.exe`。

## 覆盖升级

1. 等待解析、翻译及问答结束；需要时先[创建完整文库备份](https://github.com/Kumiko-kmk/Copilotix/wiki/Local-Data-and-Export)。
2. 从系统托盘退出 Copilotix。关闭主窗口可能仅隐藏到托盘。
3. 运行新版 Setup 完成覆盖安装。
4. 启动后检查文献、产物、聊天和设置；版本以「关于」或正式发布记录为准。

覆盖升级保留个人资料，不会因为安装到新位置而迁移旧文库。安装器检测程序仍运行时会提示退出，不应强制结束后台任务。

## 卸载与资料保留

卸载默认保留文献、应用数据及系统凭据，可供重装后继续使用。只有确实要清除个人资料时，才勾选清除选项并完成第二次原生确认。覆盖升级和静默卸载不会触发该清理。

如果电脑上还有需要保留的文献或聊天，先确认备份和文库路径，再选择清理。重装到同一电脑时已有凭据可能仍在系统存储；跨电脑恢复备份后需要重新配置凭据。

## 不要单独复制程序 EXE

源代码构建产生的 `program/Copilotix.exe` 依赖同目录的 DLL、PAK 和 `resources/`。需要直接运行开发副本时须保留完整 `program/`；正式下载的 ZIP 是安装交付包，Setup 已嵌入运行依赖。

详细安装契约见仓库的 [Windows 安装、升级与卸载](https://github.com/Kumiko-kmk/Copilotix/blob/master/docs/WINDOWS_INSTALLATION_ZH.md)。
