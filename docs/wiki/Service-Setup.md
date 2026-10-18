# 配置解析、翻译与问答服务

**适用版本：1.2.0（含 Codex 接入）。** Copilotix 不提供或代付第三方 API 凭据；额度、费用、模型权限和数据处理条款以服务商当前说明为准。

## MinerU：PDF 在线解析

1. 登录 [MinerU Token 管理页](https://mineru.net/apiManage/token)申请 Token。
2. 在「设置 → 服务连接 → MinerU」粘贴 Token 本身，不加 `Bearer` 前缀。
3. 点击「测试连接」，成功后点击「保存全部更改」。
4. 确认已验证，再创建解析任务。

解析使用 MinerU 在线 v4 API，PDF 会上传至其提供的地址；安装包不含本地解析模型。

![PDF 解析为 Markdown、图片和来源定位信息](https://raw.githubusercontent.com/Kumiko-kmk/Copilotix/master/docs/images/pdf-structure-source.png)

*处理流程示意图：内容块保留页码、坐标框及来源信息。这是概念图，实际界面见阅读工作台指南。*

## 翻译来源与问答模型

| 服务 | 翻译选择项 | 论文问答选择项 |
| --- | --- | --- |
| Qwen／千问 | `qwen-mt-plus` | `qwen-plus`、`qwen3.8-flash`、`qwen3.8-max` |
| DeepSeek | `deepseek-flash` | `deepseek-flash`、`deepseek-v4-pro` |
| Codex（可选） | 本机目录中的文本模型 | 本机目录中的文本／视觉模型 |
| Bing | 应用内无需 Key 的网页翻译 | 不支持 |
| 腾讯 TranSmart | 应用内无需 Key 的网页翻译 | 不支持 |

表中是 **1.2.0 预设选项**，不是对服务端可用性的保证；实际调用取决于账号、地域、额度与服务商当前模型列表。Qwen／DeepSeek 不接受自定义模型名称，旧自定义选择回退到预设。Codex 从本机动态读取模型目录；已选模型消失时提示重新选择，保留历史，不自动替换。

### Qwen

1. 在[阿里云百炼控制台](https://bailian.console.aliyun.com/)开通服务并创建 API Key。
2. 当前应用地址为 `https://dashscope.aliyuncs.com/compatible-mode/v1`，对应北京地域。地域不同的 Key、域名和模型列表不能混用，见[官方 API Key 文档](https://help.aliyun.com/zh/model-studio/get-api-key)。
3. 确认业务空间和权限支持所选翻译／问答模型。
4. 填入 Qwen 服务卡片，测试连接后保存。

### DeepSeek

1. 在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys)创建 API Key。
2. 确认余额与调用权限。
3. 填入 DeepSeek 卡片，测试连接后保存。

当前应用地址为 `https://api.deepseek.com`，服务细节见[官方文档](https://api-docs.deepseek.com/zh-cn/)。

### Bing／TranSmart

可用于翻译与回退，应用内无需填写 Key，但仍需网络，且依赖第三方网页接口。它们不提供论文问答功能。

### Codex：复用本机登录

1. 安装 Codex CLI **0.159.x**，在本机运行 `codex login` 完成 ChatGPT 登录。
2. 在「设置 → 服务连接 → Codex」点击「刷新连接与模型」。自动发现失败时选择实际的 `codex.exe`（不选 `.cmd` 启动脚本）。
3. 分别选择翻译模型、问答／解读模型及推理强度；点击模型测试确认当前账户可以调用，再保存全部更改。
4. 在「模型设置」启用 Codex，并调整顺序；默认仍关闭。希望优先使用 Codex 时将它移到首位。
5. 问答可在面板选择 Codex；档案卡总结和图片解读沿用其问答模型，识图需要目录标记支持图片的模型。

这是本机 CLI 接口接入，**不是离线模型**：内容仍经 Codex 发往其配置的模型服务，受登录、网络、账户额度和模型权限限制。Copilotix 不读取登录令牌、不替你登录，也不更改个人 Codex 配置。PDF 解析仍使用 MinerU。

目录可见不等于实际可调用。模型繁忙时可稍后重试或手动换模型；不会自动换 Codex 模型。翻译队列到达 Codex 后，失败不会继续转发给其他服务。若要确保仅发往 Codex，将它排第一或关闭其他来源。连接异常先检查 `codex login status`、CLI 版本及所选模型。该接入使用 [Codex App Server](https://learn.chatgpt.com/docs/app-server)，当前只启用已验证的 0.159.x 协议。

## 启用、顺序与共用凭据

在「设置 → 模型设置」启用需要的翻译服务，并设置顺序。默认 **Qwen → DeepSeek → Bing → TranSmart**，跳过未启用或没有有效凭据的 Qwen／DeepSeek；失败可能回退到后续已启用来源。只希望向指定来源发送文本时，请关闭其他来源并保存。

问答共用相应服务在「服务连接」中保存的 API 凭据，默认沿用翻译服务商，面板可选择已启用的 Qwen／DeepSeek／Codex 与独立问答模型。切换问答模型不修改翻译模型。服务未启用、凭据无效或未保存时，问答会提示前往设置。

## 验证与保存

「测试连接」成功不等于已保存，仍需点击「保存全部更改」。单个字段失败时按提示修正。凭据保存在 Windows 系统凭据存储中，不写入论文 `chat/`，也不包含在文库备份里。

使用程序即同意向已选服务发送功能所需的论文文本及图片；问答、总结与识图直接发送，无单独确认步骤。Codex 测试连接成功会填入程序路径，所选模型测试通过后显示绿色「验证成功」。

Codex 连接与模型验证状态会保留，重新启动自动检测连接。AI 问答的每条结果下方显示实际模型、时间、用时及输入／输出／总 Token；服务未返回用量或旧记录缺失时明确显示未提供。
