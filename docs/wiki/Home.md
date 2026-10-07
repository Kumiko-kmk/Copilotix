# Copilotix 使用指南

**适用版本：1.1.0 · Windows x64**

Copilotix 将 PDF 解析、中文翻译、原文对照与论文 AI 问答放进同一个桌面阅读工作台。文献产物和对话保存在本地；解析、翻译和问答按实际配置调用在线服务。

[下载 1.1.0](https://github.com/Kumiko-kmk/Copilotix/releases/tag/desktop-v1.1.0) · [完整更新说明](https://github.com/Kumiko-kmk/Copilotix/blob/master/docs/releases/1.1.0.zh-CN.md) · [仓库 README](https://github.com/Kumiko-kmk/Copilotix#readme)

![1.1.0 实际运行：PDF 与中文 Markdown 对照](https://raw.githubusercontent.com/Kumiko-kmk/Copilotix/master/docs/images/screenshots/reader-1.1.0.png)

*独立示例文库中的《Attention Is All You Need》。这是实际运行截图；译文展示阅读功能，阅读时仍需核对原文。*

## 从这里开始

1. [下载安装](https://github.com/Kumiko-kmk/Copilotix/wiki/Installation-and-Upgrade)：下载、校验、安装与覆盖升级。
2. [配置服务](https://github.com/Kumiko-kmk/Copilotix/wiki/Service-Setup)：MinerU Token、翻译来源及问答凭据。
3. [处理第一篇论文](https://github.com/Kumiko-kmk/Copilotix/wiki/First-Paper)：导入、任务进度、阅读、标注与导出。

## 1.1.0 的阅读方式

| 你想做什么 | 指南 |
| --- | --- |
| 同时查看 PDF、原文和中文；拖动、拆分与最大化视图 | [阅读工作台](https://github.com/Kumiko-kmk/Copilotix/wiki/Reader-Workbench) |
| 向当前文献提问，加入选区并查看引用；重开后继续对话 | [论文 AI 问答](https://github.com/Kumiko-kmk/Copilotix/wiki/Paper-AI-Chat) |
| 查找本地文件、导出 Markdown／ZIP、备份和迁移文库 | [本地资料与导出](https://github.com/Kumiko-kmk/Copilotix/wiki/Local-Data-and-Export) |
| 排查凭据、任务、聊天恢复、布局或图片问题 | [常见问题](https://github.com/Kumiko-kmk/Copilotix/wiki/FAQ) |

新版提供 PDF、原文、中文、AI 问答四个视图。JSON 页面已移除，版面文件仍作为定位与导出的底层资料保留。PDF 去掉额外外框、右侧／底部和页间留白，调整宽度或缩放时保留页码与页内位置；正文排版也更紧凑。

问答支持 Qwen 和 DeepSeek 的内置模型，使用「服务连接」中相应凭据，独立于翻译模型选择。每篇文献的回答、草稿、选区与模型保存在对应 `chat/` 目录，重新打开恢复。

## 使用前了解

- 正式导入格式为 **PDF**，Markdown 是解析、翻译和导出产物。
- 程序不提供第三方 API Key。解析上传 PDF 到 MinerU；翻译向实际来源发送文本；问答首次发送前说明所选服务和数据范围。
- **1.1.0 为维护者授权的未签章发布**，请从本仓库 Release 下载并核对 SHA-256；此例外不改变后续正式签章要求。
- 结果 ZIP 包含已有聊天文件；分享前检查对话、草稿及选区。完整文库备份不含系统 API 凭据。

技术与维护说明见 [工程文档索引](https://github.com/Kumiko-kmk/Copilotix/blob/master/docs/README.md)。Wiki 的版本化源文件见 [docs/wiki](https://github.com/Kumiko-kmk/Copilotix/tree/master/docs/wiki)。
