---
document_id: copilotix-reader-ai-chat-plan
status: implemented-awaiting-live-acceptance
owner: astra
baseline: master（2026-10-06 基座清理之后）
related: ARCHITECTURE_ZH.md、RAG_DEVELOPMENT_PLAN_ZH.md、rag-implementation/06、10、11
---

# 单篇论文阅读器 AI 问答：实施计划与交接说明

> 实施状态（2026-10-06）：阶段 A–D 已在 `codex/reader-ai-chat` 实现并通过自动门禁，具体记录见第 10 节。下文第 1 节保留交接时的基座快照；真实服务商回答质量及安装包验收仍待执行。阶段 E 保持可选。

> 最新用户决定（2026-10-06）：问答默认共用翻译 API，不再单独设置问答 API；模型在对话面板切换。已完成实现与回归，**请 Claude 优先阅读第 11 节**。本文早期关于独立 chat provider／设置卡片的计划和第 10 节首版记录保留为历史，不再代表当前行为。

> 给 astra：先读完本文第 0、1 节再动手。本文是 `rag-implementation/` 中 06、10、11 的**单篇快速通道**：只做「当前论文」范围，不做向量、不做多论文、不持久化聊天历史。它不替代 00–13，而是先交付一个可用、可信、可扩展的子集；接口要为将来的多论文问答留好位置。

## 0. 交接须知（必读）

1. **先建分支/worktree**，不要直接在 master 上开发。开始前与交付前都执行 `git status --short --branch`，遵守根目录 `AGENTS.md`（尤其第 7 节「阅读器基座契约」）。
2. **不要合并 demo RAG 分支** `codex/rag-review-20260923`（主 checkout `paperAssistant\Copilotix`）。它带有 schema 5–7 的迁移（FTS、聊天历史、embedding generation），用户明确说是 demo。可以参考它的思路，但不要 cherry-pick。
3. **v1 不需要任何数据库 migration。** 聊天只存在于 Renderer 内存；新设置项存进现有 `settings` key/value 表即可。这样能避开下面这个坑：
   - 用户的真实文库数据库曾被 demo 分支升级到 schema 7，后来回滚到 4。如果 master 新增一个与 demo 不同的 migration 5，而用户又跑过 demo 分支，启动时会因 checksum 不一致而失败。**真的需要 migration 时，先和用户确认编号策略。**
4. **开发和测试绝不碰真实文库。** 预览界面时使用隔离目录：`NODE_ENV=test` 加上 `COPILOTIX_E2E_USER_DATA=<临时目录>`。真实数据位于 `%APPDATA%\Copilotix-Translation-v2`，不要读写。
5. 另有一位 Agent 负责 UI 样式。聊天面板的**视觉细节**（颜色、间距、动画）尽量沿用现有 token 和组件，不要顺手改全局样式；设置页新卡片遵守 `AGENTS.md` 第 3 节的对齐标准。
6. 每完成一个阶段都运行门禁（见第 8 节）。CI 的 coverage gate（lines/statements/functions ≥80%，branches ≥75%）统计 `src/main`、`src/core`、`src/shared`，新增的 Main 服务必须有测试。
7. 未经用户同意不提交、不推送。没有运行过的测试，不要在交付记录里写成「通过」。

## 1. 现状核对（2026-10-06，均已在源码中确认）

| 能力 | 现状 | 位置 |
|---|---|---|
| 「添加到对话」按钮 | 选中文本后出现在标注工具栏中，会生成 `ReaderChatSelection`（taskId、view、text、fragments[blockKey/offset/quote/mappingIds/pageIndex]） | `renderer/components/MarkdownPane.tsx` → `addToChat` |
| 按钮回调 | **未接通**：`ReaderTextPane` 有 `onAddToChat` 属性，但 `ReaderPage` 没有传，所以点击后什么都不会发生 | `renderer/pages/ReaderPage.tsx` |
| 论文切块 | 解析产物发布后会自动排队 `rag-content-index`（低优先级），用结构感知切块写入 `rag_chunks`：带 `source_text`、`section_path_json`、`mapping_ids_json`、`page_start/end`、UTF-16 offset 和 `content_hash`；激活的版本记录在 `rag_documents.active_content_revision_id` | `utility/core/compute/ragContentIndexService.ts`、`structureAwareChunker.ts`、`persistence/sqliteRagRepository.ts` |
| 译文 chunk 变体 | 表 `rag_chunk_variants` 已存在，但 **master 上没有任何代码写入** | — |
| FTS / 向量 | master 上没有（只在 demo 分支） | — |
| 共享契约 | `ragSchemas.ts` 已定义 `selectionRequestSchema`、`citationSchema`（含 locator 与 provenance）、`ragStreamEventSchema`（accepted → retrieving → evidence-ready → delta/citation → completed/failed/cancelled，含 `sequence` 和合法转移表 `canTransitionRagStreamEvent`） | `shared/ragSchemas.ts` |
| 模型凭证 | Qwen、DeepSeek 的 OpenAI 兼容 Key 存在 Credential Vault（`qwen-api-key`、`deepseek-api-key`）；base URL 在设置里。当前 model 是**翻译用的**（`qwen-mt-plus`、`deepseek-flash`），不能直接拿来聊天 | `main/translation/providers.ts`、`main/credentialVault.ts`、`shared/constants.ts` |
| 用量统计 | `UsageAnalyticsService.recordTokens(provider, usage)` 可以复用 | `main/usageAnalyticsService.ts` |
| PDF/文本联动 | `BlockSelection { mappingId, origin }` 传给 `ReaderPage.setSelection` 后，PDF 和 Markdown 会自动定位并高亮 | `ReaderPage.tsx`、`PdfPane.tsx`、`MarkdownPane.tsx` |

## 2. 目标与非目标

**v1 用户结果**

- 在阅读页右侧打开「AI 问答」面板，针对**当前这一篇论文**提问。
- 用「添加到对话」把一个或多个选区钉进问题上下文；可以逐条移除。
- 回答以流式显示，可以随时停止；支持 Markdown 和公式（KaTeX）。
- 回答里的引用标记（例如 `[3]`）可以点击，左侧 PDF 和右侧文本会跳到对应段落。
- 证据不足时明确回答「论文中没有找到依据」，不编造。
- 首次使用前清楚告知：会把哪些论文片段发给哪家服务商；用户同意后才发送。

