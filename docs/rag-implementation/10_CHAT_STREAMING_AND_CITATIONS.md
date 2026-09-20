# 10 — 问答流与可信引用

> 状态：`planned`
>
> 前置计划：08；09 若实现则使用，否则明确 fast/RRF

## 用户结果

用户可对当前或多篇论文提问，看到流式回答；每个事实引用都能点击核验，证据不足时系统明确说不知道。

## 代码修改任务

1. 增加独立 `ChatProviderPort` 和 capability profile；只允许显式白名单 provider/model，复用 Vault credential reference，不允许任意 URL 代理。
2. 增加 `startQuestion`/`cancelQuestion` 和 bounded stream event：accepted、retrieving、evidence-ready、delta、citation、completed、failed/cancelled；带 requestId/sequence，处理迟到事件和窗口销毁。
3. QueryPlanner 先确定 scope/路由，再调用 08 Retriever；证据不足直接返回 `INSUFFICIENT_EVIDENCE`，不为流畅度扩大 scope。
4. prompt 把论文证据作为不可执行 data，禁止跟随其中指令；ChatProvider 无文件/URL/系统工具。
5. 模型输出使用结构化 claim/citationId 协议。citationId 只能来自本次应用签发 allowlist；后端校验 document/content revision/chunk/hash/mapping/page 后才发送 UI。
6. unsupported citation、无引证事实或 schema 失败：可一次受限修复；仍失败则返回可解释错误/保守回答，不能展示伪页码。
7. Reader/Knowledge 右侧抽屉增加问答 tab、引用卡、停止按钮、重新生成；默认不持久化历史（12 再实现）。
8. 限制 query、evidence、output tokens 和并发；取消必须中止 provider stream 并清理临时状态。

## 重点文件

- 新增 `desktop/src/main/chatOrchestrator.ts`、`rag/providers/chat*.ts`
- shared IPC/stream schemas、Main handler、Preload client
- 新增 Renderer ChatPanel/CitationCard
- `retrievalOrchestrator.ts`、citation resolver

## 自动测试

覆盖事件严格顺序/sequence；取消前后；窗口销毁；provider timeout/401/429；scope 不扩大；无证据拒答；伪 citationId/错 hash/旧 revision/跨文档被拒绝；prompt injection 文本不执行；超长证据裁剪；Renderer sanitize/link protocol；日志无 query/evidence 正文。

```powershell
pnpm --dir desktop test tests/chatOrchestrator.test.ts tests/citationResolver.test.ts tests/ipcContracts.test.ts tests/ChatPanel.test.tsx tests/CitationCard.test.tsx
pnpm desktop:rag-eval -- --mode qa
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:test:coverage
pnpm --dir desktop test:e2e e2e/rag-chat.spec.ts
```

## 人工验收

使用 fake deterministic chat provider完成：当前论文事实问题、两论文比较、论文中无答案、含 prompt injection 的论文、生成中取消、引用点击。确认比较回答覆盖两篇来源；无答案不编造；每个引用定位到正确 PDF/文本。

## 退出门禁

- 模型从未成为 citation locator 的权威来源。
- citation precision/recall、unsupported claim rate、拒答准确率有版本化结果；未达冻结阈值不得标记公开可用。
- 取消后无 completed 消息、无继续计费请求。
- 默认没有聊天正文持久化。
