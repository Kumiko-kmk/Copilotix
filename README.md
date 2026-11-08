# Copilotix

<div align="center">

**读论文，也读懂论文。**

[下载完整版](https://github.com/Kumiko-kmk/Copilotix/releases/tag/desktop-v1.3.0) · [下载 Lite 1.0](https://github.com/Kumiko-kmk/Copilotix/releases/tag/desktop-lite-v1.0.0) · [使用指南](https://github.com/Kumiko-kmk/Copilotix/wiki) · [反馈](https://github.com/Kumiko-kmk/Copilotix/issues)

Windows x64 · 简体中文 · 本地文库 · 中英对照 · AI 问答

</div>

Copilotix 把 PDF 解析、翻译、阅读与整理放在同一张桌面。展开论文档案，打开原文与中文对照，留下批注，带着段落和图片继续提问。

## 从文库走进论文

![完整版文库浏览](docs/images/demos/2-library-browse.gif)

分类浏览、标题搜索、封面图组与结构化档案，让每篇论文都有清晰的入口。

![完整版档案展开](docs/images/demos/3-archive-detail.gif)

## 阅读，让线索连起来

| 对照阅读 | 带着上下文提问 | 留下自己的理解 |
|---|---|---|
| PDF、原文、中文与问答自由拆分 | 段落、选区和图片加入对话 | 高亮、下划线、笔记与双击编辑 |
| 内容块定位，公式与表格呈现 | 可定位引用带你回到论文 | 引用卡片悬停查看、点击复制 |
| Qwen、DeepSeek 与本机 Codex | 对话与模型选择按论文保存 | Markdown、图片与结果 ZIP 导出 |

通过 [Zotero](docs/ZOTERO_BRIDGE_ZH.md) 导入文献，接着阅读和整理。

<details>
<summary>查看完整版首页</summary>

![完整版首页与导入](docs/images/demos/1-home-cipher.gif)

</details>

## 选择你的工作台

| | 完整版 | Lite 1.0 |
|---|---|---|
| 文献入口 | 可视化文库、档案展开 | 列表侧栏、标题搜索、置顶与分类 |
| 阅读 | PDF、原文、中文、问答四视图 | 四视图、双论文分屏、独立窗口 |
| 界面 | 完整档案场景与首页特效 | 静态加载、简洁首页 |
| 设置 | 多密钥与模型配置 | 服务、存储、外观 |
| 安装 | 独立程序与数据 | 独立程序与数据，可并存 |

[完整版下载](https://github.com/Kumiko-kmk/Copilotix/releases/tag/desktop-v1.3.0) · [Lite 1.0 下载](https://github.com/Kumiko-kmk/Copilotix/releases/tag/desktop-lite-v1.0.0) · [Lite 更新说明](docs/releases/lite/1.0.0.zh-CN.md)

## 开始使用

1. 下载 `setup.exe`，按向导安装。
2. 配置 MinerU Token，以及模型 API Key 或本机 Codex。
3. 导入 PDF，开始对照阅读。

资料保存在本地，密钥使用 Windows 凭据存储。解析与 AI 功能连接你配置的服务。两版可通过导出／导入转移文献，分别配置密钥。

[第一篇论文](https://github.com/Kumiko-kmk/Copilotix/wiki/First-Paper) · [服务配置](https://github.com/Kumiko-kmk/Copilotix/wiki/Service-Setup) · [阅读工作台](https://github.com/Kumiko-kmk/Copilotix/wiki/Reader-Workbench) · [数据与备份](docs/LIBRARY_MANAGEMENT_ZH.md)

## 项目结构

### 进程与职责

![Renderer、Main、Utility 的职责与通信路径](docs/images/architecture-processes.png)

React 负责交互，Main 管理窗口、权限与模型请求，Utility 拥有 SQLite 和文档计算。Core RPC 传递小型描述，大资源经受控协议读取。

### 一份文档，多种视图

![文档来源、基础模型、版本化快照与内容消费者](docs/images/architecture-document.png)

原始内容、译文和用户编辑分别保留版本，组合为共享快照。阅读、翻译、问答、导出和档案沿用同一套块身份与映射；重新解析后只关联唯一匹配的内容。

### 共享模型调用

![模型请求预算、连接健康状态与冷却后的单请求试探](docs/images/architecture-models.png)

各功能保留自己的提示词，共享连接检查、排队预算与用量记录。故障连接进入冷却，后续请求快速跳过；恢复由新请求触发单次试探。

开发环境：**Node.js 24.19.0 · pnpm 11.19.0**。

```powershell
pnpm install --frozen-lockfile
pnpm desktop:dev
pnpm --dir desktop dev:lite
```

[架构](docs/ARCHITECTURE_ZH.md) · [开发与测试](docs/DESKTOP_DEVELOPMENT_ZH.md) · [发布](docs/DESKTOP_RELEASE_ZH.md) · [贡献](AGENTS.md) · [图像来源](docs/images/README.md)

## 许可与致谢

[MIT](LICENSE.md)。感谢 MinerU、Electron、React、PDF.js、KaTeX 等开源项目。[第三方声明](THIRD_PARTY_NOTICES.md) · [安全反馈](docs/SECURITY.md)