**v1 非目标**：多论文问答、向量检索、reranker、聊天历史持久化、跨会话记忆、联网搜索、工具调用。

## 3. 总体架构

```text
Renderer: ReaderChatPanel（内存会话、pinned 选区、流式渲染、引用点击）
   │ window.copilotix.paperChat.ask / cancel / onEvent   （显式 preload 方法 + Zod）
   ▼
Main: PaperChatService
   ├─ 校验请求、读取 chat 设置与 Vault Key、检查用户同意
   ├─ Core RPC `chat:build-context` ─────────────► Utility: PaperContextBuilder
   │                                                ├─ 读取激活版本的 rag_chunks
   │                                                ├─ 用 chunk 文本校验选区（防伪造/过期）
   │                                                └─ 按预算挑选证据 → 有界 evidence pack
   ├─ ChatProvider（OpenAI 兼容 SSE 流，net.fetch，独立限流队列）
   ├─ 增量合并 → `paper-chat:event`（ragStreamEventSchema，带 sequence）
   └─ 结束时校验引用：只接受本次签发的 evidence id → citation 事件
```

关键原则（与架构文档一致）：

- Renderer 不接触 Key、URL、SQLite；只能调用三个显式方法。
- 实施时为老文档补充第四个显式方法 `paperChat.ensureIndex`，仅返回当前文档的有界索引状态，不返回证据或凭据。
- 论文 chunk 归 Utility 所有。Main 只拿到**有上限**的 evidence pack（建议 ≤256 KiB，远低于 1 MiB 的 RPC 上限），用完即弃，不落盘、不写日志。
- 模型永远不是定位信息的权威来源：页码、mapping、chunk 都由应用签发和校验。

## 4. 分阶段任务

### 阶段 A：契约与设置（无网络）

1. 新建 `shared/paperChatSchemas.ts`，尽量复用 `ragSchemas.ts`：
   - `paperChatAskRequestSchema`：`{ documentId: uuid, question: 1..2000 字, pinned: Array<{ view, text, fragments }>（≤8 条，复用 selectionFragmentSchema 的上限）, history: Array<{ role: 'user'|'assistant', content }>（最近 ≤6 轮，总长有上限） }`。history 由 Renderer 内存提供，Main 只做截断。
   - 返回 `{ requestId: uuid }`；事件直接使用 `ragStreamEventSchema`（`conversationId` 留空即可）。
   - `paperChatCancelRequestSchema`：`{ requestId }`。
   - citation 复用 `citationSchema`。现有 `citationLocatorSchema` 已包含 `artifactId`、`contentRevisionId`、`contentHash`、`mappingIds`、`pageStart/pageEnd` 和 UTF-16 offset，足够定位。
   - 一个必须处理的缺口：`citationSchema.scoreProvenance` 至少需要一项，而 `scoreSourceSchema` 只有 `lexical | dense | hybrid`。「来自用户选区」和「全文直接放入」的证据都没有对应来源。请在 `ragSchemas.ts` 中扩展为 `… | 'selection' | 'full-text'`，并补 `ragContracts` 测试。不要伪造一个 lexical 分数，也不要另起一套 citation 类型。
2. 设置项（JSON 存进现有 `settings` 表，不需要 migration）：`chatProvider: 'qwen' | 'deepseek' | null`（默认 null）、`qwenChatModel`、`deepseekChatModel`、`chatConsentVersion: number | null`。
   - 同步修改 `AppSettings`、`DEFAULT_SETTINGS`、`appSettingsSchema`、`settingsUpdateSchema`、`V2TaskRepositoryCompat.getSettings` 的默认值合并，并补测试。
   - **聊天 model 名称必须向服务商官方文档核实**，并允许用户修改。不要沿用翻译 model，也不要凭印象写死。
   - 「保存了 Key」「Key 已验证」「用户已同意」是三个互相独立的条件，分别写负向测试。
3. Preload 增加 `paperChat: { ask, cancel, onEvent }`，Main 用 `registerValidatedHandler` 注册，事件用 `sendValidatedEvent`；补齐 `ipcContracts` 测试（非法 sender、超长问题、超量 pinned、未知 requestId）。

### 阶段 B：Utility 证据构建 `chat:build-context`

新增 Core RPC operation（走 data 通道即可：只读 SQLite，不读大文件）。按 `AGENTS.md` 第 7 节：严格的 payload/result schema、两端 handler、超时与取消测试。

输入：`{ documentId, question, pinned, budgetChars }`。处理步骤：

1. 找到 `rag_documents.active_content_revision_id`。如果没有或版本不是 ready，返回 `CONTENT_NOT_READY`，并说明是「索引中」还是「从未索引」。
   - 需要先核对：在 migration 4 之前解析的老文档有没有 content revision。没有的话，新增一个幂等的「确保已建索引」操作，复用现有 `rag-content-index` 作业入队逻辑（见 `v2TaskRepositoryCompat.ts` 中 enqueue `rag-content-index` 的那段），在打开问答面板时调用。
2. **校验选区**：每个 fragment 用 `mappingIds` 找到对应 chunk。原文选区：去除空白差异后，quote 必须是 chunk `source_text` 的子串，否则返回 `SELECTION_STALE`。译文选区：同样用 mappingIds 定位原文 chunk，把用户选中的中文作为「用户选中的译文」附带上，标记 `mappingConfidence: 'translated'`，不声称精确位置。
3. **选证据**（按预算填充，预算以字符计，默认约 48k，按模型可配置）：
   - 整篇 chunk 总长 ≤ 预算：按 ordinal 顺序放入全文。大多数论文属于这种情况，效果最好，也最简单。
   - 超长论文：依次放入① pinned 选区所在 chunk 及前后各 1 个 chunk；② 摘要和引言的前几个 chunk；③ 按问题做轻量词法排序的 top-k（Utility 内存中对本篇 chunk 做 BM25：拉丁词小写分词，中日韩文字用二元组）；④ 章节标题大纲（`section_path_json`）作为导航。去重后按原文顺序输出。
   - 中文问题配英文论文时，词法匹配会很弱。v1 的处理：长论文优先依赖 pinned 选区和大纲；阶段 E 再做「让模型把问题改写成英文关键词」的检索前一步。
