# 中文 Wiki 的版本化源文件

本目录与仓库 README 一起维护，对应 [GitHub Wiki](https://github.com/Kumiko-kmk/Copilotix/wiki)。指南以正式发布的 **1.1.0** 为基线；服务商当前模型权限和价格以官方说明为准。

| 文件 | 发布页面 |
| --- | --- |
| `Home.md` | 使用指南首页 |
| `Installation-and-Upgrade.md` | 安装、升级与卸载 |
| `Service-Setup.md` | 解析、翻译与问答服务 |
| `First-Paper.md` | 处理第一篇论文 |
| `Reader-Workbench.md` | 阅读工作台 |
| `Paper-AI-Chat.md` | 论文 AI 问答 |
| `Local-Data-and-Export.md` | 本地资料、导出与文库管理 |
| `FAQ.md` | 常见问题 |
| `_Sidebar.md`、`_Footer.md` | Wiki 导航 |

维护时先核对当前代码和实际运行，再修改本目录及 README；应用内截图存于 `docs/images/screenshots/`，采集范围见该目录的说明。示意图与实际截图须分别标注，问答入口截图不得作为付费模型回答质量的证据。

发布顺序：先让主仓库文档、图片通过最新合并检查并进入 `master`，再将本目录除 `README.md` 外的 Markdown 文件同步到独立 Wiki 仓库并提交。Wiki 图片使用主仓库的绝对地址，避免先发布页面产生失效图片。既有 `Home`、`First-Paper`、`Service-Setup`、`FAQ` 页面名称保持不变，外部链接继续有效。

Wiki 是独立 Git 仓库，主仓库提交不会自动更新 Wiki。两处发布后均需检查页面、导航与图片，并记录实际发布结果；未获用户授权时不推送任一仓库。
