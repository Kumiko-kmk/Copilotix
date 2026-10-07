# 配置解析、翻译与问答服务

**适用版本：1.1.0。** Copilotix 不提供或代付第三方 API 凭据；额度、费用、模型权限和数据处理条款以服务商当前说明为准。

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
| Bing | 应用内无需 Key 的网页翻译 | 不支持 |
| 腾讯 TranSmart | 应用内无需 Key 的网页翻译 | 不支持 |

表中是 **1.1.0 内置选项**，不是对服务端可用性的保证；实际调用取决于账号、地域、额度与服务商当前模型列表。当前版本不接受自定义模型名称。旧自定义选择回退到预设，历史对话保留。

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

## 启用、顺序与共用凭据

在「设置 → 模型设置」启用需要的翻译服务，并设置顺序。默认 **Qwen → DeepSeek → Bing → TranSmart**，跳过未启用或没有有效凭据的 Qwen／DeepSeek；失败可能回退到后续已启用来源。只希望向指定来源发送文本时，请关闭其他来源并保存。

问答共用相应服务在「服务连接」中保存的 API 凭据，默认沿用翻译服务商，面板可选择已启用的 Qwen／DeepSeek 与独立问答模型。切换问答模型不修改翻译模型。服务未启用、凭据无效或未保存时，问答会提示前往设置。

## 验证与保存

「测试连接」成功不等于已保存，仍需点击「保存全部更改」。单个字段失败时按提示修正。凭据保存在 Windows 系统凭据存储中，不写入论文 `chat/`，也不包含在文库备份里。

问答首次发送还需确认接收服务与数据范围；更换接收服务可能需要再次确认。操作见[论文 AI 问答](https://github.com/Kumiko-kmk/Copilotix/wiki/Paper-AI-Chat)。公开反馈和截图只保留掩码及脱敏错误。