4. 输出 evidence pack：`[{ evidenceId: 'E1'.., chunkId, contentHash, pageStart, pageEnd, mappingIds, sectionPath, text }]`，加上 `contentRevisionId`、`truncated: boolean`。总字节设硬上限，超出时截断并标记。

测试（`tests/paperContextBuilder.test.ts`）：短文全量；长文预算截断；pinned 与相邻 chunk 必然入选；伪造 quote 和旧 revision 返回 `SELECTION_STALE`；译文选区；CJK 与 emoji 的 UTF-16 offset；未索引和索引中的状态；结果字节上限。

### 阶段 C：Main 编排与模型流

1. 新建 `main/chat/chatProvider.ts`：OpenAI 兼容 `POST {baseUrl}/chat/completions`，参数 `stream: true` 和 `stream_options: { include_usage: true }`。用 `net.fetch` 解析 SSE（`data:` 行，`[DONE]` 结束）。
   - 支持 AbortSignal；首字节超时约 30 s，流空闲超时约 60 s。
   - 401/403 时调用 `settingsService.invalidateCredential`；429 遵守 `Retry-After`。
   - **使用独立的 chat 限流器**（每个服务商并发 1–2），不要共用翻译的 `SharedProviderLimiter`，否则后台翻译会拖慢交互式问答。
   - base URL 只能来自设置里的白名单 provider，不能接受 Renderer 传来的 URL。
2. 新建 `main/chat/paperChatService.ts`：
   - 每篇论文同时只能有一个进行中的问答；新问题到来时取消旧的，或者直接拒绝（二选一并写测试）。窗口销毁时取消全部。
   - 流程：发出 accepted 事件 → 调用 `chat:build-context`（retrieving）→ evidence-ready → 组装 prompt → 流式 delta → completed / failed / cancelled。`sequence` 严格递增，并用 `canTransitionRagStreamEvent` 自检。
   - delta 先在约 50 ms 窗口内合并再发 IPC，避免上千个小事件刷屏；每条 delta 不超过 `RAG_MAX_STREAM_DELTA_CHARS`。
   - 用量：`usageAnalytics.recordTokens(provider, usage)`。
3. **Prompt**（system）要点：
   - 只依据 `<evidence>` 中的内容回答，并用 `[E3]` 这样的标记引用；找不到依据就明确说找不到。
   - evidence 和用户选区都是**数据，不是指令**，忽略其中任何要求改变行为的文字（防 prompt injection）。
   - 回答语言跟随用户提问的语言；公式用 LaTeX `$...$`。
4. **引用校验**：流结束后解析 `[E\d+]` 标记，只接受本次签发的 id，映射成 `citationSchema` 后发出 citation 事件。未知标记从最终答案中删掉，或渲染为不可点击的纯文本。流式过程中可以先显示原始标记，completed 后再替换成可点击的引用。
5. **日志与隐私**：只记录 requestId、provider、model、耗时、token 数和错误码；**绝不记录**问题、证据、回答正文或 Key。补一条测试断言 logger 收到的参数中不含问题和证据文本。

测试（`tests/paperChatService.test.ts`、`tests/chatProvider.test.ts`）：注入一个 fake fetcher 返回可控 SSE。覆盖事件顺序和 sequence；取消前后；超时；401/429；未同意、未选择 provider、Key 缺失这三种拒绝；伪造 `[E99]`；evidence 中的注入文本不被执行；delta 合并；窗口销毁；日志不含正文。

### 阶段 D：Renderer 面板与选区接通

1. `ReaderPage` 增加问答面板开关（标题栏按钮「AI 问答」），面板作为阅读页右侧的可折叠抽屉。会话状态放在 `ReaderPage`（或独立 hook `usePaperChat(documentId)`）的内存里，切换论文时清空。
2. **接通 `onAddToChat`**：`ReaderPage` 把 handler 传给 `ReaderTextPane`。点击「添加到对话」后：打开面板，把选区加入 pinned 列表（显示前约 120 字、原文/译文标签和页码），可以移除。在问答功能完成之前，**不应该显示一个点了没反应的按钮**；如果分阶段合入，先用开关把按钮隐藏。
3. 回答渲染：复用 `MarkdownPane` 内部的 sanitize + KaTeX 渲染链。建议把 `MarkdownContent` 抽成共享组件 `SafeMarkdown`，不要重复配置 rehype 插件。链接只允许站内引用，外链按现有 `setWindowOpenHandler` 白名单处理。
4. 引用点击：`onSelect({ mappingId: citation.locator.mappingIds[0], origin: 'markdown' })`。现有联动会同时定位 PDF 和文本。如果 citation 的 `contentRevisionId` 与当前文档的不一致（期间重新解析过），显示「来源已更新」，不要跳到猜测的位置。
5. 状态展示：索引中（附进度）、未配置模型（跳转设置）、需要同意（同意弹窗）、生成中（停止按钮）、失败（重试）。
6. 设置页新增「AI 问答」卡片：选择服务商（只列出已验证 Key 的 Qwen/DeepSeek）、填写 model、查看并撤销同意。版式遵守 `AGENTS.md` 第 3 节。
7. 首次提问时的同意弹窗需说明：会发送当前问题、选中文本和论文片段；接收方是哪家服务商；关闭后不会远程删除服务商侧的数据。同意后把 `chatConsentVersion` 写入设置。

测试：`ReaderChatPanel.test.tsx`（加入和移除 pinned、发送、流式追加、停止、引用点击调用 onSelect、切换论文清空）；`ReaderTextPane`/`MarkdownPane` 回调已接通；设置卡片测试。

### 阶段 E（可选，v1 之后）

- 跨语言检索：先让模型把中文问题改写成英文关键词，再做本篇 BM25。
- 写入 `rag_chunk_variants`（译文分块），让中文问题直接匹配译文。
- 聊天历史持久化：按 `rag-implementation/12` 执行，**需要 migration，先和用户确认编号**。
- 多论文问答：按 `rag-implementation/10`，复用本阶段的 ChatProvider、事件契约和引用校验。

## 5. 安全与隐私清单

