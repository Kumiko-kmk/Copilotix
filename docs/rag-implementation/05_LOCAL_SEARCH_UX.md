# 05 — 本地搜索 UI 与来源跳转

> 状态：`planned`
>
> 前置计划：04

## 用户结果

用户能从顶层知识库跨论文检索，也能在阅读器内搜索当前论文；点击结果会定位到文本和 PDF，不占用永久第三列。

## 代码修改任务

1. 在 `ipc.ts`/`ipcSchemas.ts`、Main handler、Preload 加显式 `getKnowledgeStatus`、`searchKnowledge`、`cancelSearch` 等领域方法；双向 Zod 校验、sender 检查、分页和超时沿用现有模式。
2. Main 只协调 scope/取消/错误映射，查询在 Utility；禁止 Renderer 传 SQL、文件路径或 provider URL。
3. `App.tsx` 增加顶层“知识库”页面，用于显式多文档 scope；默认不无界搜索全部数据，显示所选范围。
4. Reader 使用 400–480 px 的右侧 overlay/collapsible drawer，不改当前 PDF/文本双栏为永久三列；窗口窄时覆盖内容并可 Esc 关闭。
5. 结果卡展示 title、section、snippet、page、命中来源（word/trigram/translated/exact）和定位置信度；不得显示不可比较的伪百分比。
6. 点击结果使用现有 document cache、block mapping 和 Reader 路由定位；stale/missing citation 提示重新索引，不猜页码。
7. Tasks/Reader 以独立 badge 显示本地索引状态和 retry/cancel；现有 `completed` 文档不因 indexing 被改为未完成。
8. 空状态明确区分：尚未解析、正在本地索引、无结果、索引失败；不把“未配置 AI”作为本地搜索错误。

## 重点文件

- `desktop/src/shared/ipc.ts`、`ipcSchemas.ts`、`types.ts`
- `desktop/src/main/ipc.ts`
- `desktop/src/preload/index.ts`、`ipcClient.ts`
- `desktop/src/renderer/App.tsx`
- 新增 `pages/KnowledgePage.tsx`、`components/KnowledgeSearchDrawer.tsx`、结果组件
- `ReaderPage.tsx`、`ReaderTextPane.tsx`、`styles.css`

## 自动测试

覆盖 IPC request/response 上限和 sender；Preload 不暴露通用 invoke；debounce/取消/迟到结果；scope 切换；空/失败/ready 状态；键盘与 focus trap；窄窗口抽屉；点击 mapping 跳转；无 AI 凭证仍搜索；workflow status 未变化。

```powershell
pnpm --dir desktop test tests/ipcContracts.test.ts tests/ipcValidation.test.ts tests/KnowledgePage.test.tsx tests/KnowledgeSearchDrawer.test.tsx tests/ReaderTextPane.test.tsx
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:test:coverage
pnpm --dir desktop test:e2e e2e/knowledge-search.spec.ts
```

## 人工验收

按用户路径验收：启动断网应用 → 打开已解析论文 → 文档仍显示 completed → 打开搜索抽屉 → 搜索并跳到 PDF/文本 → Esc 关闭后双栏尺寸恢复；再到知识库页选择两篇论文，结果只来自两篇。检查 1100 px 最小窗口宽度与高 DPI。

## 退出门禁

- 无 Key/断网流程完整可用。
- 窄窗口没有不可操作的永久第三栏、横向溢出或焦点丢失。
- scope 和 citation 定位由自动测试与 E2E 同时证明。
- 若当前环境不能跑 Electron E2E，记录未运行原因和可复现命令，本计划保持 `blocked` 直到 CI/目标 Windows 完成。
