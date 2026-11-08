<div align="center">

# Copilotix

**读论文，也读懂论文。**

PDF · 中英对照 · 文献档案 · AI 问答

[下载完整版](https://github.com/Kumiko-kmk/Copilotix/releases/tag/desktop-v1.3.0) · [Lite 版](#copilotix-lite) · [使用指南](https://github.com/Kumiko-kmk/Copilotix/wiki) · [反馈](https://github.com/Kumiko-kmk/Copilotix/issues)

Windows x64 · Electron / React · 本地文库 · MIT

</div>

![完整版文库浏览](docs/images/demos/2-library-browse.gif)

Copilotix 把论文的解析、翻译、整理和问答放在同一个桌面工作台里。导入 PDF，打开原文与中文对照，把重要段落留下来，带着选区继续提问；回到文库时，论文以档案的形式排开。

本页介绍仓库中的**完整版**。当前已发布完整版为 **1.3.0**；源码中的后续改进以对应版本发布说明为准。动图由实际运行录制于 2026-10-19，展示完整版的首页、文库与档案交互。

## 从文库走进论文

按内容分类浏览论文，检索标题，展开档案查看摘要、研究背景、结论与讨论。封面、图组和结构化内容一起呈现，选中论文后直接进入阅读。

![完整版档案展开：封面与论文摘要](docs/images/demos/3-archive-detail.gif)

## 一张桌面，四种阅读方式

PDF、原文、中文与问答可以自由拆分和分组。把原文放在译文旁边，或让问题留在阅读区一侧；按内容块定位，随时返回对应的论文位置。

- **对照阅读**：PDF 缩放、页码跳转、视图同步与布局恢复。
- **保留内容结构**：公式、合并表格、多子图与图说按解析结果呈现。
- **阅读即整理**：高亮、下划线、笔记；双击编辑正文，段落删除、恢复和拖曳排序。
- **引用随手查**：悬停正文参考文献标号查看条目，移入卡片继续阅读，点击复制编号后的文字。
- **带走结果**：导出 Markdown 与图片，或打包结果 ZIP。

<details>
<summary>看看完整版的首页</summary>

![完整版首页与导入入口](docs/images/demos/1-home-cipher.gif)

</details>

## 带着上下文提问

把选区、整段文字或图片加入问答，围绕当前论文继续追问。回答中的可定位引用可以带你返回原文；对话、草稿与所选模型按论文保存。

在线模型支持 Qwen / 千问、DeepSeek，也可以连接本机已登录的 Codex。各功能共享连接管理与凭据。具体模型和可用能力以应用设置与账号返回结果为准。

完整版还提供论文档案生成、图片解读和 [Zotero 连接](docs/ZOTERO_BRIDGE_ZH.md)。AI 结果用于辅助理解，重要结论仍应对照论文核实。

<a id="copilotix-lite"></a>

## Copilotix Lite

Lite 保留阅读核心，以列表侧栏取代完整档案场景，适合希望直接打开论文的用户。

| | 完整版 | Lite 1.0 |
|---|---|---|
| 文献入口 | 可视化文库、档案展开 | 侧栏、标题搜索、置顶与分类 |
| PDF / 原文 / 中文 / 问答 | 支持 | 支持 |
| 档案场景与首页特效 | 支持 | 不包含 |
| 同时阅读 | 工作台内四视图 | 四视图、双论文分屏、独立窗口 |
| 设置 | 多密钥与模型配置 | 服务、存储、外观三个页面 |
| 安装与数据 | 独立 | 独立，可与完整版并存 |

[Lite 发布说明](docs/releases/lite/1.0.0.zh-CN.md) · [下载列表](https://github.com/Kumiko-kmk/Copilotix/releases)

两版不自动共用文库和 API Key；可通过数据导出／导入迁移论文，密钥需分别配置。Lite 继续使用 Electron，不承诺未经测量的内存或速度改善。

## 开始使用

1. 从对应的 [GitHub Release](https://github.com/Kumiko-kmk/Copilotix/releases) 下载 `setup.exe`，按向导安装。
2. 在设置中配置 MinerU Token，以及准备使用的模型服务或本机 Codex，保存更改。
3. 选择或拖入 PDF，等待解析后开始对照阅读；翻译与问答使用已启用的服务。

程序不附带 API Key，也不需要安装 Python 或 CUDA。解析需要网络；服务费用、额度和可用地域由相应供应商决定。安装包的签章状态见对应 Release。

[第一篇论文](https://github.com/Kumiko-kmk/Copilotix/wiki/First-Paper) · [服务配置](https://github.com/Kumiko-kmk/Copilotix/wiki/Service-Setup) · [阅读工作台](https://github.com/Kumiko-kmk/Copilotix/wiki/Reader-Workbench) · [安装与升级](docs/WINDOWS_INSTALLATION_ZH.md)

## 资料保存在哪里

PDF、解析正文、译文、图片和用户编辑保存在本地文献目录；聊天与草稿跟随论文保存。API Key 放在 Windows 系统凭据存储中，不写入文库备份。

使用在线服务时，解析会向 MinerU 发送 PDF；翻译、问答、档案生成和图片解读会向实际启用的模型发送所需内容。**本地保存不等于离线处理。** 分享结果 ZIP 或备份前，请检查其中的聊天、笔记和文献内容。

文库支持备份、恢复与迁移；卸载默认保留个人资料。详见 [本地数据与导出](https://github.com/Kumiko-kmk/Copilotix/wiki/Local-Data-and-Export) 和 [文库管理](docs/LIBRARY_MANAGEMENT_ZH.md)。

## 项目结构

![Copilotix 概念架构](docs/images/architecture-illustration-v2.png)

*架构概念插图，由图像模型生成；界面展示使用上方真实录屏。*

React 负责阅读界面，Electron Main 管理窗口、受控访问与功能调度，独立 Utility 承担文档模型、SQLite 和计算任务。统一文档模型连接阅读、编辑、翻译与导出，共享模型层管理供应商连接和调用。

```text
desktop/src/
├── app/        进程入口与应用组装
├── features/   文档、阅读、文库、解析、翻译、问答、设置
└── platform/   数据库、模型连接、IPC、资源与系统能力
```

开发使用 **Node.js 24.19.0** 与 **pnpm 11.19.0**：

```powershell
pnpm install --frozen-lockfile
pnpm desktop:dev
pnpm --dir desktop dev:lite
```

[架构与边界](docs/ARCHITECTURE_ZH.md) · [开发与测试](docs/DESKTOP_DEVELOPMENT_ZH.md) · [发布流程](docs/DESKTOP_RELEASE_ZH.md) · [贡献入口](AGENTS.md)

## 许可与致谢

自有代码采用 [MIT](LICENSE.md)。感谢 MinerU、Electron、React、PDF.js、KaTeX 等开源项目；依赖与服务保留各自条款，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。论文演示中的内容归原作者所有。

安全问题请按 [Security Policy](docs/SECURITY.md) 报告。
