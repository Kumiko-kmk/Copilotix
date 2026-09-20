# 06 — AI 能力配置与隐私同意

> 状态：`planned`
>
> 前置计划：05

## 用户结果

用户清楚知道哪些论文文本会发送给哪个服务，并可单独启用 embedding、rerank、chat；保存翻译 Key 不会自动上传任何论文。

## 代码修改任务

1. 增加 capability profile，而不是复制一组含明文 Key 的 RAG 设置：`embedding`、`rerank`、`chat` 分别记录 provider、base URL/model、capability、credential reference、验证时间和 immutable fingerprint。
2. 优先引用现有 Vault 中 Qwen/DeepSeek credential；如果需要不同 Key，创建新的 Vault reference。Renderer/SQLite 永远不接收明文。
3. 能力白名单：Bing/TranSmart 不能用于 RAG；DeepSeek chat profile 不自动假设 embedding 可用；每个 profile 用安全的 provider adapter 探测。
4. 增加 `semanticIndexingEnabled=false` 默认值和版本化 consent receipt（供应商、用途、数据类别、时间、设置版本）。仅“保存 Key”不得改变此值。
5. 设置页在首次开启时说明：发送 chunk 文本、可能包含论文敏感内容、服务商、可撤销方式、关闭不会远程删除服务商日志；确认后才为 eligible 文档排队 `rag-embed`。
6. chat/rerank 分别在首次使用显示外发范围；不把 embedding 同意扩张为所有 AI 用途。
7. 撤销同意立即阻止新网络调用并取消未发出的 batch；本地 FTS 保留。已生成向量的保留/立即清理选择必须明确，默认建议本地清理。
8. 日志仅记录 provider/profile id、批次计数、延迟和错误码，不记录 Key、query、chunk 正文。

## 重点文件

- `desktop/src/shared/types.ts`、`ipcSchemas.ts`、新增 RAG settings schemas
- `desktop/src/main/settingsService.ts`、`credentialVault.ts`
- `desktop/src/main/rag/providers/*`（能力接口/探测，不做 embedding 批处理）
- `desktop/src/renderer/pages/SettingsPage.tsx`
- Settings、credential、provider policy 测试

## 自动测试

覆盖默认 false；保存/验证翻译 Key 后网络上传为 0；未同意/凭证缺失/能力不支持时不得创建 embed job；同意 receipt 与 profile fingerprint；撤销取消；Key 不进入 SQLite/IPC/log；Bing/TranSmart 被拒绝；DeepSeek 无 embedding 能力时准确提示；已有 credential reference 可复用。

```powershell
pnpm --dir desktop test tests/settingsService.test.ts tests/credentialGate.test.ts tests/providerPolicy.test.ts tests/ragConsent.test.ts tests/SettingsPage.test.tsx
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:test:coverage
```

## 人工验收

用全新设置目录验证：配置翻译 Key → 导入/搜索论文 → 抓取 fake provider 调用数仍为 0；主动开启语义索引 → 看见明确确认 → 同意后才排队；撤销后本地搜索继续、无新请求。检查设置中不会要求重复输入可复用的 Key。

## 退出门禁

- “持有凭证”“能力可用”“用户同意”是三个独立条件，均有负向测试。
- 没有 profile capability guessing。
- Renderer、数据库、日志中没有明文凭证或论文正文诊断。
- 本阶段仍不真实发送 chunk embedding。
