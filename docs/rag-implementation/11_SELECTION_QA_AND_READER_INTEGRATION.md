# 11 — 选区问答与 Reader 快照一致性

> 状态：`planned`
>
> 前置计划：10

## 用户结果

用户选中当前段落即可提问，答案优先围绕该段而不是被全库相似内容带偏；重新解析或切换译文后不会引用错误版本。

## 代码修改任务

1. 扩展现有 `ReaderChatSelection`：加入 documentId、artifactId、contentRevisionId、view/source language、UTF-16 offsets、mappingIds、selection hash；保持 payload bounded。
2. 接通 `ReaderTextPane`/`MarkdownPane` 已存在的 `onAddToChat` 扩展点；不要另建重复选区系统。
3. Main/Utility 不信任前端文本：根据 artifact/content revision 重新读取/校验 hash、offset、mapping 和 scope；不匹配返回 `SELECTION_STALE` 并提示重新选择。
4. 路由为 pinned selection → 同 mapping/前后各 1 个叶子块 → 必要 parent；只有用户明确问“结合全文/其他论文”才扩展混合检索。
5. 原文/译文选区都映射到原文 provenance；译文无法可靠对齐时明确标注低置信，不伪造精确 bbox。
6. Reader 抽屉展示当前 pinned evidence，可移除/重选；切文档、切 artifact 或删除文档会清空不兼容选区。
7. citation 点击复用现有 PDF/Text mapping；过期引用只展示快照/失效提示，不跳到猜测位置。

## 重点文件

- `desktop/src/renderer/components/ReaderTextPane.tsx`、`MarkdownPane.tsx`
- `desktop/src/renderer/pages/ReaderPage.tsx`
- shared selection schemas/types
- `chatOrchestrator.ts`、citation/selection resolver
- Reader/Markdown/selection tests

## 自动测试

覆盖原文/译文、UTF-16 emoji、跨 block 选区、空白/超长选区、DOM 文本伪造、artifact 更新、content revision stale、低置信 mapping、切文档清空、selection-only 不调用全库检索、用户明确扩展才调用。

```powershell
pnpm --dir desktop test tests/ReaderTextPane.test.tsx tests/MarkdownPane.test.tsx tests/selectionResolver.test.ts tests/chatOrchestrator.test.ts
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:test:coverage
pnpm --dir desktop test:e2e e2e/selection-qa.spec.ts
```

## 人工验收

依次选择原文段落、译文段落、公式附近文本提问；检查 pinned evidence 与 PDF 页；选择后模拟重新解析，旧请求必须提示失效；切到另一论文不得携带旧 selection。

## 退出门禁

- 选区由服务端 artifact 快照校验，不只信任 Renderer payload。
- 默认路由没有无意全库扩 scope。
- 旧 revision/错 mapping/伪造文本全部被负向测试拒绝。