- [ ] 「Key 已保存」不等于同意；未同意时，网络调用数为 0（用 fake fetcher 计数断言）。
- [ ] Bing/TranSmart 不能作为 chat provider。
- [ ] Renderer 拿不到 Key、base URL 和完整论文正文（evidence 只在 Main 中短暂存在）。
- [ ] 问题、证据、回答都不写日志，不写 SQLite。
- [ ] scope 固定为当前 documentId，Main 和 Utility 两层都要校验。
- [ ] 回答 Markdown 经过 sanitize；不允许原始 HTML 执行，不允许任意协议链接。
- [ ] 取消后不再发出 completed，也不再产生计费请求。

## 6. 性能与并发约束

- `chat:build-context` 走 data 通道，应在 100 ms 量级完成；不要放到 compute 通道排在长任务后面。如果实测超过 200 ms，再考虑缓存本篇 chunk 的 BM25 统计。
- 模型流不经过 Utility。Main 中的 SSE 解析要做背压，并合并 delta。
- 论文问答使用独立限流器，不受后台翻译队列影响。
- 面板关闭时取消进行中的请求；Reader 卸载时清理订阅。

## 7. 验收脚本（人工，使用隔离 userData）

1. 不配置 chat provider，打开问答面板：提示去设置，并能一键跳转。
2. 配置 Qwen 或 DeepSeek 的 chat model 后首次提问：出现同意弹窗；点「取消」后没有任何网络请求。
3. 短论文提问「这篇论文的主要贡献是什么」：流式回答，引用可点击，并跳到正确段落和 PDF 页。
4. 选中原文中的一个公式段落，添加到对话后问「这个公式的含义」：回答围绕该段，引用包含该段。
5. 在译文视图选中一段，添加到对话后提问：可以回答，引用指向对应的原文段落。
6. 问一个论文中没有的问题：回答「没有找到依据」。
7. 生成中点「停止」：立即停止，不再出现新内容。
8. 切换到另一篇论文：会话和 pinned 都被清空。
9. 重新解析当前论文后点击旧引用：提示「来源已更新」。

## 8. 每阶段门禁

```powershell
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:test:coverage
```

需要人工验证 GUI 时：

```powershell
pnpm desktop:build:bundles
pnpm desktop:release:from-built
```

本机 Windows 环境（GameViewer）的 GUI E2E 可能无法启动 sandboxed Renderer，这是已知限制（见 `ARCHITECTURE_ZH.md` 12.2）。不能运行时如实记录，不要为了通过而关闭 sandbox。

## 9. 交付记录模板

每个阶段完成后，在本文末尾追加：

```text
### 阶段 X — YYYY-MM-DD
- 分支/提交：
- 改动文件：
- 新增/修改的契约（IPC、Core RPC、设置项）：
- 自动测试：命令 + 结果（附 coverage 数字）
- 未运行的测试及原因：
- 人工验收：第 7 节中完成的条目
- 遗留问题：
```

## 10. 实施交付记录 — 2026-10-06

### 范围与工作区

- 实施者：Codex；分支：`codex/reader-ai-chat`，从交接 checkout 的 master 建立。
- 开始与交付时均检查了工作区状态；原有阅读器基座及 UI 的未提交修改保留在原处。未提交、未推送，也未合并 demo RAG 分支。
- 阶段 A–D 已实现；阶段 E 的跨语言关键词改写、向量、多论文及聊天持久化均未加入。
- 未增加数据库 migration；临时 SQLite 集成测试确认 schema 仍为 4。测试使用临时文库及隔离 userData，未访问真实文库。

### 阶段 A：契约与设置

