# 本地资料、导出与文库管理

**适用版本：1.1.0。** 文献目录保存 PDF、解析产物、译文及聊天；独立应用数据库保存任务、文献记录等应用状态，凭据由系统管理。

![当前文献目录、聊天记录、结果 ZIP 与独立数据库](https://raw.githubusercontent.com/Kumiko-kmk/Copilotix/master/docs/images/local-paper-files-1.1.0.png)

*根据 1.1.0 代码结构更新的蓝白目录示意图。可选产物取决于服务返回与处理情况，示意图不是应用截图。*

## 一篇文献的文件

在「设置 → 文件存储」确认文档保存位置，也可从阅读器打开输出目录：

```text
<文档保存位置>/documents-v2/<documentId>/
├── original.pdf                   # 原始 PDF
├── full.md                        # 解析原文
├── full.zh-CN.md                  # 中文译文
├── layout.json                   # 版面与页面坐标
├── block_list.json               # 内容块映射
├── content_list.json             # 可选
├── images/                       # 可选图片资源
├── translation.manifest.json     # 译文块与映射
├── translation.checkpoint.json   # 翻译进度
├── chat/                         # 问答使用后按需创建
│   ├── session.json              # 草稿、选区、模型选择
│   └── <timestamp>-<turnId>.json  # 问题、回答、引用
└── .translation/<jobId>/plan.json # 内部翻译计划
```

`documentId` 是应用文献 ID，不是原文件名或任务 ID。不是每篇文献都已翻译或使用问答，相应文件可能尚未生成。

聊天记录按文献原子落盘，重新打开恢复；API Key 不写入这些文件。底层 JSON 继续用于定位与处理，但不再作为阅读页签展示。

## 应用数据库与凭据

默认应用数据库位置：

```text
%APPDATA%\Copilotix-Translation-v2\copilotix-desktop-v2.sqlite3
```

数据库与文献保存位置相互独立。只拷贝一个文献目录不能完整恢复任务列表、设置及应用状态；只备份数据库也不能代替 PDF、图片、译文和聊天文件。

API 凭据保存在 Windows 系统凭据存储中，不随结果 ZIP 或完整文库备份导出。跨电脑恢复后重新配置凭据；同电脑重装时系统中已保留的凭据可能仍在。

## 另存 Markdown

阅读器选中原文／中文视图后另存，生成标准 Markdown 投影并复制关联图片到相邻资源目录，源资料不被改写。分享时同时保留 Markdown 和图片目录，并维持相对路径。

阅读器可以显示 HTML 合并表格与 LaTeX 丰富结构；标准导出面向 CommonMark／GFM 与明确数学扩展，目标软件的渲染能力可能不同。另存文件不能自动恢复任务与聊天。

## 导出结果 ZIP

结果 ZIP 包括文献产物与图片，原文／译文经标准化；排除内部 `.translation/`，不含应用数据库和系统凭据。

**已有 `chat/` 文件也会进入结果 ZIP，包括轮次、草稿与选区。** 分享前查看导出内容。只需要正文时可改为另存 Markdown 和图片；清空应用内聊天不会删除已经导出的副本。

ZIP 是处理结果交付，不等同于完整文库备份。

## 备份、恢复与迁移

使用应用内的文库管理功能，并先等待解析、翻译与问答结束。

| 操作 | 结果 |
| --- | --- |
| 创建备份 | 保存数据库、文献产物、聊天、批注及已保存设置，生成校验信息；不含系统 API 凭据 |
| 恢复备份 | 先检查备份结构、兼容性及文件哈希，再恢复应用记录和文件；保留旧文献目录 |
| 迁移文库 | 复制并校验完成后切换存储路径；保留旧目录，不自动删除 |
| 修改文档保存位置 | 只影响新任务，不搬移已有文献 |

备份目录须完整保留，不要只留下其中的数据库或 ZIP。恢复会影响当前文库，操作前保留当前库的备份，并依应用提示重启和检查文献。

想节省空间时，先完成迁移、重启验证与备份，再人工判断旧目录是否仍需保留。不要在任务活动期间手工改名或移动文献目录。

详细兼容与恢复语义见 [文库管理指南](https://github.com/Kumiko-kmk/Copilotix/blob/master/docs/LIBRARY_MANAGEMENT_ZH.md)，卸载清理见[安装与升级](https://github.com/Kumiko-kmk/Copilotix/wiki/Installation-and-Upgrade)。