- 新增 `desktop/src/shared/paperChatSchemas.ts`，请求限定当前 documentId、问题 2,000 字、最多 8 个选区、最近 6 轮历史及 256 KiB 请求边界；每个选区必须携带内容版本。
- IPC：`paper-chat:ask`、`paper-chat:cancel`、`paper-chat:ensure-index`、`paper-chat:event`；preload 显式暴露 `ask/cancel/ensureIndex/onEvent`，使用既有 sender 校验与 Zod 编解码。
- Core data RPC：`chat:ensure-index`、`chat:build-context`，两端校验 payload/result，并覆盖超时和取消。
- 新设置：`chatProvider` 默认 null，独立的 `qwenChatModel` / `deepseekChatModel`，以及默认 null 的 `chatConsentVersion`。旧设置通过默认值合并兼容，不写 migration。更换服务商自动撤销同意。
- 默认模型分别为可编辑的 `qwen-plus`、`deepseek-flash`；后者名称与当前翻译默认值相同，但聊天字段、选择及请求均独立。名称依据 [Qwen 官方兼容接口文档](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions) 与 [DeepSeek 官方模型接口](https://api-docs.deepseek.com/api/list-models/) 核对；未来服务商可调整可用模型，设置中可更改。
- 兼容修正：基座生成的内容版本实际为 `rag-content-revision-<hash>`，不是 UUID；相关契约统一接受有界、不透明的内容版本标识。citation 增加可选 `evidenceId`；评分来源增加 `selection/full-text`；evidence-ready 数量与分页搜索数量分别限界，最终引用仍最多 50 个。

### 阶段 B：证据构建算法

- 主实现：`desktop/src/utility/core/paperContextBuilder.ts`；老文档幂等补索引复用既有 `rag-content-index` 排队逻辑。
- 短文按原顺序纳入全文；长文依次保留选区及前后邻块、摘要／引言、BM25 正向匹配、大纲及有界顺序补充。BM25 使用 k1=1.2、b=0.75；拉丁词小写分词，中日韩字符按 Unicode 码点生成二元组，评分与同分顺序确定。
- 默认预算 48,000 字，同时限制序列化结果为 256 KiB；只保留完整源 chunk，去重并按原序签发 E1…En。必需选区及邻块放不下时明确失败，不悄悄丢弃。
- 原文选区校验版本、mapping 与可信源 quote，支持跨连续 chunk。为匹配真实阅读器，增加 `paperSelectionText.ts` 从可信 Markdown／HTML／KaTeX 生成可见文本，处理加粗、链接、表格与公式；定位 offset 仍保持原始 UTF-16 来源。
- 译文只作为「用户选中的译文」附带在对应原文证据上，标记 translated，不声称经过译文索引验证。
- 1,000 chunk 的有界构建回归测试通过 <500 ms 门槛；这不是跨机器的性能保证，也未以真实大论文建立基准。

### 阶段 C：Main 编排与串流

- 新增 `desktop/src/main/chat/{chatProvider,paperChatService,paperChatIpc}.ts`。服务商、保存 Key、Key 已验证、用户同意分别设门禁；检索结束、发送前再次核对授权。
- Main 使用 `net.fetch`、固定服务商地址白名单及禁止重定向；每家服务商独立 FIFO 并发 1，不排入翻译限流器。支持 30 秒首字节／60 秒空闲超时、401/403 凭据失效、429 Retry-After 冷却、分片 UTF-8 和 SSE 结束完整性校验。
- 每篇文档只运行一个问答，新问答替换并取消旧问答；关闭面板、卸载、窗口销毁及授权／凭据变更取消请求。Main 总并发另有上限。
- 按既有 RAG 状态机自检并严格递增 sequence；delta 按 50 ms 合并，限长且不拆代理对；最终答案有界。Renderer 缓冲 ask 回复前到达的事件，忽略错误 requestId、重复、乱序及终止后的事件。
- Prompt 将论文、选区和历史当作不可信数据，仅依据当前 evidence 回答，要求证据不足时说明；结束后仅接受本次签发的 E 标记，删除未知标记，再映射可信 citation locator。
- 正文及 Key 不进入日志或 SQLite；日志仅保留标识、服务商／模型、耗时、错误码及 token 数，用量复用现有统计。测试覆盖恶意 evidence 的序列化隔离与未知引用；没有对真实模型的抗注入能力或无幻觉作保证。

### 阶段 D：阅读器接通

- 新增 `usePaperChat.ts`、`ReaderChatPanel.tsx`、`paperChat.css`；接通阅读页标题按钮、抽屉及原有「添加到对话」。选区可移除，会话仅在内存保留，切换论文清空。
- 新增 `SafeMarkdown.tsx`，抽取既有 sanitize／表格公式／KaTeX 链；聊天模式屏蔽图片请求与外部链接，完成后将已验证 E 标记变为引用按钮。
- 引用点击前重新核对当前索引版本；过期则显示「来源已更新」。有效引用切换原文并复用现有 PDF／文本联动。
- 设置页新增 AI 问答卡片，只允许选择已验证凭据的服务商；模型可编辑，可撤销同意。弹窗写明接收方、模型、问题、历史、选区及论文片段，短文可能完整发送，撤销不会远程删除已发送内容。
- 完成 React 检查，原阅读器 blocks／annotations 的稳定引用、订阅清理与取消逻辑保留；未调整全局样式。

### 最终自动门禁

以下命令在 `desktop/` 执行，使用已安装的 CLI。系统 Node 24.11.1 在 electron-vite 构建时原生崩溃，因此最终门禁使用 Codex 已附带的 Node 24.19.0；没有安装新的 Node 或依赖版本。

```powershell
$paperChatNode = 'C:/Users/12479/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $paperChatNode node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
& $paperChatNode node_modules/eslint/bin/eslint.js 'src/**/*.ts' 'src/**/*.tsx' 'tests/**/*.ts' 'tests/**/*.tsx' electron.vite.config.ts utility.vite.config.ts vitest.config.ts playwright.config.ts
& $paperChatNode node_modules/vitest/vitest.mjs run --coverage --maxWorkers=4
& $paperChatNode node_modules/electron-vite/bin/electron-vite.js build
& $paperChatNode node_modules/vite/bin/vite.js build --config utility.vite.config.ts
& $paperChatNode scripts/utility-bundle-smoke.mjs
& $paperChatNode node_modules/@playwright/test/cli.js test e2e/paper-chat.spec.ts --workers=1
```

| 验证 | 实际结果 |
|---|---|
| TypeScript | 通过 |
| ESLint | 0 errors、49 warnings（既有 any 警告） |
| Vitest 全量与 coverage | 85 文件通过；505 项通过、3 项跳过 |
| CI 统计范围 coverage | lines/statements 87.69%，functions 88.13%，branches 79.75% |
| `src/main/chat` coverage | lines/statements/functions 100%，branches 94.35% |
| Main／preload／renderer build | 通过 |
| Utility build／bundle smoke | 通过；DOM 烟测规则未放宽 |
| 原生 Electron 隔离 E2E | 1 项通过，保留 production sandbox；验证未配置模型时打开阅读问答及跳转设置 |

- 新增测试：`paperChatContracts`、`paperChatUtility`、`paperContextBuilder`、`paperSelectionText`、`chatProvider`、`paperChatService`、`ReaderChatPanel`，以及 `e2e/paper-chat.spec.ts`；既有 settings／IPC／RAG 契约测试同步更新。SQLite 集成使用实际临时产物，公式选区投影与实际 SafeMarkdown DOM 对照。
- 构建依赖：Utility 使用 KaTeX 官方支持的服务端 `renderToString`，将既有 KaTeX 调整为 production dependency 并 externalize／asarUnpack，避免把未使用的浏览器 toNode 分支带进 Utility bundle。lockfile 只同步依赖分类，不变版本。
- `pnpm install --offline --frozen-lockfile --ignore-scripts` 已确认 lockfile up to date，但全局 supply-chain 检查缺少缓存的 typescript-eslint 元数据而退出；在线元数据重试也遇到连接失败。故不把重新安装记为通过。以上构建与测试直接使用既有安装完成。

### 验收边界与后续

- 第 7 节条目 1 已由原生隔离 E2E 覆盖；同意／取消、原文和译文选区、流式停止、引用与旧版本、切换论文等由 fake SSE、UI 单元及 SQLite 集成测试覆盖。
- 未使用真实 Qwen／DeepSeek Key 请求；第 7 节条目 2–9 的真人操作与实际模型回答质量尚未验收，尤其公式解释、证据不足拒答及中文问题／英文长论文质量。
- 取消会中止本地传输并阻止后续调用／completed，不能撤回已送达服务商的请求，也不能保证服务商不计费。
- 未生成正式 Setup、未跑安装／卸载验收、未发布；打包配置已更新，安装后 Utility 加载 KaTeX 仍需随正式 release 验证。
- 需要真实服务验收时，继续使用隔离 userData 与测试论文；先在设置页验证 Key、选择问答模型，再依第 7 节执行。阶段 E 保留为后续开发。

### 用户测试 EXE — 2026-10-06

- 按用户要求重新构建四个 bundle，并以缓存的 pnpm 11.19.0 执行 `desktop/package:directory:from-built`，使用 development release 模式；未安装到本机、未发布。
- 构建 ID：`muwif4ri-44068-3cb8a910`；安装入口：`release/setup.exe`（94.29 MiB）；直接运行入口：`release-artifacts/muwif4ri-44068-3cb8a910/program/Copilotix.exe`，必须保持同目录资源完整。
- Setup SHA-256：`53AA65F56B826FB05E1EA647A31BDE1FF834AAF017A1E9170BB4ED247D3106D1`；落盘后再次核对一致。
- release 脚本完整退出 0：ASAR／必要资源、Electron fuses、ZIP 解包、哈希及体积门禁全部通过；packaged smoke 成功启动打包后的 Utility 并在临时 SQLite 中完成 ping。KaTeX runtime 文件确实存在。
- 实际体积：app.asar 29.34 MiB，runtime 358.88 MiB，ZIP 94.38 MiB。正式安装／卸载向导及真实模型回答仍未验收。

## 11. 给 Claude 的交接：共用翻译 API 与面板内模型切换 — 2026-10-06

Claude，用户在首版 EXE 交付后明确调整了交互要求：**默认使用翻译的 API 问答，不再设置另一套问答 API；模型类型在对话栏目中切换。** 我已落实这个变更。请以本节为当前需求，第 4 节 A/D 中独立问答服务商与设置卡片的设计已经被取代。

### 现在的用户流程

1. 用户在既有「服务连接」保存／验证翻译 Key，并在「模型设置」选择翻译服务；无需另配问答 API。
2. 打开论文「AI 问答」，自动沿用当前翻译服务商的 Key 与固定 API 地址。对话面板显示正在共用的服务商。
3. 直接在对话面板的「问答模型」下拉切换；支持预置模型与自定义名称。选择只影响问答请求，翻译模型不变。
4. 首次向当前服务商发送论文片段前仍需确认同意；「撤销同意」移到对话面板，点击立即保存并停止当前请求。
5. 本篇阅读会话保留模型选择，关闭／重新打开面板不重置；切换论文清空会话并回到该服务商的默认问答模型。模型选择不写聊天历史或新增数据库表。

### 路由与兼容约定

- 共享函数 `resolvePaperChatProvider(settings)` 只根据 `translationProvider` 与 `enabledTranslationProviders` 决定问答路由。这里的「当前」指全局翻译设置的主服务商，不是文档曾经翻译时记录的服务商，也不是翻译队列临时 failover 的服务商。
- Qwen／DeepSeek 可用；Bing／TranSmart 无聊天接口，因此显示提示并指向原翻译设置。不会静默切换到另一个收费服务商，也不会把它们当 OpenAI chat endpoint 调用。
- Main 从已有 Vault 读取 `qwen-api-key`／`deepseek-api-key`，复用对应翻译 API 地址及验证状态；Renderer 不新增 Key 或 URL 字段。
- `paper-chat:ask` 请求新增**可选** `model`，使用既有 chatModelSchema 限制字符、长度及名称格式；旧调用方不传时仍使用已有 `qwenChatModel`／`deepseekChatModel` 默认值。请求不允许传 provider／baseUrl／Key。
- 原 `chatProvider` 字段暂时保留在 settings 类型、schema、默认值和 SQLite key/value 数据中，以兼容已经跑过首版的设置；**它已被路由忽略**，不再有编辑入口。以后清理应覆盖旧设置读取，勿为删一个兼容字段新增 migration。
- `qwenChatModel`／`deepseekChatModel` 保留为兼容默认值；真正的本次选择通过 ask.model 传递。在 Qwen 下仍默认使用通用聊天模型 `qwen-plus`，不会把翻译专用 `qwen-mt-plus` 当聊天模型。
- 授权版本由 1 升为 2，旧同意须重新确认，避免旧的独立服务商同意被解释成新翻译服务商授权。保存翻译设置改变主服务商会撤销同意，并取消进行中问答；检索结束后 Main 再核对服务商与授权。

### 本次代码改动

| 位置（仓库根目录相对路径） | 改动 |
|---|---|
| `desktop/src/shared/paperChatSchemas.ts` | 共用路由 helper、模型候选、ask.model、授权版本 2 |
| `desktop/src/shared/types.ts` | 标记 chatProvider 为旧数据兼容字段 |
| `desktop/src/main/chat/paperChatService.ts` | 按翻译设置取 provider／Key／地址，应用每次请求的模型，再检查授权 |
| `desktop/src/main/settingsService.ts`、`desktop/src/main/index.ts` | 翻译服务商变更撤销同意／取消问答 |
| `desktop/src/renderer/usePaperChat.ts` | 按论文保存模型选择，发送有界 model 参数；切文档清空 |
| `desktop/src/renderer/components/ReaderChatPanel.tsx` | 显示共用 API，模型下拉／自定义输入、直接撤销授权；生成或确认授权期间禁止改模型 |
| `desktop/src/renderer/pages/SettingsPage.tsx` | 删除独立 AI 问答设置页签及服务商／模型设置卡片 |
| `desktop/tests/paperChatService.test.ts`、`paperChatContracts.test.ts`、`ReaderChatPanel.test.tsx`、`SettingsPage.test.tsx`、`settingsService.test.ts` | 新路由、旧字段忽略、授权升级／变更、请求模型与面板交互回归 |
| `desktop/e2e/paper-chat.spec.ts` | 隔离 Electron 中验证自动共用、模型切换、重开保留及无独立设置页 |

- 模型候选核对于 2026-10-06：[Qwen 官方模型页](https://www.alibabacloud.com/help/en/model-studio/models)、[DeepSeek 官方 Models 接口](https://api-docs.deepseek.com/api/list-models/)。Qwen 候选为 qwen-plus／qwen3.7-plus／qwen3.8-flash／qwen3.8-max，DeepSeek 为 deepseek-flash／deepseek-v4-pro。DeepSeek 页面本次直接打开超时，名称以官方页面的搜索索引内容核对。
- 这些候选不等于当前账户都已开通；仍可填写账户可用的其他模型，没有做付费调用或实时模型列表拉取。

### 验证记录

使用第 10 节记录的 Codex Node 24.19.0 与现有安装执行；本次未安装／升级依赖。所有正式结果如下：

| 门禁 | 结果 |
|---|---|
| `tsc --noEmit -p tsconfig.json` | 通过 |
| 全量 ESLint | 0 errors，49 个既有 warnings |
| `vitest run --coverage --maxWorkers=4` | 85 文件通过；511 项通过、3 项跳过 |
| coverage（CI 范围） | lines/statements 87.70%，functions 88.15%，branches 79.80% |
| Main chat coverage | lines/statements/functions 100%，branches 94.38% |
| electron-vite build | Main／Preload／Renderer 全部通过 |
| Utility build／bundle smoke | 通过 |
| `playwright test e2e/paper-chat.spec.ts --workers=1` | 1 项通过（6.7 秒），保留 sandbox、临时文库与 userData |

自动测试验证没有另配 API 时按翻译服务可直接进入问答，选择模型不会保存或更改翻译 Key／模型，非法模型名称不能发送，授权变更不会发送旧证据。原生 E2E 使用已有翻译服务测试凭据，不调用真实模型；导览按既有 EdgeDock 的 hover 展开方式操作。

### 希望你接手时注意

- 工作区仍在 `codex/reader-ai-chat`，未提交／未推送。很多新问答文件仍是 untracked，请直接查看实际文件；仅看 git diff 会漏掉它们。原有 UI／基座修改仍保留，不要 reset、clean 或把整个脏目录误认为都是本次改动。
- 如果继续调整视觉设计，请保留单一翻译 API 配置入口、面板内模型选择、直接撤销授权、服务商显示及 Main 的再次校验；不要恢复首版独立 chatProvider 设置。算法侧 BM25、选区校验、UTF-16 locator 和证据字节限额本次没有改动。
- 真人验收仍需确认账户对候选模型的实际权限、中文问题／英文长论文、公式说明及证据不足拒答；模型候选会随服务商更新，未来可再考虑动态取列表，但不应增加另一套 API 配置。
- `desktop/out/` 已重建为新流程；**第 10 节构建 ID `muwif4ri-44068-3cb8a910` 的 Setup／ZIP 仍是本次需求调整之前的版本**。本次用户要求修改并写 Markdown 交接，没有重新打 Setup；后续要测试 EXE 时须重新执行 `desktop:release:from-built`，不能把旧包当新版本。
- 本机默认 pnpm wrapper 是 11.25.0，打包脚本要求 11.19.0；可用已缓存的 `C:/Users/12479/AppData/Local/node/corepack/v1/pnpm/11.19.0/bin/pnpm.mjs`，由 Codex Node 24.19.0 执行，并将该 Node 的 bin 放到 PATH 前面。正式 release 仍沿用签名门禁；不要通过关闭 sandbox 或伪造 npm user-agent 通过检查。
- 不新增 migration、不持久化聊天、不碰真实文库、不合并 demo RAG；阶段 E 仍未纳入本次实现。此前真实服务／安装后验收的限制继续有效。

## 12. 給 Claude：遠端 CI 與測試執行規則（2026-10-06）

使用者要求檢查 GitHub Actions 的頻繁失敗，並改為日常不跑本地自動化測試。最新失敗為 UI 分支 PR #3 的 TasksPage 篩選測試在 Windows 覆蓋率下耗時 16.62 秒，超過 15 秒；程式碼多次對全頁 Ant Design 表格執行 getByRole，存在重複可存取性／樣式計算成本。已將 chip 查找限定於「按狀態篩選」group，任務存在性查找改為具 button selector 的文字查找；CI worker 限為 2，保留原有斷言語義、15 秒上限與覆蓋率門檻。

早期安裝驗收的錯誤還包括 PowerShell 腳本調用、Unicode 捷徑目標讀取失真與 wizard 控件等待競態；這些在現有 master 已修復，2026-10-03 的主分支與 1.0.0 發布 Actions 已成功，不能把歷史紅燈當作仍未修復的當前缺陷。

- 共用 CI 修復已提交為 97cd6b1，PR：https://github.com/Kumiko-kmk/Copilotix/pull/4 。所有分支 push、PR 與手動觸發均可驗證；master/tag 不取消在途驗證，工作分支的同類舊驗證可取消。
- 原先失敗的遠端 ui/homepage-redesign 已追加 74fec74 與 db52f76（合計 5 個 CI／測試規則文件）。第一輪遠端測試發現 Ant Design「清除篩選」按鈕的內層 span 不適合直接 button 文字 selector，已恢復該按鈕的語義查找；最新驗證對應 db52f76。沒有推送本地閱讀器／問答 WIP。
- AGENTS.md 第 1 與第 8 節已改成：日常不預設跑本地 lint、typecheck、單元／coverage／E2E；必須 commit **並 push**，等待最新 SHA 的遠端 build 成功後才合併／交付。PR 還須看最新合併結果檢查。不要跳過、降低門檻或重試掩蓋失敗。
- Unit JUnit 放在 desktop/unit-test-results，避免被 Playwright 清除；Actions 保存 Copilotix-Windows-verification-reports。供真人測試的完整 ZIP 在 Copilotix-Windows-x64-Bundle artifact。
- 本地問答分支已同步 CI 配置、TasksPage 測試與 AGENTS 規則；原有未提交修改繼續保留。遠端 CI 結果僅覆蓋已推送的修復／UI 版本，不能據此宣稱本地未推送的 AI 問答或付費 API 已驗證。

## 12. UI 改版：问答成为阅读器第四个页签 — 2026-10-06（Claude）

### 为什么改

第一版问答是一个 440px 的 `Drawer`，盖在阅读页上面，内部是表单式堆叠，和阅读器的 48px 工具栏、Segmented、`markdown-body` 排版不一致。和用户一起确定了新的交互：

| 决定 | 结果 |
|---|---|
| 位置 | 右侧阅读器第四个页签 `Markdown \| Markdown（中文）\| JSON \| AI 问答`，尺寸与 Markdown 阅读器完全相同；PDF 保持在左侧 |
| 引用点击 | 问答页签保持可见，左侧 PDF 滚动并高亮；切回 Markdown 页签时也停在该段落 |
| 添加到对话 | 只加入选区标签，不切换页签；页签显示选区数量徽章，并弹出短提示 |
| 对话样式 | 文档式：问题是左侧带竖线的小标题，回答用阅读器同款 `markdown-body` 排版 |

后端契约、共用翻译 API 的路由、授权版本和 Main 校验都没有改，第 11 节的约定继续有效。

### 交互细则

- 页签内容区：上方是对话滚动区，与 Markdown 栏同宽、同边距；下方是固定的输入区。输入区从上到下依次为：错误提示、内联授权卡片、选区标签行、输入框。输入框底栏左侧是「服务商 · 模型」选择，右侧是发送/停止圆形按钮。
- 模型选择最初放在页签工具栏，但在 1100px 窗口宽度下会溢出，所以改放到输入框底栏。工具栏只保留「⋯」菜单（清空对话、撤销发送授权）。生成中或授权确认期间，模型选择不可改。
- 空状态垂直居中，分三种：未配置（给出「前往设置」）、索引中（显示进度，失败时给出「重试索引」）、就绪（一句说明加 3 个建议问题，点击即填入输入框）。
- 授权由 Modal 改为内联卡片，按钮为「同意并发送 / 取消」，文案沿用原有内容。
- 引用显示为按出现顺序编号的小圆角标号（1、2、…，`aria-label` 为「引用 n」）。悬停时 Popover 显示「第 n 页」和摘录（最多约 200 字）。点击前仍会核对内容版本，通过后用 `origin: 'citation'` 选中，`PdfPane` 负责滚动定位。
- 键盘：Enter 发送；Shift+Enter 换行；输入法组字中按 Enter 不发送；页签内按 `/` 聚焦输入框；Esc 停止生成。
- 离开问答页签不会中断生成，页签上显示一个生成中小圆点。问答面板切走后保持挂载，滚动位置和草稿都保留；草稿存放在 `usePaperChat` 中，切换论文时清空。Markdown 和 JSON 页签依旧只挂载当前页。
- 标题栏的「AI 问答」按钮和 Drawer 已删除。在问答页签下，「复制当前内容」复制整段对话的 Markdown，另存菜单只保留 ZIP。

### 改动文件

`renderer/components/ReaderChatPanel.tsx`（重写：工具栏菜单、模型选择、空状态、对话、输入区）、`paperChat.css`（全部改用现有 token）、`SafeMarkdown.tsx`（引用编号与预览）、`ReaderTextPane.tsx`（第四页签、徽章、常驻挂载）、`pages/ReaderPage.tsx`、`usePaperChat.ts`（`draft`、`clear`；`addSelection` 返回失败原因）、`PdfPane.tsx` 和 `shared/types.ts`（`citation` 来源）。测试：`ReaderChatPanel`（13 项）、`ReaderTextPane`、`PdfPane`、`e2e/paper-chat.spec.ts`。

### 验证

| 门禁 | 结果 |
|---|---|
| tsc | 通过 |
| ESLint | 0 errors，49 个既有 warnings |
| vitest 全量与 coverage | 85 个文件通过，514 项通过、3 项跳过；lines 87.7%、branches 79.8% |
| electron-vite 与 Utility build、bundle smoke | 通过（Node 24.19.0） |
| `e2e/paper-chat.spec.ts`（原生 Electron，保留 sandbox） | 通过 |
| 视觉检查 | 1440×900 与 1100×700 下截图核对空状态、模型菜单、⋯ 菜单，以及注入样例 DOM 后的对话、授权卡片、选区标签布局 |

注意事项：

- 系统 Node 24.11.1 运行 electron-vite build 时会在 SSR 阶段静默崩溃，并留下**旧的** `out/`。构建请使用第 10 节记录的 Node 24.19.0，并确认输出中出现 4 个「built in」。
- 一次全量 coverage 运行中，`TasksPage` 的一个用例因耗时接近 waitFor 超时而失败一次；单独连跑 3 次以及再次全量运行均通过。该测试文件有他人未提交的修改，本次没有改动。
- 测试 fixture 的论文没有建立内容索引，所以原生 E2E 只覆盖到「索引准备中」状态。授权卡片和真实回答在单元测试中覆盖，视觉上用注入样例核对。真实模型回答仍需真人验收。

### 後續排查：打包鎖與窗口裁切

- 共用規則 PR #4 已於完整 push／PR 門禁成功後合入 master（c96de9e）。其遠端結果為 80 文件、434 項通過／3 項既有跳過，18 項 Electron E2E 通過；兩次真實打包、安裝升級／卸載／重裝與下載驗收皆成功。
- 主分支復測 37469610693 又捕獲真正的打包瞬態問題：staging artifacts 的原子 rename 被 Windows EPERM 阻擋，package CLI 返回 0，E2E 才因缺少 release-manifest.json 失敗。補充修復 PR #5：https://github.com/Kumiko-kmk/Copilotix/pull/5 。只對 Windows EPERM/EACCES/EBUSY 做至多 6.3 秒的 rename 重試；來源／目的地不變、不使用 copy/delete 替代、不吞永久錯誤，既有發布／回滾路徑驗證仍保留。CLI 致命錯誤明確 exit 1；CI 在 E2E 前要求發布清單、Setup、uninstaller、ZIP 均存在。
- UI 原超時篩選測試已在兩次遠端運行通過（2.431／2.528 秒），全量 81 文件、441 項通過／3 項跳過。其後縮略圖 E2E 暴露窗口圆角裁切的色差：實際下載對比圖，35,105 像素只有右下角 6 像素不同（0.0171%，最大 channel delta 4），canvas bytes、headings、formulas 與 repaint count 完全相同。整數裁切單獨不能消除此差異；最新修復在截圖期間固定外層 app-shell 為直角，並保留完整 CSS 像素截取與 displayBounds 精確比較。沒有提高原有 channel delta 1／changedRatio 0.001 閾值；失敗另保存 expected／actual PNG。
- PR #5 最新提交 d75fda7；UI 分支最新提交 4f310c6 已同步打包鎖、錯誤退出、發布前置校驗與截圖修復，等待這兩個最新版本的完整遠端驗證。PR #3 的產品 UI 不自動合併，閱讀器／問答 WIP 也未推送。
- 新增測試涵蓋臨時鎖恢復、永久鎖的有界失敗、非暫態／非 Windows 錯誤不重試，以及 CLI 真實子進程失敗退出碼。此輪僅用遠端 Actions 執行自動化驗證，本地沒有跑 lint/typecheck/單元/coverage/E2E。
- 主分支 metadata 可確認 protected=true 且必需 build；完整管理員保護／bypass 設定受 GitHub App administration 權限限制，未將未讀取的規則宣稱為已核實。
